const cookie = require('cookie');
const sql = require('./_db');

// "Get notified when rooms open": browser push subscriptions, served as
// GET/POST /api/push-subscribe (vercel.json routes it to
// auth-misc?action=push-subscribe — Vercel's Hobby plan allows 12 functions
// and this repo is at 12, so it rides on an existing one, like /api/creator).
//
//   GET   → { publicKey }  the VAPID public key the browser subscribes with
//                           (VAPID_PUBLIC_KEY; the private key is only on the
//                           game servers that send)
//   POST  { endpoint, keys: { p256dh, auth } }  → saved (upsert on endpoint),
//         tied to the logged-in account when there is one, else anonymous.
//
// The game servers (1v1 Arena now; Pong and Kurver later) read this table and
// send the "new room open" pushes; they delete subscriptions that are gone.
const MIGRATION_LOCK = 727274;   // the same lock as the other shared-table migrations
let tableReady = null;

function ensureTable() {
  if (!tableReady) {
    tableReady = sql.transaction([
      sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`,
      sql`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id          SERIAL PRIMARY KEY,
          endpoint    TEXT NOT NULL UNIQUE,
          p256dh      TEXT NOT NULL,
          auth        TEXT NOT NULL,
          user_id     INTEGER,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
    ]).catch(e => { tableReady = null; throw e; });
  }
  return tableReady;
}

const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max) ? v : null;

module.exports = async function pushSubscribe(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const endpoint = str(body.endpoint, 2000);
  const p256dh = str(body.keys && body.keys.p256dh, 300);
  const auth = str(body.keys && body.keys.auth, 100);
  if (!endpoint || !/^https:\/\//.test(endpoint) || !p256dh || !auth) {
    return res.status(400).json({ error: 'Not a push subscription' });
  }

  // The logged-in account, if any (same session check as /api/me); anonymous otherwise.
  let userId = null;
  const sid = cookie.parse(req.headers.cookie || '').session;
  if (sid) {
    const rows = await sql`SELECT user_id FROM auth_sessions WHERE id = ${sid} AND expires_at > NOW()`;
    if (rows.length) userId = rows[0].user_id;
  }

  await ensureTable();
  await sql`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id)
    VALUES (${endpoint}, ${p256dh}, ${auth}, ${userId})
    ON CONFLICT (endpoint) DO UPDATE
      SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
          user_id = COALESCE(EXCLUDED.user_id, push_subscriptions.user_id)
  `;
  res.status(200).json({ ok: true });
};
