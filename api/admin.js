const sql = require('./_db');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const ADMIN_KEY = 'TENTEN2025';

async function listUsers(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const rows = await sql`
    SELECT id, display_name, email, balance, paypal_email, created_at
    FROM users ORDER BY balance DESC
  `;
  res.status(200).json(rows);
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
      SELECT id, game, mode, amount, stripe_payment_id, created_at
      FROM sessions WHERE game = ${game} AND mode = ${mode} ORDER BY created_at ASC
    `;
  } else {
    rows = await sql`
      SELECT id, game, mode, amount, stripe_payment_id, created_at
      FROM sessions ORDER BY created_at ASC
    `;
  }
  res.status(200).json(rows.map(r => ({
    id: r.id, game: r.game, mode: r.mode,
    amount: parseFloat(r.amount), stripe_payment_id: r.stripe_payment_id, created_at: r.created_at
  })));
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

const ACTIONS = {
  'list-users': listUsers,
  'sales-stats': salesStats,
  'list-sessions': listSessions,
  'inspect-payment': inspectPayment,
  'delete-sessions': deleteSessions,
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
