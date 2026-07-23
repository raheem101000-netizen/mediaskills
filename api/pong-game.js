const sql = require('./_db');

const CYCLE_LENGTH = 10;
const PAYOUTS = { pong: 5.00 };

// Deterministic seeded RNG (mulberry32) so the same player+cycle always gets the same
// shuffle — the client only randomizes once per cycle, not per match, so the server has
// to reproduce that same one-shuffle-per-cycle behavior without persisting the shuffle.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

// Mirrors the client's buildCycleOrder(): 1C composition — 2 Easy, 2 Medium, 6 Super Hard
// per 10-slot cycle (no Hard tier). Game 1 always Easy; the remaining 9 slots
// (1 Easy, 2 Medium, 6 Super) are shuffled as a single Fisher-Yates pass.
function buildCycleOrder(seed) {
  const rand = mulberry32(seed);
  const rest = ['EASY', 'MEDIUM', 'MEDIUM', 'SUPER', 'SUPER', 'SUPER', 'SUPER', 'SUPER', 'SUPER'];
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return ['EASY', ...rest];
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
  const cycleNumber = Math.floor(position / CYCLE_LENGTH);
  const slot = position % CYCLE_LENGTH;
  const seed = hashSeed(`${playerId}:${game}:${cycleNumber}`);
  const tier = buildCycleOrder(seed)[slot];

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
