const cookie = require('cookie');
const sql = require('./_db');

// Accepts JSON body: { avatar_url: "data:image/...;base64,..." }
// Stores base64 data URL directly in users.avatar_url
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  const { avatar_url } = req.body || {};
  if (!avatar_url) return res.status(400).json({ error: 'Missing avatar_url' });
  if (avatar_url.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image too large (max 2MB)' });
  }
  try {
    const s = await sql`SELECT user_id FROM auth_sessions WHERE id=${sid} AND expires_at > NOW()`;
    if (!s.length) return res.status(401).json({ error: 'Session expired' });
    await sql`UPDATE users SET avatar_url=${avatar_url} WHERE id=${s[0].user_id}`;
    res.status(200).json({ ok: true, avatar_url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
