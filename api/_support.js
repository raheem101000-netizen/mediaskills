const cookie = require('cookie');
const sql = require('./_db');

// "Contact support" from the profile page, served as POST /api/support
// (vercel.json routes it to auth-misc?action=support — Vercel's Hobby plan
// allows 12 functions and this repo is at 12, like /api/creator and
// /api/push-subscribe). The admin page lists and marks them read through
// api/admin (list-support, mark-support-read), which reuses ensureTable below.
//
//   POST { message, email? } → saved, tied to the logged-in account when there
//        is one. The reply address is the account's email; `email` (typed by
//        the player) is only used when the account has none / not logged in.
const MIGRATION_LOCK = 727274;   // the same lock as the other shared-table migrations
const MESSAGE_MAX = 2000;
const EMAIL_MAX = 254;
const RECENT_LIMIT = 5;          // at most 5 messages per sender per 10 minutes
let tableReady = null;

function ensureTable() {
  if (!tableReady) {
    tableReady = sql.transaction([
      sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`,
      sql`
        CREATE TABLE IF NOT EXISTS support_messages (
          id          SERIAL PRIMARY KEY,
          user_id     INTEGER,
          email       TEXT,
          message     TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read')),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
      sql`CREATE INDEX IF NOT EXISTS support_messages_created_idx ON support_messages (created_at DESC)`,
    ]).catch(e => { tableReady = null; throw e; });
  }
  return tableReady;
}

const looksLikeEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

async function supportMessage(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'Write a message first' });
  if (message.length > MESSAGE_MAX) return res.status(400).json({ error: `Keep it under ${MESSAGE_MAX} characters` });

  // The logged-in account, if any (same session check as /api/me).
  let userId = null, accountEmail = null;
  const sid = cookie.parse(req.headers.cookie || '').session;
  if (sid) {
    const rows = await sql`
      SELECT u.id, u.email FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ${sid} AND s.expires_at > NOW()
    `;
    if (rows.length) { userId = rows[0].id; accountEmail = rows[0].email || null; }
  }
  let email = accountEmail;
  if (!email) {
    const typed = typeof body.email === 'string' ? body.email.trim() : '';
    if (!typed || typed.length > EMAIL_MAX || !looksLikeEmail(typed)) {
      return res.status(400).json({ error: 'Enter an email so we can reply' });
    }
    email = typed;
  }

  await ensureTable();
  const recent = userId
    ? await sql`SELECT COUNT(*)::int AS n FROM support_messages WHERE user_id = ${userId} AND created_at > now() - interval '10 minutes'`
    : await sql`SELECT COUNT(*)::int AS n FROM support_messages WHERE lower(email) = lower(${email}) AND created_at > now() - interval '10 minutes'`;
  if (recent[0].n >= RECENT_LIMIT) {
    return res.status(429).json({ error: 'You’ve sent a few messages already — we’ll get back to you soon' });
  }

  await sql`INSERT INTO support_messages (user_id, email, message) VALUES (${userId}, ${email}, ${message})`;
  res.status(200).json({ ok: true });
}

supportMessage.ensureTable = ensureTable;
module.exports = supportMessage;
