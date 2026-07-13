const cookie = require('cookie');
const db = require('./_db');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  const { paypal_email } = req.body || {};
  if (!paypal_email) return res.status(400).json({ error: 'Missing paypal_email' });
  try {
    const s = await db().query(
      'SELECT user_id FROM auth_sessions WHERE id=$1 AND expires_at > NOW()', [sid]
    );
    if (!s.rows.length) return res.status(401).json({ error: 'Session expired' });
    await db().query('UPDATE users SET paypal_email=$1 WHERE id=$2', [paypal_email, s.rows[0].user_id]);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
