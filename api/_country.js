const sql = require('./_db');

// Country-level location for the admin page — the visitor's country as Vercel
// already reports it on every request (x-vercel-ip-country, a 2-letter ISO
// code like NO / SE / GB). Country only: no IP is read or stored, and no
// geolocation service is called.
//
//   users.signup_country     — set once, when the account is created
//   users.last_seen_country  — updated at signup and on every login
//
// Saving is always best-effort: a missing header or a failed write never
// blocks signup or login.
const MIGRATION_LOCK = 727274;   // the same lock as the other shared-table migrations
let columnsReady = null;

function countryFrom(req) {
  const raw = req && req.headers && req.headers['x-vercel-ip-country'];
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' ? code : null;   // XX = unknown
}

// The two columns, added once (behind the shared lock). Checked first, so the
// ALTER — which locks users — only ever runs while a column is missing.
function ensureCountryColumns() {
  if (!columnsReady) {
    columnsReady = (async () => {
      const have = await sql`
        SELECT COUNT(*)::int AS n FROM information_schema.columns
         WHERE table_name = 'users' AND column_name IN ('signup_country', 'last_seen_country')
      `;
      if (have[0].n === 2) return;
      await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_country VARCHAR(2)`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_country VARCHAR(2)`,
      ]);
    })().catch(e => { columnsReady = null; throw e; });
  }
  return columnsReady;
}

// signup: true → also the signup country. Never throws.
async function recordCountry(req, userId, { signup = false } = {}) {
  const country = countryFrom(req);
  if (!country || !userId) return;
  try {
    await ensureCountryColumns();
    if (signup) {
      await sql`UPDATE users SET signup_country = ${country}, last_seen_country = ${country} WHERE id = ${userId}`;
    } else {
      await sql`UPDATE users SET last_seen_country = ${country} WHERE id = ${userId}`;
    }
  } catch (e) {
    console.error('[country] could not save country for user', userId, e.message);
  }
}

module.exports = { countryFrom, ensureCountryColumns, recordCountry };
