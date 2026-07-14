const cookie = require('cookie');
const { v4: uuidv4 } = require('uuid');
const db = require('./_db');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  try {
    const r = await db().query(
      `SELECT u.id, u.display_name
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id=$1 AND s.expires_at > NOW()`,
      [sid]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Session expired' });
    const user = r.rows[0];
    const token = uuidv4();
    await db().query('INSERT INTO game_tokens (token, user_id) VALUES ($1,$2)', [token, user.id]);
    res.status(200).json({ token, player_id: user.id, display_name: user.display_name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
