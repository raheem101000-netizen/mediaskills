const cookie = require('cookie');
const sql = require('./_db');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  const { paypal_email } = req.body || {};
  if (!paypal_email) return res.status(400).json({ error: 'Missing paypal_email' });
  try {
    const s = await sql`SELECT user_id FROM auth_sessions WHERE id=${sid} AND expires_at > NOW()`;
    if (!s.length) return res.status(401).json({ error: 'Session expired' });
    await sql`UPDATE users SET paypal_email=${paypal_email} WHERE id=${s[0].user_id}`;
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
