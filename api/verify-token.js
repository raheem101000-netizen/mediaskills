const db = require('./_db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://all-solo-ggames.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const r = await db().query(
      `UPDATE game_tokens SET used=TRUE
       WHERE token=$1 AND used=FALSE AND expires_at > NOW()
       RETURNING user_id`,
      [token]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid or expired token' });
    const u = await db().query('SELECT display_name FROM users WHERE id=$1', [r.rows[0].user_id]);
    if (!u.rows.length) return res.status(401).json({ error: 'Invalid token' });
    res.status(200).json({ player_id: r.rows[0].user_id, display_name: u.rows[0].display_name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
