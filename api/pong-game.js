const sql = require('./_db');

const CYCLE_LENGTH = 10;
const PAYOUTS = { pong: 5.00 };

// Mirrors the client's buildCycleOrder(): fixed 1C order, identical for every player,
// no shuffle.
function buildCycleOrder() {
  return ['EASY', 'SUPER', 'MEDIUM', 'SUPER', 'SUPER', 'EASY', 'SUPER', 'MEDIUM', 'SUPER', 'SUPER'];
}

async function matchConfig(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { token, game } = req.query;
  const playerId = parseInt(req.query.player_id, 10);
  if (!playerId || !token || !game) return res.status(400).json({ error: 'Missing params' });

  // The Step-1 handoff token is one-time/60s, but a play session runs far longer than
  // that, so here it's only checked as proof this player_id was legitimately issued a
  // token — not re-validated for expiry/one-time use like token.js's verify action does.
  const tokRows = await sql`SELECT 1 FROM game_tokens WHERE token=${token} AND user_id=${playerId}`;
  if (!tokRows.length) return res.status(401).json({ error: 'Invalid token' });

  await sql`
    INSERT INTO player_game_state (player_id, game, match_position)
    VALUES (${playerId}, ${game}, 0)
    ON CONFLICT (player_id, game) DO NOTHING
  `;
  const stateRows = await sql`
    SELECT match_position FROM player_game_state WHERE player_id=${playerId} AND game=${game}
  `;
  const position = stateRows[0].match_position;
  const slot = position % CYCLE_LENGTH;
  const tier = buildCycleOrder()[slot];

  await sql`
    UPDATE player_game_state SET match_position=${position + 1}, updated_at=NOW()
    WHERE player_id=${playerId} AND game=${game}
  `;
  res.status(200).json({ match_number: position + 1, tier });
}

async function recordWin(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { token, game } = req.body || {};
  const playerId = parseInt(req.body && req.body.player_id, 10);
  const matchNumber = parseInt(req.body && req.body.match_number, 10);
  const payout = PAYOUTS[game];
  if (!playerId || !token || !payout || !matchNumber) return res.status(400).json({ error: 'Missing or invalid params' });

  const tokRows = await sql`SELECT 1 FROM game_tokens WHERE token=${token} AND user_id=${playerId}`;
  if (!tokRows.length) return res.status(401).json({ error: 'Invalid token' });

  // Dedup on (player, game, match_number): only the first credit claim for a given match
  // pays out, so replaying this request (e.g. from devtools) can't farm balance indefinitely.
  const claim = await sql`
    INSERT INTO game_wins (player_id, game, match_number) VALUES (${playerId}, ${game}, ${matchNumber})
    ON CONFLICT DO NOTHING RETURNING *
  `;
  if (!claim.length) return res.status(200).json({ ok: true, credited: 0, note: 'already credited' });

  const rows = await sql`UPDATE users SET balance = balance + ${payout} WHERE id=${playerId} RETURNING balance`;
  res.status(200).json({ ok: true, credited: payout, balance: parseFloat(rows[0].balance).toFixed(2) });
}

const ACTIONS = { 'match-config': matchConfig, 'record-win': recordWin };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://all-solo-ggames.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
