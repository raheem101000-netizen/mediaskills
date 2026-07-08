const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cookie = require('cookie');
const db = require('./_db');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  const pool = db();
  try {
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid email or password' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const sid = uuidv4();
    await pool.query('INSERT INTO sessions (id, user_id) VALUES ($1,$2)', [sid, user.id]);
    res.setHeader('Set-Cookie', cookie.serialize('session', sid, {
      httpOnly: true, path: '/', maxAge: 30 * 24 * 60 * 60, sameSite: 'lax', secure: true
    }));
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
