const db = require('./_db');

const ADMIN_KEY = 'TENTEN2025';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await db().query(
      `SELECT id, display_name, email, balance, paypal_email, created_at
       FROM users ORDER BY balance DESC`
    );
    res.status(200).json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
