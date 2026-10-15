const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const cookie = require('cookie');
const sql = require('./_db');
const { normalizeRefCode } = require('./_referral');
const { recordCountry } = require('./_country');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { display_name, email, password, avatar_url, ref } = req.body || {};
    if (!display_name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    // A creator's referral code is required (the signup form's field, pre-filled
    // from a ?ref= link). Case-insensitive; only an ACTIVE creator's code counts.
    if (typeof ref !== 'string' || !ref.trim()) {
      return res.status(400).json({ error: 'Enter a referral code' });
    }
    const refCode = normalizeRefCode(ref);
    if (!refCode) return res.status(400).json({ error: 'That referral code doesn’t exist.' });
    const hash = await bcrypt.hash(password, 10);
    // The creator is set here, once, in the same statement that creates the
    // account — so no account exists without one, and nothing changes it later.
    // No row back = the code isn't an active creator's.
    const inserted = await sql`
      INSERT INTO users (email, password_hash, display_name, avatar_url, referred_by_creator_id, referred_at)
      SELECT ${email.toLowerCase().trim()}, ${hash}, ${display_name.trim()}, ${avatar_url || null}, c.id, now()
        FROM creators c
       WHERE c.referral_code = ${refCode} AND c.active
      RETURNING id
    `;
    if (!inserted.length) return res.status(400).json({ error: 'That referral code doesn’t exist.' });
    const userId = inserted[0].id;
    // Country from Vercel's header (signup + last seen); best-effort, never blocks.
    await recordCountry(req, userId, { signup: true });
    const sid = randomUUID();
    await sql`INSERT INTO auth_sessions (id, user_id) VALUES (${sid}, ${userId})`;
    res.setHeader('Set-Cookie', [
      cookie.serialize('session', sid, {
        httpOnly: true, path: '/', maxAge: 30 * 24 * 60 * 60, sameSite: 'lax', secure: true
      }),
      // The captured ref has done its job (attribution is set only at signup).
      cookie.serialize('tenten_ref', '', { path: '/', maxAge: 0, sameSite: 'lax', secure: true })
    ]);
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    console.error('SIGNUP ERROR:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
