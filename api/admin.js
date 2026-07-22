const sql = require('./_db');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const ADMIN_KEY = 'TENTEN2025';
const PONG_CYCLE_LENGTH = 10;
const PONG_WIN_PAYOUT = 5.00;

async function listUsers(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const rows = await sql`
    SELECT u.id, u.display_name, u.email, u.balance, u.paypal_email, u.created_at,
           COUNT(s.id) AS purchases, COALESCE(SUM(s.amount), 0) AS total_spent
    FROM users u
    LEFT JOIN sessions s ON s.user_id = u.id
    GROUP BY u.id
    ORDER BY u.balance DESC
  `;
  res.status(200).json(rows.map(r => ({
    id: r.id, display_name: r.display_name, email: r.email, balance: r.balance,
    paypal_email: r.paypal_email, created_at: r.created_at,
    purchases: parseInt(r.purchases, 10), total_spent: parseFloat(r.total_spent)
  })));
}

async function salesStats(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const totals = await sql`SELECT COUNT(*) AS total_sales, COALESCE(SUM(amount),0) AS total_revenue FROM sessions`;
  const byGame = await sql`SELECT game, mode, COUNT(*) AS sales, SUM(amount) AS revenue FROM sessions GROUP BY game, mode ORDER BY revenue DESC`;
  res.status(200).json({
    total_sales: parseInt(totals[0].total_sales, 10),
    total_revenue: parseFloat(totals[0].total_revenue),
    breakdown: byGame.map(r => ({
      game: r.game,
      mode: r.mode,
      sales: parseInt(r.sales, 10),
      revenue: parseFloat(r.revenue)
    }))
  });
}

async function listSessions(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { game, mode } = req.query;
  let rows;
  if (game && mode) {
    rows = await sql`
      SELECT id, game, mode, amount, stripe_payment_id, user_id, created_at
      FROM sessions WHERE game = ${game} AND mode = ${mode} ORDER BY created_at ASC
    `;
  } else {
    rows = await sql`
      SELECT id, game, mode, amount, stripe_payment_id, user_id, created_at
      FROM sessions ORDER BY created_at ASC
    `;
  }
  res.status(200).json(rows.map(r => ({
    id: r.id, game: r.game, mode: r.mode,
    amount: parseFloat(r.amount), stripe_payment_id: r.stripe_payment_id, user_id: r.user_id, created_at: r.created_at
  })));
}

async function inspectCheckoutSession(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { pi } = req.query;
  if (!pi) return res.status(400).json({ error: 'Missing pi (payment_intent id)' });
  const list = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
  const session = list.data[0];
  if (!session) return res.status(404).json({ error: 'No checkout session found for that payment_intent' });
  res.status(200).json({
    id: session.id,
    payment_intent: session.payment_intent,
    amount_total: session.amount_total,
    metadata: session.metadata,
    created: new Date(session.created * 1000).toISOString(),
  });
}

async function inspectPayment(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { pi } = req.query;
  if (!pi) return res.status(400).json({ error: 'Missing pi (payment_intent id)' });
  const intent = await stripe.paymentIntents.retrieve(pi, { expand: ['latest_charge'] });
  res.status(200).json({
    id: intent.id,
    amount: intent.amount,
    amount_received: intent.amount_received,
    currency: intent.currency,
    description: intent.description,
    metadata: intent.metadata,
    created: new Date(intent.created * 1000).toISOString(),
    latest_charge_description: intent.latest_charge && intent.latest_charge.description,
    latest_charge_amount: intent.latest_charge && intent.latest_charge.amount,
  });
}

async function deleteSessions(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const idsParam = req.body && req.body.ids;
  if (!Array.isArray(idsParam) || !idsParam.length) return res.status(400).json({ error: 'Missing ids array' });
  const ids = idsParam.map(n => parseInt(n, 10));
  if (ids.some(n => !Number.isInteger(n))) return res.status(400).json({ error: 'ids must be integers' });
  // Deletes ONLY the exact row ids passed in — no criteria-based matching,
  // so this can't accidentally sweep up unrelated or future legitimate rows.
  const rows = await sql`DELETE FROM sessions WHERE id = ANY(${ids}) RETURNING id, game, mode, amount, stripe_payment_id`;
  res.status(200).json({ deleted_count: rows.length, deleted: rows });
}

async function listGameTokens(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const userId = parseInt(req.query.user_id, 10);
  if (!userId) return res.status(400).json({ error: 'Missing user_id' });
  const rows = await sql`
    SELECT token, user_id, created_at, expires_at, used
    FROM game_tokens WHERE user_id = ${userId} ORDER BY created_at DESC
  `;
  res.status(200).json(rows);
}

async function resetPongCycle(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const before = await sql`SELECT player_id, match_position FROM player_game_state WHERE game = 'pong' ORDER BY player_id`;
  const updated = await sql`UPDATE player_game_state SET match_position = 0 WHERE game = 'pong' RETURNING player_id, match_position`;
  const after = await sql`SELECT player_id, match_position FROM player_game_state WHERE game = 'pong' ORDER BY player_id`;
  res.status(200).json({
    rows_before: before,
    rows_affected: updated.length,
    rows_after: after,
  });
}

