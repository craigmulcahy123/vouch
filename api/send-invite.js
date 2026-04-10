export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { toEmail, clientName, campaign } = req.body;
  if (!toEmail || !clientName || !campaign) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const recordingLink = `${req.headers.origin}/record/${campaign.id}`;
  const html = buildEmailHTML({ clientName, companyName: campaign.companyName, campaignName: campaign.name, prompts: campaign.prompts, recordingLink });

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `${campaign.companyName} via Vouch <onboarding@resend.dev>`,
      to: [toEmail],
      subject: `${clientName}, share your experience with ${campaign.companyName}`,
      html,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    return res.status(response.status).json({ error: err.message || "Failed to send email" });
  }

  return res.status(200).json({ ok: true });
}

function buildEmailHTML({ clientName, companyName, campaignName, prompts, recordingLink }) {
  const promptRows = prompts.map((p, i) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #ede8dc;vertical-align:top;width:28px;">
        <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#c8a96e;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:22px;">${i + 1}</span>
      </td>
      <td style="padding:10px 0 10px 12px;border-bottom:1px solid #ede8dc;font-size:14px;color:#3a3530;line-height:1.5;">${p}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Share your experience</title></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:48px 24px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="padding-bottom:32px;text-align:center;">
          <span style="font-size:20px;color:#c8a96e;font-style:italic;">Vouch&#10022;</span>
        </td></tr>
        <tr><td style="background:#faf7f2;border:1px solid #ddd8cc;border-radius:20px;overflow:hidden;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="background:#c8a96e;height:4px;font-size:1px;line-height:1px;">&nbsp;</td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:40px 44px;">
              <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:#c8a96e;text-transform:uppercase;letter-spacing:0.1em;">You've been invited</p>
              <h1 style="margin:0 0 16px;font-size:26px;font-weight:400;color:#0e0e0e;line-height:1.25;">Hi ${clientName}, share your<br><em>honest experience</em> with us</h1>
              <p style="margin:0 0 28px;font-size:15px;color:#7a7060;line-height:1.6;">${companyName} would love to hear about your experience. It takes just a few minutes — and your words could help others make a great decision.</p>
              <p style="margin:0 0 12px;font-size:11px;font-weight:600;color:#7a7060;text-transform:uppercase;letter-spacing:0.06em;">You'll be asked about</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">${promptRows}</table>
              <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr><td style="background:#0e0e0e;border-radius:10px;">
                  <a href="${recordingLink}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Record My Testimonial &rarr;</a>
                </td></tr>
              </table>
              <p style="margin:0;font-size:12px;color:#aaa;line-height:1.5;">Or copy this link: <a href="${recordingLink}" style="color:#c8a96e;">${recordingLink}</a></p>
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #ede8dc;">
            <tr><td style="padding:18px 44px;text-align:center;">
              <p style="margin:0;font-size:11px;color:#bbb;">Sent via <span style="color:#c8a96e;">Vouch</span> on behalf of ${companyName} &middot; ${campaignName}</p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
