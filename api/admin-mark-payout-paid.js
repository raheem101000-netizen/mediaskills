const db = require('./_db');

const ADMIN_KEY = 'TENTEN2025';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const userId = parseInt(req.body && req.body.user_id, 10);
  if (!userId) return res.status(400).json({ error: 'Missing user_id' });
  try {
    const r = await db().query('UPDATE users SET balance = 0 WHERE id = $1 RETURNING id', [userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
