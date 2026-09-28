const cookie = require('cookie');
const sql = require('./_db');

const MAX_LEN = 500;

// Text-only chat message. Image upload is added in a later step.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  const matchId = parseInt(req.body && req.body.match_id, 10);
  const text = (req.body && req.body.text || '').trim().slice(0, MAX_LEN);
  if (!matchId) return res.status(400).json({ error: 'Missing match_id' });
  if (!text) return res.status(400).json({ error: 'Empty message' });
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
      INSERT INTO fifa_messages (match_id, user_id, text, is_system)
      VALUES (${matchId}, ${userId}, ${text}, false)
      RETURNING id, match_id, user_id, text, image_url, is_system, created_at
    `;
    res.status(200).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
