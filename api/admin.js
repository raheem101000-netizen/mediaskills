const sql = require('./_db');

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
