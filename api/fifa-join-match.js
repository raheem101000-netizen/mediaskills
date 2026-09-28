const cookie = require('cookie');
const sql = require('./_db');

// Opponent joins an existing match by id. Idempotent if the same user hits
// it twice (e.g. a page refresh) — only rejects a second, different player.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  const matchId = parseInt(req.body && req.body.match_id, 10);
  if (!matchId) return res.status(400).json({ error: 'Missing match_id' });
  try {
    const s = await sql`
      SELECT u.id, u.display_name FROM auth_sessions a
      JOIN users u ON u.id = a.user_id
      WHERE a.id=${sid} AND a.expires_at > NOW()
    `;
    if (!s.length) return res.status(401).json({ error: 'Session expired' });
    const opponent = s[0];

    const matchRows = await sql`SELECT * FROM fifa_matches WHERE id=${matchId}`;
    if (!matchRows.length) return res.status(404).json({ error: 'Match not found' });
    const match = matchRows[0];

    if (match.host_user_id === opponent.id) {
      return res.status(400).json({ error: "You can't join your own match" });
    }
    if (match.opponent_user_id) {
      if (match.opponent_user_id === opponent.id) {
        return res.status(200).json({ id: match.id });
      }
      return res.status(400).json({ error: 'This match already has two players' });
    }

    await sql`
      UPDATE fifa_matches
      SET opponent_user_id=${opponent.id}, status='awaiting_payment', updated_at=now()
      WHERE id=${matchId}
    `;
    await sql`
      INSERT INTO fifa_messages (match_id, user_id, text, is_system)
      VALUES (${matchId}, NULL, ${opponent.display_name + ' joined the match.'}, true)
    `;
    res.status(200).json({ id: matchId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
