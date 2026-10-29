const logger = require('../config/logger');

// Microsoft Teams presence through Microsoft Graph (app-only auth).
// Needs an Azure AD app registration with the application permissions
// Presence.Read.All and User.Read.All, granted admin consent.
const TENANT_ID = process.env.MS_GRAPH_TENANT_ID;
const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET;
const GRAPH = 'https://graph.microsoft.com/v1.0';

const USER_ID_TTL_MS = 24 * 60 * 60 * 1000;
const PRESENCE_TTL_MS = 30 * 1000;

let cachedToken = null; // { value, expiresAt }
const userIdCache = new Map(); // email -> { id | null, expiresAt }
const presenceCache = new Map(); // email -> { value, expiresAt }

const isConfigured = () => Boolean(TENANT_ID && CLIENT_ID && CLIENT_SECRET);

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || `Token request failed (${response.status})`);
  cachedToken = { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function graph(path, token, options = {}) {
  const response = await fetch(`${GRAPH}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 404) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `Graph request failed (${response.status})`);
  return payload;
}

// Emails that aren't Teams users resolve to null and are cached so they aren't retried.
// Runs fn over items with at most `limit` requests in flight (Graph throttles bursts).
async function inBatches(items, limit, fn) {
  for (let index = 0; index < items.length; index += limit) {
    await Promise.all(items.slice(index, index + limit).map(fn));
  }
}

// Directory emails sometimes carry a "+tag" alias (karthik.m+1@…) that isn't the Teams sign-in.
const teamsAccountEmail = (email) => email.replace(/\+[^@]*@/, '@');

async function resolveUserIds(emails, token) {
  const now = Date.now();
  const missing = emails.filter((email) => !(userIdCache.get(email)?.expiresAt > now));
  await inBatches(missing, 10, async (email) => {
    let user = await graph(`/users/${encodeURIComponent(email)}?$select=id`, token);
    const plain = teamsAccountEmail(email);
    if (!user && plain !== email) user = await graph(`/users/${encodeURIComponent(plain)}?$select=id`, token);
    userIdCache.set(email, { id: user?.id || null, expiresAt: now + USER_ID_TTL_MS });
  });
  return new Map(emails.map((email) => [email, userIdCache.get(email)?.id || null]));
}

const BUSY_LABELS = {
  InACall: 'In a call',
  InAConferenceCall: 'In a call',
  InAMeeting: 'In a meeting',
  Presenting: 'Presenting',
  DoNotDisturb: 'Do not disturb',
  UrgentInterruptionsOnly: 'Do not disturb',
};
const AWAY_LABELS = { Away: 'Away', BeRightBack: 'Be right back', Offline: 'Offline', OffWork: 'Off work' };

// online = green, busy (calls, meetings, do not disturb) = red, offline/away = light brown.
function toStatus({ availability, activity } = {}) {
  if (availability === 'Available' || availability === 'AvailableIdle') return { status: 'online', label: 'Available' };
  if (availability === 'Busy' || availability === 'BusyIdle' || availability === 'DoNotDisturb') {
    return { status: 'busy', label: BUSY_LABELS[activity] || BUSY_LABELS[availability] || 'Busy' };
  }
  return { status: 'offline', label: AWAY_LABELS[activity] || AWAY_LABELS[availability] || 'Offline' };
}

// Fallback when Teams isn't available: HR Orbit activity. Every signed-in browser sends a
// heartbeat each minute, so someone seen within ACTIVE_WINDOW_MS has the app open.
// In-memory, so it resets on restart and assumes a single backend instance.
const ACTIVE_WINDOW_MS = 150 * 1000;
const lastSeen = new Map(); // email -> timestamp

const viewerEmail = (user) => String(user?.email || user?.official_email || '').trim().toLowerCase();

exports.heartbeat = (req, res) => {
  const email = viewerEmail(req.user);
  if (email) lastSeen.set(email, Date.now());
  return res.json({ success: true });
};

function appActivityStatus(email, now) {
  return now - (lastSeen.get(email) || 0) < ACTIVE_WINDOW_MS
    ? { status: 'online', label: 'Active now', source: 'app' }
    : { status: 'offline', label: 'Offline', source: 'app' };
}

async function teamsPresence(emails, now) {
  const data = {};
  const stale = [];
  for (const email of emails) {
    const cached = presenceCache.get(email);
    if (cached && cached.expiresAt > now) data[email] = cached.value;
    else stale.push(email);
  }

  if (stale.length) {
    try {
      const token = await getToken();
      const idsByEmail = await resolveUserIds(stale, token);
      const ids = [...new Set([...idsByEmail.values()].filter(Boolean))];
      // getPresencesByUserId accepts up to 650 ids per call.
      const presences = [];
      for (let index = 0; index < ids.length; index += 600) {
        const page = await graph('/communications/getPresencesByUserId', token, { method: 'POST', body: JSON.stringify({ ids: ids.slice(index, index + 600) }) });
        presences.push(...(page?.value || []));
      }
      const byId = new Map(presences.map((presence) => [presence.id, presence]));
      for (const email of stale) {
        const id = idsByEmail.get(email);
        if (!id || !byId.has(id)) continue; // not a Teams user: falls back to app activity
        const value = { ...toStatus(byId.get(id)), source: 'teams' };
        presenceCache.set(email, { value, expiresAt: now + PRESENCE_TTL_MS });
        data[email] = value;
      }
    } catch (err) {
      // Presence is a nice-to-have; never fail the page because Teams is unreachable.
      logger.warn(`Teams presence unavailable: ${err.message}`);
    }
  }

  return data;
}

// Teams status when configured; anyone without one falls back to HR Orbit activity.
const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

exports.getPresence = async (req, res) => {
  // Malformed directory emails get no status rather than failing the lookup.
  const emails = [...new Set(req.body.emails.map((email) => email.toLowerCase()).filter((email) => EMAIL_PATTERN.test(email)))];
  const now = Date.now();
  const self = viewerEmail(req.user);
  if (self) lastSeen.set(self, now); // looking at the page counts as being active

  const teams = isConfigured() ? await teamsPresence(emails, now) : {};
  const data = Object.fromEntries(emails.map((email) => [email, teams[email] || appActivityStatus(email, now)]));
  return res.json({ success: true, teamsConfigured: isConfigured(), data });
};

exports.toStatus = toStatus;
exports.teamsAccountEmail = teamsAccountEmail;
