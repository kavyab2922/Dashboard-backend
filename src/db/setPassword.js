// Sets or resets a local sign-in password for an account the HROrbit portal
// does not know (e.g. an HR admin). Employees sign in with their HROrbit password.
// Usage: npm run set-password -- name@simplify3x.com "NewPassword123"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const initDb = require('./initDb');
const { pool, query } = require('../config/db');

const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'simplify3x.com').trim().toLowerCase();
const MIN_PASSWORD_LENGTH = 8;

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  const password = String(process.argv[3] || '');

  if (!email || !password) throw new Error('Usage: npm run set-password -- name@simplify3x.com "NewPassword123"');
  if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) throw new Error(`Email must end with @${ALLOWED_EMAIL_DOMAIN}`);
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);

  await initDb();
  const hash = await bcrypt.hash(password, 12);
  await query(
    `INSERT INTO hcm.user_credentials (email, password_hash, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = CURRENT_TIMESTAMP`,
    [email, hash]
  );
  console.log(`Password set for ${email}`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err.message);
    await pool.end();
    process.exit(1);
  });
