const cookie = require('cookie');
const sql = require('./_db');

const MAX_LEN = 500;

async function requireSession(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const sid = cookies.session;
  if (!sid) return null;
  const s = await sql`
    SELECT u.id, u.display_name FROM auth_sessions a
    JOIN users u ON u.id = a.user_id
    WHERE a.id=${sid} AND a.expires_at > NOW()
  `;
  return s.length ? s[0] : null;
}

// Host creates a new FIFA 1v1 match. No payment/reporting yet (that's steps
// 7.3/7.4) — this just creates the row and logs a system message.
async function createMatch(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const host = await requireSession(req);
  if (!host) return res.status(401).json({ error: 'Not logged in' });
  const rows = await sql`
    INSERT INTO fifa_matches (host_user_id, status) VALUES (${host.id}, 'awaiting_opponent')
    RETURNING id
  `;
  const matchId = rows[0].id;
  await sql`
    INSERT INTO fifa_messages (match_id, user_id, text, is_system)
    VALUES (${matchId}, NULL, ${host.display_name + ' created the match.'}, true)
  `;
  res.status(200).json({ id: matchId });
}

// Opponent joins an existing match by id. Idempotent if the same user hits
// it twice (e.g. a page refresh) — only rejects a second, different player.
async function joinMatch(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const opponent = await requireSession(req);
  if (!opponent) return res.status(401).json({ error: 'Not logged in' });
  const matchId = parseInt(req.body && req.body.match_id, 10);
  if (!matchId) return res.status(400).json({ error: 'Missing match_id' });

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
}

// Returns full match state for a participant (host or opponent only).
async function getMatch(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const user = await requireSession(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const matchId = parseInt(req.query.id, 10);
  if (!matchId) return res.status(400).json({ error: 'Missing id' });

  const rows = await sql`
    SELECT m.*, h.display_name AS host_name, o.display_name AS opponent_name
    FROM fifa_matches m
    JOIN users h ON h.id = m.host_user_id
    LEFT JOIN users o ON o.id = m.opponent_user_id
    WHERE m.id=${matchId}
  `;
  if (!rows.length) return res.status(404).json({ error: 'Match not found' });
  const match = rows[0];

  if (match.host_user_id !== user.id && match.opponent_user_id !== user.id) {
    return res.status(403).json({ error: 'Not a participant in this match' });
  }

  res.status(200).json({ ...match, my_user_id: user.id });
}

// Text-only chat message. Image upload is added in a later step.
async function sendMessage(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const user = await requireSession(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const matchId = parseInt(req.body && req.body.match_id, 10);
  const text = (req.body && req.body.text || '').trim().slice(0, MAX_LEN);
  if (!matchId) return res.status(400).json({ error: 'Missing match_id' });
  if (!text) return res.status(400).json({ error: 'Empty message' });

  const matchRows = await sql`SELECT host_user_id, opponent_user_id FROM fifa_matches WHERE id=${matchId}`;
  if (!matchRows.length) return res.status(404).json({ error: 'Match not found' });
  const match = matchRows[0];
  if (match.host_user_id !== user.id && match.opponent_user_id !== user.id) {
    return res.status(403).json({ error: 'Not a participant in this match' });
  }

  const rows = await sql`
    INSERT INTO fifa_messages (match_id, user_id, text, is_system)
    VALUES (${matchId}, ${user.id}, ${text}, false)
    RETURNING id, match_id, user_id, text, image_url, is_system, created_at
  `;
  res.status(200).json(rows[0]);
}

// Polling endpoint: returns messages with id > after, ascending.
async function getMessages(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const user = await requireSession(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const matchId = parseInt(req.query.matchId, 10);
  const after = parseInt(req.query.after, 10) || 0;
  if (!matchId) return res.status(400).json({ error: 'Missing matchId' });

  const matchRows = await sql`SELECT host_user_id, opponent_user_id FROM fifa_matches WHERE id=${matchId}`;
  if (!matchRows.length) return res.status(404).json({ error: 'Match not found' });
  const match = matchRows[0];
  if (match.host_user_id !== user.id && match.opponent_user_id !== user.id) {
    return res.status(403).json({ error: 'Not a participant in this match' });
  }

  const rows = await sql`
    SELECT m.id, m.match_id, m.user_id, m.text, m.image_url, m.is_system, m.created_at,
           u.display_name
    FROM fifa_messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.match_id=${matchId} AND m.id > ${after}
    ORDER BY m.id ASC
  `;
  res.status(200).json(rows);
}

const ACTIONS = {
  'create-match': createMatch,
  'join-match': joinMatch,
  'match': getMatch,
  'send-message': sendMessage,
  'messages': getMessages,
};

module.exports = async function handler(req, res) {
  const fn = ACTIONS[req.query.action];
  if (!fn) return res.status(400).json({ error: 'Unknown action' });
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