async function deleteUsers(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const idsParam = req.body && req.body.ids;
  if (!Array.isArray(idsParam) || !idsParam.length) return res.status(400).json({ error: 'Missing ids array' });
  const ids = idsParam.map(n => parseInt(n, 10));
  if (ids.some(n => !Number.isInteger(n))) return res.status(400).json({ error: 'ids must be integers' });
  // Clear FK-dependent rows for the SAME exact id list first (still no criteria-based
  // matching — every statement here is scoped to the ids the caller passed in).
  await sql`DELETE FROM game_tokens WHERE user_id = ANY(${ids})`;
  await sql`DELETE FROM auth_sessions WHERE user_id = ANY(${ids})`;
  await sql`DELETE FROM player_game_state WHERE player_id = ANY(${ids})`;
  await sql`DELETE FROM game_wins WHERE player_id = ANY(${ids})`;
  const rows = await sql`DELETE FROM users WHERE id = ANY(${ids}) RETURNING id, display_name, email`;
  res.status(200).json({ deleted_count: rows.length, deleted: rows });
}

async function addUserIdColumn(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)`;
  res.status(200).json({ ok: true });
}

const KNOWN_TABLES = ['users', 'sessions', 'game_tokens', 'player_game_state', 'game_wins', 'auth_sessions'];
async function tableSchema(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { table } = req.query;
  if (!KNOWN_TABLES.includes(table)) return res.status(400).json({ error: 'Unknown table' });
  const cols = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = ${table}
    ORDER BY ordinal_position
  `;
  res.status(200).json(cols);
}

async function payoutRequests(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const rows = await sql`
    SELECT id, display_name, email, balance, paypal_email, created_at
    FROM users WHERE paypal_email IS NOT NULL AND balance > 0 ORDER BY balance DESC
  `;
  res.status(200).json(rows);
}

async function markPayoutPaid(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const userId = parseInt(req.body && req.body.user_id, 10);
  if (!userId) return res.status(400).json({ error: 'Missing user_id' });
  const rows = await sql`UPDATE users SET balance = 0 WHERE id = ${userId} RETURNING id`;
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.status(200).json({ ok: true });
}

async function playerReport(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const playerId = parseInt(req.query.player_id, 10);
  if (!playerId) return res.status(400).json({ error: 'Missing player_id' });

  const userRows = await sql`SELECT id, display_name, email, balance FROM users WHERE id = ${playerId}`;
  if (!userRows.length) return res.status(404).json({ error: 'User not found' });

  const purchaseRows = await sql`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total
    FROM sessions WHERE game = 'Pong' AND mode = 'solo' AND user_id = ${playerId}
  `;
  const stateRows = await sql`
    SELECT match_position, updated_at FROM player_game_state WHERE player_id = ${playerId} AND game = 'pong'
  `;
  const winRows = await sql`
    SELECT match_number FROM game_wins WHERE player_id = ${playerId} AND game = 'pong' ORDER BY match_number
  `;

  const balance = parseFloat(userRows[0].balance);
  const winCount = winRows.length;
  const winsExpectedBalance = winCount * PONG_WIN_PAYOUT;

  res.status(200).json({
    player_id: playerId,
    display_name: userRows[0].display_name,
    email: userRows[0].email,
    games_purchased: parseInt(purchaseRows[0].cnt, 10),
    total_paid: parseFloat(purchaseRows[0].total),
    match_position: stateRows.length ? stateRows[0].match_position : null,
    cycle_number: stateRows.length ? Math.floor(stateRows[0].match_position / PONG_CYCLE_LENGTH) : null,
    slot_in_cycle: stateRows.length ? stateRows[0].match_position % PONG_CYCLE_LENGTH : null,
    games_won: winCount,
    won_match_numbers: winRows.map(r => r.match_number),
    balance,
    wins_times_5: winsExpectedBalance,
    balance_matches_wins: Math.abs(balance - winsExpectedBalance) < 0.001,
  });
}

const ACTIONS = {
  'player-report': playerReport,
  'list-users': listUsers,
  'sales-stats': salesStats,
  'list-sessions': listSessions,
  'inspect-payment': inspectPayment,
  'inspect-checkout-session': inspectCheckoutSession,
  'delete-sessions': deleteSessions,
  'delete-users': deleteUsers,
  'reset-pong-cycle': resetPongCycle,
  'list-game-tokens': listGameTokens,
  'add-user-id-column': addUserIdColumn,
  'table-schema': tableSchema,
  'payout-requests': payoutRequests,
  'mark-paid': markPayoutPaid,
};

module.exports = async function handler(req, res) {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const fn = ACTIONS[req.query.action];
  if (!fn) return res.status(400).json({ error: 'Unknown action' });
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
