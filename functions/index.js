"use strict";

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin  = require("firebase-admin");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const fetch  = require("node-fetch");
const { Resend } = require("resend");
const os   = require("os");
const path = require("path");
const fs   = require("fs");

admin.initializeApp();
ffmpeg.setFfmpegPath(ffmpegPath);

const db      = admin.firestore();
const storage = admin.storage();

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// ── processTestimonial ────────────────────────────────────────────────────────
exports.processTestimonial = onDocumentWritten(
  {
    document: "users/{userId}/testimonials/{testimonialId}",
    timeoutSeconds: 540,
    memory: "2GiB",
    region: "us-central1",
    secrets: ["ANTHROPIC_API_KEY", "RESEND_API_KEY"],
  },
  async (event) => {
    const { userId, testimonialId } = event.params;
    const snap = event.data?.after;
    if (!snap?.exists) return;

    const data = snap.data();
    const before = event.data?.before;
    const isCreate = !before?.exists;
    const statusBefore = before?.exists ? before.data()?.status : null;

    // Fire on creation or when the dashboard resets status to "new" for reprocessing.
    // Ignore all other updates to avoid infinite loops.
    if (!isCreate && !(data.status === "new" && statusBefore !== "new")) return;

    const testimonialRef = db
      .collection("users").doc(userId)
      .collection("testimonials").doc(testimonialId);

    console.log(`[processTestimonial] start — userId:${userId} testimonialId:${testimonialId}`);

    // ── 1. Mark as processing ────────────────────────────────────────────────
    await testimonialRef.update({ status: "processing", processingStartedAt: Date.now() });

    try {
      // ── 2. Fetch campaign for companyName + owner email ──────────────────
      let companyName = data.companyName || "";
      let ownerEmail  = null;

      if (data.campaignId) {
        try {
          const campaignSnap = await db
            .collection("users").doc(userId)
            .collection("campaigns").doc(data.campaignId).get();
          if (campaignSnap.exists) {
            companyName = campaignSnap.data().companyName || companyName;
          }
        } catch (e) {
          console.warn("[processTestimonial] could not fetch campaign:", e.message);
        }
      }

      try {
        const userRecord = await admin.auth().getUser(userId);
        ownerEmail = userRecord.email || null;
      } catch (e) {
        console.warn("[processTestimonial] could not get owner email:", e.message);
      }

      // ── 3. Get client email ──────────────────────────────────────────────
      let clientEmail = data.clientEmail || null;
      if (!clientEmail && data.inviteId) {
        try {
          const inviteSnap = await db
            .collection("users").doc(userId)
            .collection("invites").doc(data.inviteId).get();
          if (inviteSnap.exists) {
            const inv = inviteSnap.data();
            clientEmail = inv.clientEmail || inv.toEmail || null;
          }
        } catch {}
      }

      // ── 4. Handle text-only testimonial (no videos) ──────────────────────
      const videoURLs    = data.videoURLs || {};
      const videoEntries = Object.entries(videoURLs)
        .filter(([, url]) => url)
        .sort(([a], [b]) => Number(a) - Number(b));

      if (videoEntries.length === 0) {
        console.log("[processTestimonial] no videos — skipping video processing");
        await testimonialRef.update({ status: "processed", processedAt: Date.now(), processedVideoURLs: {} });
        await sendCompletionEmails({ ownerEmail, clientEmail, data, companyName, processedVideoURLs: {} });
        return;
      }

      const tmpDir = os.tmpdir();
      const bucket = storage.bucket();
      const processedVideoURLs = {};

      // ── 5. Download source WebM files ────────────────────────────────────
      console.log(`[processTestimonial] downloading ${videoEntries.length} video(s)`);
      const localWebms = {};

      for (const [qIdx, url] of videoEntries) {
        const localPath = path.join(tmpDir, `${testimonialId}_q${qIdx}_src.webm`);
        try {
          await downloadFile(url, localPath);
          const dlSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
          console.log(`[processTestimonial] downloaded Q${qIdx} — ${(dlSize / 1024 / 1024).toFixed(2)} MB`);
          if (dlSize < 1024) {
            console.warn(`[processTestimonial] ⚠ Q${qIdx} suspiciously small (${dlSize} bytes) — skipping`);
          } else {
            localWebms[qIdx] = localPath;
          }
        } catch (e) {
          console.error(`[processTestimonial] ❌ download failed Q${qIdx}: ${e.message}`);
        }
      }

      if (Object.keys(localWebms).length === 0) {
        throw new Error("All video downloads failed — nothing to process");
      }

      // ── 6. Convert each WebM to MP4 ──────────────────────────────────────
      const convertedMp4s = {};

      for (const [qIdx, webmPath] of Object.entries(localWebms)) {
        const mp4Path = path.join(tmpDir, `${testimonialId}_q${qIdx}.mp4`);
        try {
          await convertToMp4(webmPath, mp4Path);
          const outSize = fs.existsSync(mp4Path) ? fs.statSync(mp4Path).size : 0;
          console.log(`[processTestimonial] Q${qIdx} converted — ${(outSize / 1024 / 1024).toFixed(2)} MB`);
          if (outSize < 1024 * 1024) {
            console.error(`[processTestimonial] ❌ Q${qIdx} output < 1 MB — skipping`);
          } else {
            convertedMp4s[qIdx] = mp4Path;
          }
        } catch (e) {
          console.error(`[processTestimonial] ❌ convert failed Q${qIdx}: ${e.message}`);
        }
      }

      if (Object.keys(convertedMp4s).length === 0) {
        throw new Error("All conversions failed — nothing to upload");
      }

      // ── 7. Resize q0 to landscape / portrait / square ────────────────────
      const q0Path = convertedMp4s["0"] ?? Object.values(convertedMp4s)[0];

      const outputFormats = [
        { name: "landscape", width: 1920, height: 1080 },
        { name: "portrait",  width: 1080, height: 1920 },
        { name: "square",    width: 1080, height: 1080 },
      ];

      for (const fmt of outputFormats) {
        const outputPath = path.join(tmpDir, `${testimonialId}_${fmt.name}.mp4`);
        try {
          await resizeVideo({ inputPath: q0Path, outputPath, width: fmt.width, height: fmt.height });

          const uploadSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
          console.log(`[processTestimonial] ${fmt.name} — ${(uploadSize / 1024 / 1024).toFixed(2)} MB`);

          if (uploadSize < 1024 * 1024) {
            console.error(`[processTestimonial] ❌ ${fmt.name} < 1 MB — skipping upload`);
            continue;
          }

          const storagePath = `users/${userId}/processed/${testimonialId}/${fmt.name}.mp4`;
          await bucket.upload(outputPath, {
            destination: storagePath,
            metadata: { contentType: "video/mp4", cacheControl: "public, max-age=31536000" },
            public: true,
          });
          processedVideoURLs[fmt.name] = {
            url: `https://storage.googleapis.com/${bucket.name}/${storagePath}`,
            storagePath,
          };
          console.log(`[processTestimonial] uploaded ${fmt.name}`);
        } catch (e) {
          console.error(`[processTestimonial] ❌ ${fmt.name} failed: ${e.message}`);
        } finally {
          try { fs.unlinkSync(outputPath); } catch {}
        }
      }

      // ── 8. Upload individual question MP4s ───────────────────────────────
      for (const [qIdx, mp4Path] of Object.entries(convertedMp4s)) {
        try {
          const uploadSize = fs.existsSync(mp4Path) ? fs.statSync(mp4Path).size : 0;
          const storagePath = `users/${userId}/processed/${testimonialId}/q${qIdx}.mp4`;
          await bucket.upload(mp4Path, {
            destination: storagePath,
            metadata: { contentType: "video/mp4", cacheControl: "public, max-age=31536000" },
            public: true,
          });
          processedVideoURLs[`q${qIdx}`] = {
            url: `https://storage.googleapis.com/${bucket.name}/${storagePath}`,
            storagePath,
          };
          console.log(`[processTestimonial] uploaded q${qIdx}.mp4 — ${(uploadSize / 1024 / 1024).toFixed(2)} MB`);
        } catch (e) {
          console.error(`[processTestimonial] ❌ q${qIdx}.mp4 upload failed: ${e.message}`);
        }
      }

      // ── 9. Cleanup /tmp ──────────────────────────────────────────────────
      for (const p of [...Object.values(localWebms), ...Object.values(convertedMp4s)]) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
      }

      // ── 10. Update Firestore ─────────────────────────────────────────────
      await testimonialRef.update({
        status: "processed",
        processedAt: Date.now(),
        processedVideoURLs,
      });
      console.log(`[processTestimonial] done — uploaded: ${Object.keys(processedVideoURLs).join(", ")}`);

      // ── 11. Send completion emails ───────────────────────────────────────
      await sendCompletionEmails({ ownerEmail, clientEmail, data, companyName, processedVideoURLs });

    } catch (err) {
      console.error("[processTestimonial] fatal error:", err);
      await testimonialRef.update({
        status: "failed",
        failedAt: Date.now(),
        failureReason: err.message || String(err),
      }).catch(() => {});
    }
  },
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Stream-download a URL to a local file path. */
function downloadFile(url, destPath) {
  return fetch(url).then(res => {
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
    return new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(destPath);
      res.body.pipe(stream);
      stream.on("finish", resolve);
      stream.on("error", reject);
    });
  });
}

