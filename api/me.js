const cookie = require('cookie');
const sql = require('./_db');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  try {
    const rows = await sql`
      SELECT u.id, u.email, u.display_name, u.avatar_url, u.balance, u.paypal_email
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id=${sid} AND s.expires_at > NOW()
    `;
    if (!rows.length) return res.status(401).json({ error: 'Session expired' });
    const u = rows[0];
    res.status(200).json({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      balance: Math.max(0, parseFloat(u.balance || 0)).toFixed(2),
      paypal_email: u.paypal_email
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
