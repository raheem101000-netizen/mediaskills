const db = require('./_db');

const PAYOUTS = { pong: 5.00 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://all-solo-ggames.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();
  const { token, game } = req.body || {};
  const playerId = parseInt(req.body && req.body.player_id, 10);
  const matchNumber = parseInt(req.body && req.body.match_number, 10);
  const payout = PAYOUTS[game];
  if (!playerId || !token || !payout || !matchNumber) return res.status(400).json({ error: 'Missing or invalid params' });
  try {
    const tokRes = await db().query('SELECT 1 FROM game_tokens WHERE token=$1 AND user_id=$2', [token, playerId]);
    if (!tokRes.rows.length) return res.status(401).json({ error: 'Invalid token' });

    // Dedup on (player, game, match_number): only the first credit claim for a given match
    // pays out, so replaying this request (e.g. from devtools) can't farm balance indefinitely.
    const claim = await db().query(
      'INSERT INTO game_wins (player_id, game, match_number) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *',
      [playerId, game, matchNumber]
    );
    if (!claim.rows.length) return res.status(200).json({ ok: true, credited: 0, note: 'already credited' });

    const r = await db().query('UPDATE users SET balance = balance + $1 WHERE id=$2 RETURNING balance', [payout, playerId]);
    res.status(200).json({ ok: true, credited: payout, balance: parseFloat(r.rows[0].balance).toFixed(2) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
