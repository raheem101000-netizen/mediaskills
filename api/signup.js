const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const cookie = require('cookie');
const db = require('./_db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { display_name, email, password, avatar_url } = req.body || {};
    if (!display_name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const pool = db();
    const hash = await bcrypt.hash(password, 10);
    const u = await pool.query(
      'INSERT INTO users (email, password_hash, display_name, avatar_url) VALUES ($1,$2,$3,$4) RETURNING id',
      [email.toLowerCase().trim(), hash, display_name.trim(), avatar_url || null]
    );
    const sid = randomUUID();
    await pool.query('INSERT INTO sessions (id, user_id) VALUES ($1,$2)', [sid, u.rows[0].id]);
    res.setHeader('Set-Cookie', cookie.serialize('session', sid, {
      httpOnly: true, path: '/', maxAge: 30 * 24 * 60 * 60, sameSite: 'lax', secure: true
    }));
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    console.error('SIGNUP ERROR:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
