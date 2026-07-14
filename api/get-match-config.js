const db = require('./_db');

const CYCLE_LENGTH = 10;

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

// Mirrors the client's buildCycleOrder(): 2 Easy, 3 Medium, 4 Hard, 1 Super per 10-slot
// cycle. Game 1 always Easy; liability (Easy/Medium) and safe (Hard/Super) slots alternate.
function buildCycleOrder(seed) {
  const rand = mulberry32(seed);
  const liability = ['MEDIUM', 'MEDIUM', 'MEDIUM', 'EASY'];
  const safe = ['HARD', 'HARD', 'HARD', 'HARD', 'SUPER'];
  for (let i = liability.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [liability[i], liability[j]] = [liability[j], liability[i]]; }
  for (let i = safe.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [safe[i], safe[j]] = [safe[j], safe[i]]; }
  const seq = ['EASY'];
  let li = 0, si = 0;
  for (let pos = 2; pos <= CYCLE_LENGTH; pos++) {
    if (pos % 2 === 0) seq.push(safe[si++]);
    else seq.push(liability[li++]);
  }
  return seq;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://all-solo-ggames.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();
  const { token, game } = req.query;
  const playerId = parseInt(req.query.player_id, 10);
  if (!playerId || !token || !game) return res.status(400).json({ error: 'Missing params' });
  try {
    // The Step-1 handoff token is one-time/60s, but a play session runs far longer than
    // that, so here it's only checked as proof this player_id was legitimately issued a
    // token — not re-validated for expiry/one-time use like verify-token does.
    const tokRes = await db().query('SELECT 1 FROM game_tokens WHERE token=$1 AND user_id=$2', [token, playerId]);
    if (!tokRes.rows.length) return res.status(401).json({ error: 'Invalid token' });

    await db().query(
      `INSERT INTO player_game_state (player_id, game, match_position)
       VALUES ($1,$2,0) ON CONFLICT (player_id, game) DO NOTHING`,
      [playerId, game]
    );
    const stateRes = await db().query(
      'SELECT match_position FROM player_game_state WHERE player_id=$1 AND game=$2',
      [playerId, game]
    );
    const position = stateRes.rows[0].match_position;
    const cycleNumber = Math.floor(position / CYCLE_LENGTH);
    const slot = position % CYCLE_LENGTH;
    const seed = hashSeed(`${playerId}:${game}:${cycleNumber}`);
    const tier = buildCycleOrder(seed)[slot];

    await db().query(
      'UPDATE player_game_state SET match_position=$1, updated_at=NOW() WHERE player_id=$2 AND game=$3',
      [position + 1, playerId, game]
    );
    res.status(200).json({ match_number: position + 1, tier });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
