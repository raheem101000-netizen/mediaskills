const cookie = require('cookie');
const sql = require('./_db');

// Host creates a new FIFA 1v1 match. No payment/reporting yet (that's steps
// 7.3/7.4) — this just creates the row and logs a system message.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  try {
    const s = await sql`
      SELECT u.id, u.display_name FROM auth_sessions a
      JOIN users u ON u.id = a.user_id
      WHERE a.id=${sid} AND a.expires_at > NOW()
    `;
    if (!s.length) return res.status(401).json({ error: 'Session expired' });
    const host = s[0];

    const rows = await sql`
      INSERT INTO fifa_matches (host_user_id, status) VALUES (${host.id}, 'awaiting_opponent')
      RETURNING id
    `;
    const matchId = rows[0].id;
    await sql`
      INSERT INTO fifa_messages (match_id, user_id, text, is_system)
      VALUES (${matchId}, NULL, ${host.display_name + ' created the match.'}, true)
    `;
    res.status(200).json({ id: matchId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
