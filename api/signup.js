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
    const cookies = cookie.parse(req.headers.cookie || '');
    // Creator referral captured on tenten.run (?ref=CODE, ref.js): sent by the page, or the cookie.
    const refCode = normalizeRefCode(ref) || normalizeRefCode(cookies.tenten_ref);
    if (!display_name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const hash = await bcrypt.hash(password, 10);
    const inserted = await sql`
      INSERT INTO users (email, password_hash, display_name, avatar_url)
      VALUES (${email.toLowerCase().trim()}, ${hash}, ${display_name.trim()}, ${avatar_url || null})
      RETURNING id
    `;
    const userId = inserted[0].id;
    // Attribution happens here, once, at signup: only an active creator's code,
    // never the creator's own account, never over an existing attribution.
    // A failure here (bad code, migration not run yet) never blocks the signup.
    if (refCode) {
      try {
        await sql`
          UPDATE users u
             SET referred_by_creator_id = c.id, referred_at = now()
            FROM creators c
           WHERE u.id = ${userId}
             AND u.referred_by_creator_id IS NULL
             AND c.referral_code = ${refCode}
             AND c.active
             AND c.user_id <> u.id
        `;
      } catch (e) {
        console.error('[referral] could not attribute user', userId, 'to code', refCode, e.message);
      }
    }
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
