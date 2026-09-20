const sql = require('./_db');

const CYCLE_LENGTH = 20;
const PAYOUTS = { pong: 5.00 };

// Mirrors the client's buildCycleOrder(): fixed 1D order, identical for every player,
// no shuffle.
// Two 10-match blocks that alternate forever: Block A (matches 1-10) = 5 Easy/5 Super,
// Block B (matches 11-20) = 4 Easy/6 Super. 9 Easy / 11 Super per 20-match cycle.
const BLOCK_A = ['EASY', 'EASY', 'SUPER', 'EASY', 'SUPER', 'EASY', 'SUPER', 'SUPER', 'EASY', 'SUPER'];
const BLOCK_B = ['EASY', 'SUPER', 'EASY', 'SUPER', 'SUPER', 'EASY', 'SUPER', 'EASY', 'SUPER', 'SUPER'];
function buildCycleOrder() {
  return [...BLOCK_A, ...BLOCK_B];
}

// tier is a pure function of match_number (the cycle order never shuffles), so
// match_results never needs to trust or persist a client-claimed tier — this recomputes
// the exact same value matchConfig originally assigned this match.
function tierForMatchNumber(matchNumber) {
  return buildCycleOrder()[(matchNumber - 1) % CYCLE_LENGTH];
}

// Unconditional audit write for every match END, win or loss, independent of whether
// crediting succeeded — this is what makes a win never unverifiable again. Deliberately
// swallows its own errors so a logging failure can never break the real response path.
async function logMatchResult({ playerId, game, paymentIntent, outcome, matchNumber, credited }) {
  try {
    const tier = tierForMatchNumber(matchNumber);
    await sql`
      INSERT INTO match_results (player_id, game, stripe_payment_id, outcome, tier, match_number, credited)
      VALUES (${playerId}, ${game}, ${paymentIntent || null}, ${outcome}, ${tier}, ${matchNumber}, ${credited})
      ON CONFLICT (stripe_payment_id) DO NOTHING
    `;
  } catch (err) {
    console.error('[match_results] insert failed', err, { playerId, game, matchNumber, outcome });
  }
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
  const { token, game, payment_intent: paymentIntent } = req.body || {};
  const playerId = parseInt(req.body && req.body.player_id, 10);
  const matchNumber = parseInt(req.body && req.body.match_number, 10);
  const payout = PAYOUTS[game];
  if (!playerId || !token || !payout || !matchNumber || !paymentIntent) {
    return res.status(400).json({ error: 'Missing or invalid params' });
  }

  const tokRows = await sql`SELECT 1 FROM game_tokens WHERE token=${token} AND user_id=${playerId}`;
  if (!tokRows.length) return res.status(401).json({ error: 'Invalid token' });

  try {
    // Don't trust the client's payment_intent blindly — it must match a real,
    // webhook-confirmed payment for this exact player before it can ever credit anything.
    const paidRows = await sql`
      SELECT 1 FROM sessions WHERE stripe_payment_id = ${paymentIntent} AND user_id = ${playerId} AND game = 'Pong' AND mode = 'solo'
    `;
    if (!paidRows.length) {
      // Logged so a genuine winner who hits this (e.g. webhook delivery lagging the
      // match) can be found and credited manually instead of failing silently.
      console.error('[record-win] 403 no matching payment', { playerId, game, matchNumber, paymentIntent });
      await logMatchResult({ playerId, game, paymentIntent, outcome: 'win', matchNumber, credited: false });
      return res.status(403).json({ error: 'No matching payment found for this player' });
    }

    // Dedup on the payment itself, not match_number: match_number is a cycle-position
    // counter that repeats after a cycle reset, but a payment_intent is unique per match.
    const claim = await sql`
      INSERT INTO game_wins (player_id, game, match_number, stripe_payment_id)
      VALUES (${playerId}, ${game}, ${matchNumber}, ${paymentIntent})
      ON CONFLICT (stripe_payment_id) DO NOTHING RETURNING *
    `;
    if (!claim.length) {
      console.error('[record-win] credited:0 already claimed', { playerId, game, matchNumber, paymentIntent });
      await logMatchResult({ playerId, game, paymentIntent, outcome: 'win', matchNumber, credited: false });
      return res.status(200).json({ ok: true, credited: 0, note: 'already credited' });
    }

    const rows = await sql`UPDATE users SET balance = balance + ${payout} WHERE id=${playerId} RETURNING balance`;
    await logMatchResult({ playerId, game, paymentIntent, outcome: 'win', matchNumber, credited: true });
    res.status(200).json({ ok: true, credited: payout, balance: parseFloat(rows[0].balance).toFixed(2) });
  } catch (err) {
    // Something failed AFTER the payment was already verified real (e.g. the
    // match_number-collision bug hitting game_wins_pkey). The win is genuine and the
    // payment is real — log it so it's never just a bare 500 with no trace, even though
    // it couldn't be auto-credited this time.
    console.error('[record-win] unexpected error after payment verified', err, { playerId, game, matchNumber, paymentIntent });
    await logMatchResult({ playerId, game, paymentIntent, outcome: 'win', matchNumber, credited: false });
    res.status(500).json({ error: 'Server error' });
  }
}

async function recordLoss(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { token, game, payment_intent: paymentIntent } = req.body || {};
  const playerId = parseInt(req.body && req.body.player_id, 10);
  const matchNumber = parseInt(req.body && req.body.match_number, 10);
  if (!playerId || !token || game !== 'pong' || !matchNumber) {
    return res.status(400).json({ error: 'Missing or invalid params' });
  }

  const tokRows = await sql`SELECT 1 FROM game_tokens WHERE token=${token} AND user_id=${playerId}`;
  if (!tokRows.length) return res.status(401).json({ error: 'Invalid token' });

  // No money moves here — payment_intent is best-effort for audit completeness, not
  // required. A loss is never worth losing the audit row over a missing payment_intent.
  await logMatchResult({ playerId, game, paymentIntent, outcome: 'loss', matchNumber, credited: false });
  res.status(200).json({ ok: true });
}

const ACTIONS = { 'match-config': matchConfig, 'record-win': recordWin, 'record-loss': recordLoss };

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
