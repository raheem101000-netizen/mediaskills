const cookie = require('cookie');
const sql = require('./_db');

// Polling endpoint: returns messages with id > after, ascending.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  const matchId = parseInt(req.query.matchId, 10);
  const after = parseInt(req.query.after, 10) || 0;
  if (!matchId) return res.status(400).json({ error: 'Missing matchId' });
  try {
    const s = await sql`
      SELECT u.id FROM auth_sessions a
      JOIN users u ON u.id = a.user_id
      WHERE a.id=${sid} AND a.expires_at > NOW()
    `;
    if (!s.length) return res.status(401).json({ error: 'Session expired' });
    const userId = s[0].id;

    const matchRows = await sql`SELECT host_user_id, opponent_user_id FROM fifa_matches WHERE id=${matchId}`;
    if (!matchRows.length) return res.status(404).json({ error: 'Match not found' });
    const match = matchRows[0];
    if (match.host_user_id !== userId && match.opponent_user_id !== userId) {
      return res.status(403).json({ error: 'Not a participant in this match' });
    }

    const rows = await sql`
      SELECT m.id, m.match_id, m.user_id, m.text, m.image_url, m.is_system, m.created_at,
             u.display_name
      FROM fifa_messages m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.match_id=${matchId} AND m.id > ${after}
      ORDER BY m.id ASC
    `;
    res.status(200).json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
