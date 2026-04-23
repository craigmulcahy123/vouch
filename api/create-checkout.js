const Stripe = require('stripe');

const PRICE_IDS = {
  solo_monthly:       'price_1TPIlc2VR5AuDYR4pw0isqwv',
  solo_annual:        'price_1TPIlc2VR5AuDYR4sk9egJ52',
  business_monthly:   'price_1TPIpW2VR5AuDYR4pmpFKC1K',
  business_annual:    'price_1TPIqA2VR5AuDYR4H2ufRXQG',
  agency_monthly:     'price_1TPJK12VR5AuDYR4zjYKwOPM',
  agency_annual:      'price_1TPJKG2VR5AuDYR4PoxssEMX',
  enterprise_monthly: 'price_1TPJKr2VR5AuDYR4xbYi6z81',
  enterprise_annual:  'price_1TPJL42VR5AuDYR4hLVcnChu',
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { planKey, billingPeriod, userId, userEmail } = req.body;

  if (!planKey || !billingPeriod || !userId) {
    return res.status(400).json({ error: 'Missing planKey, billingPeriod, or userId' });
  }

  const priceKey = `${planKey}_${billingPeriod}`;
  const priceId = PRICE_IDS[priceKey];
  if (!priceId) {
    return res.status(400).json({ error: `Unknown plan: ${priceKey}` });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://vouchbusiness.com/dashboard?upgraded=true',
      cancel_url: 'https://vouchbusiness.com/pricing.html',
      ...(userEmail ? { customer_email: userEmail } : {}),
      metadata: { userId, planKey, billingPeriod },
      subscription_data: {
        metadata: { userId, planKey, billingPeriod },
      },
    });
  } catch (err) {
    console.error('[create-checkout] Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  console.log(`[create-checkout] session created: ${session.id} for userId=${userId} plan=${priceKey}`);
  return res.status(200).json({ url: session.url });
};