/**
 * Convert a WebM to MP4 with simple libx264 encoding.
 * No seeking, no trimming, no filters.
 * Equivalent to: ffmpeg -i input.webm -c:v libx264 -preset fast -crf 23
 *                       -pix_fmt yuv420p -c:a aac -movflags +faststart output.mp4
 */
function convertToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const stderrLines = [];
    const srcMB = (fs.existsSync(inputPath) ? fs.statSync(inputPath).size : 0) / 1024 / 1024;
    console.log(`[FFmpeg] convert — ${path.basename(inputPath)} → ${path.basename(outputPath)} | input: ${srcMB.toFixed(2)} MB`);

    ffmpeg(inputPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions(["-preset fast", "-crf 23", "-pix_fmt yuv420p", "-movflags +faststart"])
      .on("stderr", line => {
        stderrLines.push(line);
        if (/frame=|fps=|error|Error|invalid|corrupt/i.test(line)) console.log("[FFmpeg stderr]", line);
      })
      .on("end", () => {
        const outMB = (fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0) / 1024 / 1024;
        console.log(`[FFmpeg] ✅ convert ${path.basename(outputPath)} — output: ${outMB.toFixed(2)} MB`);
        if (outMB < 1) {
          console.error(`[FFmpeg] ❌ output < 1 MB. Full stderr:\n${stderrLines.join("\n")}`);
        }
        resolve();
      })
      .on("error", err => {
        console.error(`[FFmpeg] ❌ convert ${path.basename(inputPath)}: ${err.message}\nFull stderr:\n${stderrLines.join("\n")}`);
        reject(err);
      })
      .save(outputPath);
  });
}

