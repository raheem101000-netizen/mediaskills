const cookie = require('cookie');
const db = require('./_db');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (sid) {
    try { await db().query('DELETE FROM sessions WHERE id=$1', [sid]); } catch (_) {}
  }
  res.setHeader('Set-Cookie', cookie.serialize('session', '', {
    httpOnly: true, path: '/', maxAge: 0, sameSite: 'lax', secure: true
  }));
  res.status(200).json({ ok: true });
};
