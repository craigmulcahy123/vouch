module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { toEmail, clientName, campaign, inviteId } = req.body;
  if (!toEmail || !clientName || !campaign) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const params = new URLSearchParams();
  if (inviteId) params.set("inviteId", inviteId);
  if (campaign.ownerId) params.set("owner", campaign.ownerId);
  const qs = params.toString();
  // Use req.headers.origin when available (cross-origin); fall back to host header.
  // Same-origin fetch calls omit the Origin header, so origin can be undefined.
  const baseUrl = req.headers.origin || `https://${req.headers.host}` || "https://vouchbusiness.com";
  const recordingLink = `${baseUrl}/record/${campaign.id}${qs ? `?${qs}` : ""}`;
  console.log("[send-invite] recording link:", recordingLink);
  const html = buildEmailHTML({ clientName, companyName: campaign.companyName, campaignName: campaign.name, prompts: campaign.prompts, recordingLink });

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `${campaign.companyName} via Vouch <hello@vouchbusiness.com>`,
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
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Share your experience with ${companyName}</title>
</head>
<body style="margin:0;padding:0;background:#f0ece4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f0ece4;">
    <tr><td style="padding:48px 16px;" align="center">

      <!-- Card -->
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%;">

        <!-- Dark header with logo -->
        <tr>
          <td style="background:#0e0e0e;border-radius:18px 18px 0 0;padding:26px 40px;text-align:center;">
            <span style="font-family:Georgia,'Times New Roman',serif;font-size:21px;font-style:italic;color:#c8a96e;letter-spacing:0.06em;">&#10022; Vouch</span>
          </td>
        </tr>

        <!-- Gold accent strip -->
        <tr><td style="background:#c8a96e;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>

        <!-- White body -->
        <tr>
          <td style="background:#ffffff;padding:48px 44px 40px;">

            <!-- Heading -->
            <h1 style="margin:0 0 20px;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;color:#0e0e0e;line-height:1.3;">
              Hi ${clientName},<br>
              <em style="color:#3a3530;">${companyName} would love<br>to hear from you</em>
            </h1>

            <!-- Body copy -->
            <p style="margin:0 0 40px;font-size:16px;color:#5a5348;line-height:1.7;">
              They&#8217;ve asked you to record a short video testimonial. It takes less than 5 minutes and you can do it from your phone right now.
            </p>

            <!-- CTA button -->
            <table cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:48px;">
              <tr>
                <td style="background:#c8a96e;border-radius:12px;">
                  <a href="${recordingLink}" style="display:inline-block;padding:17px 40px;font-size:16px;font-weight:700;color:#0e0e0e;text-decoration:none;letter-spacing:0.01em;white-space:nowrap;">
                    Record my testimonial &rarr;
                  </a>
                </td>
              </tr>
            </table>

            <!-- How it works -->
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#faf7f2;border:1px solid #ede8df;border-radius:14px;margin-bottom:36px;">
              <tr>
                <td style="padding:26px 28px;">
                  <p style="margin:0 0 20px;font-size:10px;font-weight:700;color:#c8a96e;text-transform:uppercase;letter-spacing:0.12em;">How it works</p>
                  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                    <tr>
                      <td width="33%" style="text-align:center;padding:0 8px;vertical-align:top;">
                        <p style="margin:0 0 10px;font-size:28px;line-height:1;">&#128249;</p>
                        <p style="margin:0 0 5px;font-size:13px;font-weight:700;color:#0e0e0e;">Record</p>
                        <p style="margin:0;font-size:12px;color:#9a9080;line-height:1.5;">Answer a few short questions on camera</p>
                      </td>
                      <td width="33%" style="text-align:center;padding:0 8px;vertical-align:top;">
                        <p style="margin:0 0 10px;font-size:28px;line-height:1;">&#11088;</p>
                        <p style="margin:0 0 5px;font-size:13px;font-weight:700;color:#0e0e0e;">Rate</p>
                        <p style="margin:0;font-size:12px;color:#9a9080;line-height:1.5;">Give your honest rating out of five</p>
                      </td>
                      <td width="33%" style="text-align:center;padding:0 8px;vertical-align:top;">
                        <p style="margin:0 0 10px;font-size:28px;line-height:1;">&#9989;</p>
                        <p style="margin:0 0 5px;font-size:13px;font-weight:700;color:#0e0e0e;">Submit</p>
                        <p style="margin:0;font-size:12px;color:#9a9080;line-height:1.5;">That&#8217;s it &#8212; done in minutes</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Fallback link -->
            <p style="margin:0;font-size:12px;color:#bbb;line-height:1.6;">
              Button not working?<br>
              <a href="${recordingLink}" style="color:#c8a96e;text-decoration:none;">${recordingLink}</a>
            </p>

          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f5f0e8;border-top:1px solid #e8e2d8;border-radius:0 0 18px 18px;padding:22px 44px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#9a9080;line-height:1.7;">
              Powered by <a href="https://vouchbusiness.com" style="color:#c8a96e;text-decoration:none;font-weight:600;">Vouch</a>
              &#8212; the trust platform for modern businesses<br>
              <span style="color:#bbb;">Sent on behalf of ${companyName}</span>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>

</body>
</html>`;
}
