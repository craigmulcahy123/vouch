const admin = require('firebase-admin');

let _db = null;
function getDb() {
  if (_db) return _db;
  if (!admin.apps.length) {
    const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!key) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY env var not set');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(key)) });
  }
  _db = admin.firestore();
  return _db;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, company, website, reason } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  // Save to Firestore
  try {
    const db = getDb();
    const docRef = db.collection('partners').doc();
    await docRef.set({
      id: docRef.id,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      company: (company || '').trim(),
      website: (website || '').trim(),
      reason: (reason || '').trim(),
      status: 'pending',
      submittedAt: Date.now(),
      referralCount: 0,
      totalEarnings: 0,
    });
    console.log('[partner-signup] saved to Firestore:', docRef.id);
  } catch (err) {
    console.error('[partner-signup] Firestore write failed:', err.message);
    // Non-fatal — still send emails
  }

  // Send emails in parallel
  await Promise.allSettled([
    sendWelcomeEmail({ name, email, company }),
    sendAdminNotification({ name, email, company, website, reason }),
  ]);

  return res.status(200).json({ ok: true });
};

async function sendEmail(payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('[partner-signup] email send failed:', err.message || res.status);
  }
}

async function sendWelcomeEmail({ name, email, company }) {
  const firstName = name.split(' ')[0];
  await sendEmail({
    from: 'Craig at Vouch <hello@vouchbusiness.com>',
    to: [email],
    subject: `Welcome to the Vouch Partner Program, ${firstName}!`,
    html: buildWelcomeEmailHTML({ firstName, company }),
  });
}

async function sendAdminNotification({ name, email, company, website, reason }) {
  await sendEmail({
    from: 'Vouch Partners <hello@vouchbusiness.com>',
    to: ['hello@vouchbusiness.com'],
    subject: `New Partner Application: ${name}${company ? ` · ${company}` : ''}`,
    html: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;color:#333;">
      <h2 style="color:#0e0e0e;margin-bottom:24px;">New Partner Application</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;width:130px;">Name</td><td style="padding:8px 0;border-bottom:1px solid #eee;">${esc(name)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">Email</td><td style="padding:8px 0;border-bottom:1px solid #eee;"><a href="mailto:${esc(email)}" style="color:#c8a96e;">${esc(email)}</a></td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">Company</td><td style="padding:8px 0;border-bottom:1px solid #eee;">${esc(company || '—')}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">Website</td><td style="padding:8px 0;border-bottom:1px solid #eee;">${esc(website || '—')}</td></tr>
        <tr><td style="padding:8px 0;font-weight:600;vertical-align:top;">How they'll promote</td><td style="padding:8px 0;">${esc(reason || '—')}</td></tr>
      </table>
      <p style="margin-top:32px;color:#888;font-size:0.85rem;">To approve: open Firebase Console → Firestore → users → find their account → set <code>partner: true</code></p>
    </body></html>`,
  });
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildWelcomeEmailHTML({ firstName, company }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Welcome to the Vouch Partner Program</title>
</head>
<body style="margin:0;padding:0;background:#f0ece4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f0ece4;">
    <tr><td style="padding:48px 16px;" align="center">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%;">

        <tr>
          <td style="background:#0e0e0e;border-radius:18px 18px 0 0;padding:26px 40px;text-align:center;">
            <span style="font-family:Georgia,'Times New Roman',serif;font-size:21px;font-style:italic;color:#c8a96e;letter-spacing:0.06em;">&#10022; Vouch</span>
          </td>
        </tr>
        <tr><td style="background:#c8a96e;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>

        <tr>
          <td style="background:#ffffff;padding:48px 44px 40px;">
            <h1 style="margin:0 0 20px;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;color:#0e0e0e;line-height:1.3;">
              Hi ${firstName},<br>
              <em style="color:#3a3530;">you&#8217;re on the list.</em>
            </h1>

            <p style="margin:0 0 20px;font-size:16px;color:#5a5348;line-height:1.7;">
              Thanks for applying to the <strong>Vouch Partner Program</strong>${company ? ` on behalf of <strong>${esc(company)}</strong>` : ''}. We review applications within 2–3 business days and will get back to you with your referral link and partner resources.
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#faf7f2;border:1px solid #ede8df;border-radius:14px;margin-bottom:36px;">
              <tr><td style="padding:26px 28px;">
                <p style="margin:0 0 16px;font-size:10px;font-weight:700;color:#c8a96e;text-transform:uppercase;letter-spacing:0.12em;">What happens next</p>
                <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                  <tr>
                    <td style="vertical-align:top;padding-right:16px;padding-bottom:14px;">
                      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#0e0e0e;">1. Review</p>
                      <p style="margin:0;font-size:12px;color:#9a9080;line-height:1.5;">We'll review your application and reach out within 2–3 business days.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="vertical-align:top;padding-right:16px;padding-bottom:14px;">
                      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#0e0e0e;">2. Onboarding</p>
                      <p style="margin:0;font-size:12px;color:#9a9080;line-height:1.5;">You'll get your unique referral link, marketing resources, and partner dashboard access.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="vertical-align:top;">
                      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#0e0e0e;">3. Earn</p>
                      <p style="margin:0;font-size:12px;color:#9a9080;line-height:1.5;">Start earning 20–35% recurring commission on every account you refer.</p>
                    </td>
                  </tr>
                </table>
              </td></tr>
            </table>

            <p style="margin:0;font-size:13px;color:#9a9080;line-height:1.6;">
              Questions? Reply to this email or reach us at <a href="mailto:hello@vouchbusiness.com" style="color:#c8a96e;text-decoration:none;">hello@vouchbusiness.com</a>
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#f5f0e8;border-top:1px solid #e8e2d8;border-radius:0 0 18px 18px;padding:22px 44px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9a9080;line-height:1.7;">
              <a href="https://vouchbusiness.com" style="color:#c8a96e;text-decoration:none;font-weight:600;">Vouch</a>
              &#8212; the trust platform for modern businesses
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
