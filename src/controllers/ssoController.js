const jwt = require('jsonwebtoken');
const { Issuer, generators } = require('openid-client');
const logger = require('../config/logger');
const { generateToken, JWT_SECRET } = require('../middleware/auth');
const { buildSessionUser } = require('./authController');

// Microsoft Entra ID (OpenID Connect) sign-in. The browser is sent to Microsoft
// from /auth/sso/start and comes back to /auth/sso/callback.
const TENANT_ID = process.env.SSO_TENANT_ID;
const CLIENT_ID = process.env.SSO_CLIENT_ID;
const CLIENT_SECRET = process.env.SSO_CLIENT_SECRET;
const BACKEND_URL = (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}/api`).replace(/\/+$/, '');
const REDIRECT_URI = process.env.SSO_REDIRECT_URI || `${BACKEND_URL}/auth/sso/callback`;
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

const STATE_COOKIE = 'hrobit_sso';
const STATE_TTL_MS = 10 * 60 * 1000;
const stateCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: REDIRECT_URI.startsWith('https://'),
  path: '/api/auth/sso',
};

let clientPromise = null;
function getClient() {
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    return Promise.reject(new Error('SSO_TENANT_ID, SSO_CLIENT_ID and SSO_CLIENT_SECRET must be set'));
  }
  if (!clientPromise) {
    clientPromise = Issuer.discover(`https://login.microsoftonline.com/${TENANT_ID}/v2.0`)
      .then((issuer) => new issuer.Client({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uris: [REDIRECT_URI],
        response_types: ['code'],
      }))
      .catch((err) => { clientPromise = null; throw err; });
  }
  return clientPromise;
}

const failTo = (res, reason) => res.redirect(`${FRONTEND_URL}/login?error=${reason}`);

exports.start = async (req, res) => {
  try {
    const client = await getClient();
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();

    const signedState = jwt.sign({ state, nonce, codeVerifier }, JWT_SECRET, { expiresIn: STATE_TTL_MS / 1000 });
    res.cookie(STATE_COOKIE, signedState, { ...stateCookieOptions, maxAge: STATE_TTL_MS });

    return res.redirect(client.authorizationUrl({
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: generators.codeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }));
  } catch (err) {
    logger.error('SSO start failed: ' + err.message);
    return failTo(res, 'sso_failed');
  }
};

exports.callback = async (req, res) => {
  const stored = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, stateCookieOptions);
  try {
    if (!stored) throw new Error('missing state cookie');
    const { state, nonce, codeVerifier } = jwt.verify(stored, JWT_SECRET);

    const client = await getClient();
    const params = client.callbackParams(req);
    if (params.error) throw new Error(`${params.error}: ${params.error_description || ''}`);

    // Checks state, nonce, signature, issuer, audience and expiry.
    const tokenSet = await client.callback(REDIRECT_URI, params, { state, nonce, code_verifier: codeVerifier });
    const claims = tokenSet.claims();
    if (claims.tid !== TENANT_ID) throw new Error(`token from unexpected tenant ${claims.tid}`);

    const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
    if (!email.includes('@')) {
      logger.warn('SSO token has no usable email claim');
      return failTo(res, 'not_authorized');
    }

    const user = await buildSessionUser(email, claims);
    const token = generateToken(user);
    logger.info(`SSO sign-in for ${email}`);
    // The fragment never reaches a server, so the token stays out of access logs.
    return res.redirect(`${FRONTEND_URL}/auth/callback#token=${encodeURIComponent(token)}`);
  } catch (err) {
    logger.warn('SSO callback failed: ' + err.message);
    return failTo(res, 'sso_failed');
  }
};