/**
 * Resize an MP4 to target dimensions with scale+pad+setsar.
 * Equivalent to: ffmpeg -i input.mp4 -vf "scale=W:H:force_original_aspect_ratio=decrease,
 *                pad=W:H:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
 *                -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac
 *                -movflags +faststart output.mp4
 */
function resizeVideo({ inputPath, outputPath, width, height }) {
  return new Promise((resolve, reject) => {
    const stderrLines = [];
    const srcMB = (fs.existsSync(inputPath) ? fs.statSync(inputPath).size : 0) / 1024 / 1024;
    console.log(`[FFmpeg] resize — ${path.basename(outputPath)} | ${width}x${height} | input: ${srcMB.toFixed(2)} MB`);

    ffmpeg(inputPath)
      .videoFilter(`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions(["-preset fast", "-crf 23", "-pix_fmt yuv420p", "-movflags +faststart"])
      .on("stderr", line => {
        stderrLines.push(line);
        if (/frame=|fps=|error|Error|invalid|corrupt/i.test(line)) console.log("[FFmpeg stderr]", line);
      })
      .on("end", () => {
        const outMB = (fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0) / 1024 / 1024;
        console.log(`[FFmpeg] ✅ resize ${path.basename(outputPath)} — output: ${outMB.toFixed(2)} MB`);
        if (outMB < 1) {
          console.error(`[FFmpeg] ❌ resize output < 1 MB. Full stderr:\n${stderrLines.join("\n")}`);
        }
        resolve();
      })
      .on("error", err => {
        console.error(`[FFmpeg] ❌ resize ${path.basename(outputPath)}: ${err.message}\nFull stderr:\n${stderrLines.join("\n")}`);
        reject(err);
      })
      .save(outputPath);
  });
}

/** Send the two completion emails via Resend. */
async function sendCompletionEmails({ ownerEmail, clientEmail, data, companyName, processedVideoURLs }) {
  console.log("[sendEmails] ownerEmail:", ownerEmail, "| clientEmail:", clientEmail, "| formats:", Object.keys(processedVideoURLs));

  const resend      = getResend();
  const clientName  = data.clientName || "Your client";
  const displayComp = companyName || "your company";

  const highlightFormats = ["landscape", "portrait", "square"];
  const downloadButtons = Object.entries(processedVideoURLs)
    .filter(([fmt]) => highlightFormats.includes(fmt))
    .map(([fmt, { url }]) => {
      const label = fmt === "landscape" ? "16:9 Landscape"
        : fmt === "portrait" ? "9:16 Portrait"
        : "1:1 Square";
      return `<a href="${url}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 20px;background:#c8a96e;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">${label}</a>`;
    })
    .join("");

  if (ownerEmail) {
    try {
      const { data: emailData, error: emailError } = await resend.emails.send({
        from: "Vouch <hello@vouchbusiness.com>",
        to: [ownerEmail],
        subject: `Your testimonial from ${clientName} is ready to download`,
        html: buildOwnerEmail({ clientName, displayComp, downloadButtons }),
      });
      if (emailError) {
        console.error("[sendEmails] ❌ owner email error:", JSON.stringify(emailError));
      } else {
        console.log("[sendEmails] ✅ owner email sent — id:", emailData?.id);
      }
    } catch (e) {
      console.error("[sendEmails] ❌ owner email exception:", e.message);
    }
  } else {
    console.warn("[sendEmails] skipping owner email — no ownerEmail");
  }

  if (clientEmail) {
    try {
      const { data: emailData, error: emailError } = await resend.emails.send({
        from: `${displayComp} via Vouch <hello@vouchbusiness.com>`,
        to: [clientEmail],
        subject: `Thank you for your testimonial, ${clientName}!`,
        html: buildClientEmail({ clientName, displayComp }),
      });
      if (emailError) {
        console.error("[sendEmails] ❌ client email error:", JSON.stringify(emailError));
      } else {
        console.log("[sendEmails] ✅ client email sent — id:", emailData?.id);
      }
    } catch (e) {
      console.error("[sendEmails] ❌ client email exception:", e.message);
    }
  }

  console.log("[sendEmails] done");
}

// ── Email templates ───────────────────────────────────────────────────────────

function buildOwnerEmail({ clientName, displayComp, downloadButtons }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Testimonial Ready</title></head>
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
              <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:#c8a96e;text-transform:uppercase;letter-spacing:0.1em;">Testimonial Ready</p>
              <h1 style="margin:0 0 16px;font-size:26px;font-weight:400;color:#0e0e0e;line-height:1.25;">
                Your testimonial from <em>${clientName}</em> is ready
              </h1>
              <p style="margin:0 0 28px;font-size:15px;color:#7a7060;line-height:1.6;">
                The video has been processed and is ready to download in three formats — landscape for YouTube and web, portrait for Instagram and TikTok, and square for LinkedIn and Facebook.
              </p>
              <div style="margin-bottom:28px;">${downloadButtons || "<p style=\"color:#888;\">Log in to your Vouch dashboard to access the processed videos.</p>"}</div>
              <p style="margin:0;font-size:12px;color:#aaa;line-height:1.6;">
                You can also find these videos in your Vouch dashboard under the testimonial from ${clientName}.
              </p>
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #ede8dc;">
            <tr><td style="padding:18px 44px;text-align:center;">
              <p style="margin:0;font-size:11px;color:#bbb;">Sent via <span style="color:#c8a96e;">Vouch</span> &middot; ${displayComp}</p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function buildClientEmail({ clientName, displayComp }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Thank you!</title></head>
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
              <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:#c8a96e;text-transform:uppercase;letter-spacing:0.1em;">Thank You!</p>
              <h1 style="margin:0 0 16px;font-size:26px;font-weight:400;color:#0e0e0e;line-height:1.25;">
                Hi ${clientName}, your testimonial is being reviewed
              </h1>
              <p style="margin:0 0 24px;font-size:15px;color:#7a7060;line-height:1.6;">
                Thank you for recording your testimonial for <strong>${displayComp}</strong>. It's now being reviewed and will be live soon — your words will help others make a great decision.
              </p>
              <p style="margin:0;font-size:14px;color:#7a7060;line-height:1.6;">
                Thanks again for sharing your experience. It means a lot!
              </p>
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #ede8dc;">
            <tr><td style="padding:18px 44px;text-align:center;">
              <p style="margin:0;font-size:11px;color:#bbb;">Sent via <span style="color:#c8a96e;">Vouch</span> on behalf of ${displayComp}</p>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
