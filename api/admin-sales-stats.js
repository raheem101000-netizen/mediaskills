const db = require('./_db');

const ADMIN_KEY = 'TENTEN2025';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const totals = await db().query('SELECT COUNT(*) AS total_sales, COALESCE(SUM(amount),0) AS total_revenue FROM sessions');
    const byGame = await db().query('SELECT game, mode, COUNT(*) AS sales, SUM(amount) AS revenue FROM sessions GROUP BY game, mode ORDER BY revenue DESC');
    res.status(200).json({
      total_sales: parseInt(totals.rows[0].total_sales, 10),
      total_revenue: parseFloat(totals.rows[0].total_revenue),
      breakdown: byGame.rows.map(r => ({
        game: r.game,
        mode: r.mode,
        sales: parseInt(r.sales, 10),
        revenue: parseFloat(r.revenue)
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
