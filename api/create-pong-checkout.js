const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://all-solo-ggames.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();
  const playerId = parseInt(req.body && req.body.player_id, 10);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Pong — Entry Fee' },
          unit_amount: 299,
        },
        quantity: 1,
      }],
      // player_id is omitted entirely for guests rather than sent as an invalid
      // value, since Stripe metadata values must be strings.
      metadata: playerId ? { player_id: String(playerId), game: 'Pong', mode: 'solo' } : { game: 'Pong', mode: 'solo' },
      success_url: 'https://all-solo-ggames.vercel.app/pong/?paid=true&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://all-solo-ggames.vercel.app/pong/',
    });
    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
