const cookie = require('cookie');
const { v4: uuidv4 } = require('uuid');
const sql = require('./_db');

async function generate(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  const rows = await sql`
    SELECT u.id, u.display_name
    FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id=${sid} AND s.expires_at > NOW()
  `;
  if (!rows.length) return res.status(401).json({ error: 'Session expired' });
  const user = rows[0];
  const token = uuidv4();
  await sql`INSERT INTO game_tokens (token, user_id) VALUES (${token}, ${user.id})`;
  res.status(200).json({ token, player_id: user.id, display_name: user.display_name });
}

async function verify(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const rows = await sql`
    UPDATE game_tokens SET used=TRUE
    WHERE token=${token} AND used=FALSE AND expires_at > NOW()
    RETURNING user_id
  `;
  if (!rows.length) return res.status(401).json({ error: 'Invalid or expired token' });
  const u = await sql`SELECT display_name FROM users WHERE id=${rows[0].user_id}`;
  if (!u.length) return res.status(401).json({ error: 'Invalid token' });
  res.status(200).json({ player_id: rows[0].user_id, display_name: u[0].display_name });
}

const ACTIONS = { generate, verify };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://all-solo-ggames.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const fn = ACTIONS[req.query.action];
  if (!fn) return res.status(400).json({ error: 'Unknown action' });
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
