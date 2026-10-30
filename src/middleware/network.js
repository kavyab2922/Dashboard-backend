const https = require('https');
const net = require('net');
const os = require('os');
const logger = require('../config/logger');

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

// ALLOWED_IP_RANGES: comma-separated IPs or CIDRs for the office Wi-Fi and VPN,
// e.g. "103.117.236.205,10.8.0.0/16".
function buildAllowList(value) {
  const list = new net.BlockList();
  let count = 0;
  for (const entry of String(value || '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const [address, prefix] = entry.split('/');
    const type = net.isIPv6(address) ? 'ipv6' : net.isIPv4(address) ? 'ipv4' : null;
    if (!type) {
      logger.warn(`Ignoring invalid ALLOWED_IP_RANGES entry: ${entry}`);
      continue;
    }
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
    count += 1;
  }
  return { list, count };
}

const { list: allowList, count: allowCount } = buildAllowList(process.env.ALLOWED_IP_RANGES);

function normalizeIp(ip) {
  const value = String(ip || '');
  // Express reports IPv4 clients on a dual-stack socket as ::ffff:a.b.c.d.
  return value.startsWith('::ffff:') && net.isIPv4(value.slice(7)) ? value.slice(7) : value;
}

function isAllowedIp(ip) {
  const address = normalizeIp(ip);
  if (net.isIPv4(address)) return allowList.check(address, 'ipv4');
  if (net.isIPv6(address)) return allowList.check(address, 'ipv6');
  return false;
}

// Browser navigations (SSO) are redirected back to the login page; API calls
// (password sign-in) get a JSON error instead.
function blockSignIn(req, res) {
  if (req.method === 'GET') return res.redirect(`${FRONTEND_URL}/login?error=network`);
  return res.status(403).json({ success: false, message: 'Available only on the company network.' });
}

// Loopback and LAN addresses say nothing about which network the user is on.
const privateRanges = new net.BlockList();
privateRanges.addSubnet('127.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4');
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4');
privateRanges.addAddress('::1', 'ipv6');
privateRanges.addSubnet('fc00::', 7, 'ipv6');

function isPrivateOrLoopback(ip) {
  const address = normalizeIp(ip);
  if (net.isIPv4(address)) return privateRanges.check(address, 'ipv4');
  if (net.isIPv6(address)) return privateRanges.check(address, 'ipv6');
  return false;
}

// When the browser reaches the backend over loopback/LAN (backend on the same
// machine or network), the machine's public egress IP identifies the network.
// Cached briefly, and dropped as soon as the local IPs change (network switch).
const PUBLIC_IP_TTL_MS = 60 * 1000;
let publicIpCache = { ip: null, at: 0, localKey: '' };

// Uses a fresh socket every time (agent: false). fetch() reuses keep-alive
// connections, which kept reporting the previous network's IP after a switch.
function lookupPublicIp() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.ipify.org', { agent: false, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`public IP lookup returned ${res.statusCode}`));
        resolve(body.trim());
      });
    });
    req.on('timeout', () => req.destroy(new Error('public IP lookup timed out')));
    req.on('error', reject);
  });
}

async function getPublicIp(localIps) {
  const localKey = [...localIps].sort().join(',');
  if (
    publicIpCache.ip &&
    publicIpCache.localKey === localKey &&
    Date.now() - publicIpCache.at < PUBLIC_IP_TTL_MS
  ) {
    return publicIpCache.ip;
  }
  const ip = await lookupPublicIp();
  if (!net.isIP(ip)) throw new Error(`public IP lookup returned "${ip}"`);
  publicIpCache = { ip, at: Date.now(), localKey };
  return ip;
}

// Sign-in is only allowed from the office Wi-Fi or VPN. Without a configured
// list everyone is blocked.
async function requireAllowedNetwork(req, res, next) {
  if (allowCount === 0) {
    logger.error('ALLOWED_IP_RANGES is empty; blocking sign-in.');
    return blockSignIn(req, res);
  }

  let ip = normalizeIp(req.ip);
  if (isPrivateOrLoopback(ip)) {
    // A connected VPN shows up as a local adapter holding a VPN-pool address,
    // even on split tunnel where the public IP is still the home/hotspot one.
    const localIps = localInterfaceIps();
    if (localIps.some(isAllowedIp)) return next();
    try {
      ip = await getPublicIp(localIps);
    } catch (err) {
      logger.warn(`Sign-in blocked: could not determine the public IP (${err.message})`);
      return blockSignIn(req, res);
    }
    if (isAllowedIp(ip)) return next();
    logger.warn(`Sign-in blocked from outside the office network or VPN: public ${ip}, local ${localIps.join(', ') || 'none'}`);
    return blockSignIn(req, res);
  }

  if (isAllowedIp(ip)) return next();
  logger.warn(`Sign-in blocked from outside the office network or VPN: ${ip}`);
  return blockSignIn(req, res);
}

function localInterfaceIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && !iface.internal)
    .map((iface) => iface.address);
}

module.exports = { requireAllowedNetwork, isAllowedIp };
