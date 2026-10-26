const sql = require('./_db');

// Top Winners leaderboard, served as GET /api/leaderboard?window=week|month
// (vercel.json routes it to auth-misc?action=leaderboard: Vercel's Hobby plan
// allows 12 functions and this would be the 13th, like /api/creator).
//
// Public and read-only: SELECTs only, in a read-only transaction, no session needed. Winnings ONLY — the
// sum of prizes credited for match wins. It reads settled_matches'
// winner_user_id / prize / game / settled_at and nothing else: never entry
// prices, margins, losers, balances or payouts, so no loss, spend or net
// figure can leak. No user id, email or avatar is returned — display_name
// only, as the nav already shows it.
//
// Source: settled_matches — one row per paid match, written by FIFA (1V1
// Arena), Pong, Kurver and HEDDY inside the same transaction that credits the
// winner, with prize = exactly the amount credited. Left out on purpose:
// legacy Pong Solo and admin manual credits (never written here) and admin
// test rows (match_key 'test:%').
//
// Windows are Europe/Oslo time: week = since Monday 00:00, month = since the
// 1st 00:00 (Postgres weeks start on Monday).
const TZ = 'Europe/Oslo';
const LIMIT = 50;
const GAME_LABELS = { fifa: '1V1 ARENA', pong: 'PONG', kurver: 'KURVER', footy: 'HEDDY' };

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const window = req.query.window === 'month' ? 'month' : 'week';
  // Same for every viewer: a short edge cache keeps the page cheap.
  res.setHeader('Cache-Control', 'public, max-age=0');
  res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=60, stale-while-revalidate=60');

  const [[bounds], rows] = await sql.transaction([
    sql`
      SELECT date_trunc(${window}::text, now() AT TIME ZONE ${TZ}::text) AT TIME ZONE ${TZ}::text AS since,
             (date_trunc(${window}::text, now() AT TIME ZONE ${TZ}::text) + ('1 ' || ${window}::text)::interval) AT TIME ZONE ${TZ}::text AS resets_at
    `,
    sql`
      SELECT RANK() OVER (ORDER BY SUM(sm.prize) DESC, COUNT(*) DESC)::int AS rank,
             COALESCE(NULLIF(u.display_name, ''), 'PLAYER') AS display_name,
             SUM(sm.prize) AS total_won,
             COUNT(*)::int AS wins,
             ARRAY_AGG(DISTINCT sm.game ORDER BY sm.game) AS games
        FROM settled_matches sm
        JOIN users u ON u.id = sm.winner_user_id
       WHERE sm.settled_at >= date_trunc(${window}::text, now() AT TIME ZONE ${TZ}::text) AT TIME ZONE ${TZ}::text
         AND sm.match_key NOT LIKE 'test:%'
         AND sm.prize > 0
       GROUP BY sm.winner_user_id, u.display_name
       ORDER BY rank, MAX(sm.settled_at)
       LIMIT ${LIMIT}
    `
  ], { readOnly: true });

  res.status(200).json({
    window,
    timezone: TZ,
    since: bounds.since,
    resets_at: bounds.resets_at,
    rows: rows.map(r => ({
      rank: r.rank,
      display_name: r.display_name,
      total_won: Number(r.total_won).toFixed(2),
      wins: r.wins,
      games: r.games.map(g => GAME_LABELS[g] || g.toUpperCase())
    }))
  });
};
