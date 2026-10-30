const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const logger = require('../config/logger');
const { generateToken } = require('../middleware/auth');
const { buildSessionUser } = require('./authController');

// Email + password sign-in. Employee credentials are checked by the company
// HROrbit portal; accounts it does not know (e.g. HR admins set up with
// `npm run set-password`) fall back to hcm.user_credentials.
const HRORBIT_BASE_URL = (process.env.HRORBIT_BASE_URL || 'https://hrorbit.simplify3x.com').replace(/\/+$/, '');
const HRORBIT_TIMEOUT_MS = 10 * 1000;
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'simplify3x.com').trim().toLowerCase();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedAttempts = new Map();

// Compared against when the email has no local password, so unknown and known
// accounts take the same time to reject.
const DUMMY_HASH = bcrypt.hashSync('hrobit-no-such-account', 10);

function isLockedOut(key) {
  const entry = failedAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > LOCKOUT_MS) {
    failedAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(key) {
  const entry = failedAttempts.get(key);
  if (!entry || Date.now() - entry.first > LOCKOUT_MS) failedAttempts.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
}

// Returns true when the HROrbit portal accepts the credentials, false when it
// rejects them, and null when it cannot be reached.
async function verifyWithHrOrbit(email, password) {
  try {
    const response = await fetch(`${HRORBIT_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password }),
      signal: AbortSignal.timeout(HRORBIT_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => ({}));
    const remoteUser = data.data?.user || data.data?.employee || data.user || data.employee;
    if (response.ok && data.success && remoteUser) return true;
    logger.warn(`HROrbit rejected sign-in for ${email}: ${data.message || `HTTP ${response.status}`}`);
    return false;
  } catch (err) {
    logger.error(`HROrbit sign-in check failed for ${email}: ${err.message}`);
    return null;
  }
}

// Accounts registered in the HROrbit dev environment live in its Keycloak realm.
// Returns true/false like verifyWithHrOrbit, and false when Keycloak is not configured.
const KEYCLOAK_BASE_URL = (process.env.KEYCLOAK_BASE_URL || '').replace(/\/+$/, '');
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM;
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID;
const KEYCLOAK_CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET;

async function verifyWithKeycloak(email, password) {
  if (!KEYCLOAK_BASE_URL || !KEYCLOAK_REALM || !KEYCLOAK_CLIENT_ID) return false;
  try {
    const body = new URLSearchParams({ grant_type: 'password', client_id: KEYCLOAK_CLIENT_ID, username: email, password, scope: 'openid' });
    if (KEYCLOAK_CLIENT_SECRET) body.set('client_secret', KEYCLOAK_CLIENT_SECRET);
    const response = await fetch(`${KEYCLOAK_BASE_URL}/realms/${encodeURIComponent(KEYCLOAK_REALM)}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(HRORBIT_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.access_token) return true;
    logger.warn(`Keycloak rejected sign-in for ${email}: ${data.error_description || data.error || `HTTP ${response.status}`}`);
    return false;
  } catch (err) {
    logger.error(`Keycloak sign-in check failed for ${email}: ${err.message}`);
    return null;
  }
}

async function verifyLocalPassword(email, password) {
  // Employees registered in HROrbit dev get their password in hcm.employees.
  const result = await query(
    `SELECT password_hash FROM hcm.user_credentials WHERE email = $1
     UNION ALL
     SELECT password_hash FROM hcm.employees
      WHERE lower(official_email) = $1 AND password_hash IS NOT NULL AND is_active AND NOT is_deleted
     LIMIT 1`,
    [email]
  );
  const hash = result.rows[0]?.password_hash;
  const valid = await bcrypt.compare(password, hash || DUMMY_HASH);
  return Boolean(hash) && valid;
}

exports.passwordLogin = async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Enter your company email and password.' });
  }
  if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
    return res.status(403).json({ success: false, message: `Use your @${ALLOWED_EMAIL_DOMAIN} company email.` });
  }

  const attemptKey = `${req.ip}|${email}`;
  if (isLockedOut(attemptKey)) {
    return res.status(429).json({ success: false, message: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  try {
    const keycloakResult = await verifyWithKeycloak(email, password);
    const hrOrbitResult = keycloakResult === true ? true : await verifyWithHrOrbit(email, password);
    const valid = hrOrbitResult === true || await verifyLocalPassword(email, password);
    if (!valid) {
      if (hrOrbitResult === null) {
        return res.status(503).json({ success: false, message: 'Sign-in is unavailable right now. Please try again.' });
      }
      recordFailure(attemptKey);
      logger.warn(`Password sign-in rejected for ${email}`);
      return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
    }

    failedAttempts.delete(attemptKey);
    const user = await buildSessionUser(email);
    logger.info(`Password sign-in for ${email} (${keycloakResult === true ? 'Keycloak' : hrOrbitResult === true ? 'HROrbit' : 'local'})`);
    return res.json({ success: true, token: generateToken(user), user });
  } catch (err) {
    logger.error(`Password sign-in failed for ${email}: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Sign-in is unavailable right now. Please try again.' });
  }
};
