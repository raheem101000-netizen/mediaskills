const cookie = require('cookie');
const sql = require('./_db');

// Returns full match state for a participant (host or opponent only).
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  const matchId = parseInt(req.query.id, 10);
  if (!matchId) return res.status(400).json({ error: 'Missing id' });
  try {
    const s = await sql`
      SELECT u.id FROM auth_sessions a
      JOIN users u ON u.id = a.user_id
      WHERE a.id=${sid} AND a.expires_at > NOW()
    `;
    if (!s.length) return res.status(401).json({ error: 'Session expired' });
    const userId = s[0].id;

    const rows = await sql`
      SELECT m.*, h.display_name AS host_name, o.display_name AS opponent_name
      FROM fifa_matches m
      JOIN users h ON h.id = m.host_user_id
      LEFT JOIN users o ON o.id = m.opponent_user_id
      WHERE m.id=${matchId}
    `;
    if (!rows.length) return res.status(404).json({ error: 'Match not found' });
    const match = rows[0];

    if (match.host_user_id !== userId && match.opponent_user_id !== userId) {
      return res.status(403).json({ error: 'Not a participant in this match' });
    }

    res.status(200).json({ ...match, my_user_id: userId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
