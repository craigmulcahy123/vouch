const Stripe = require('stripe');

const PRICE_IDS = {
  solo_monthly:       'price_SOLO_MONTHLY',
  solo_annual:        'price_SOLO_ANNUAL',
  business_monthly:   'price_BUSINESS_MONTHLY',
  business_annual:    'price_BUSINESS_ANNUAL',
  agency_monthly:     'price_AGENCY_MONTHLY',
  agency_annual:      'price_AGENCY_ANNUAL',
  enterprise_monthly: 'price_ENTERPRISE_MONTHLY',
  enterprise_annual:  'price_ENTERPRISE_ANNUAL',
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
