"use strict";

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin  = require("firebase-admin");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const fetch  = require("node-fetch");
const { Anthropic } = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const os   = require("os");
const path = require("path");
const fs   = require("fs");

admin.initializeApp();
ffmpeg.setFfmpegPath(ffmpegPath);

const db      = admin.firestore();
const storage = admin.storage();

// Clients are instantiated lazily inside the handler so that secrets are
// resolved from process.env at call time (Firebase Functions v2 populates
// secrets into process.env only after the function is invoked).
function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}
function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// ── processTestimonial ────────────────────────────────────────────────────────
// Fires whenever a new testimonial document is written to Firestore.
// Steps: processing → download videos → transcribe with Claude →
//        select best clip → render 3 formats → upload → notify via email.
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
    if (!snap?.exists) return; // document was deleted

    const data = snap.data();
    const before = event.data?.before;
    const isCreate = !before?.exists;
    const statusBefore = before?.exists ? before.data()?.status : null;

    // Run on initial creation, or when the dashboard resets status to "new"
    // to request reprocessing. Ignore all other updates (status transitions
    // written by this function itself) to avoid infinite loops.
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

      // ── 3. Get client email (from testimonial or linked invite) ──────────
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
      const videoURLs   = data.videoURLs || {};
      const videoEntries = Object.entries(videoURLs).filter(([, url]) => url);

      if (videoEntries.length === 0) {
        console.log("[processTestimonial] no videos — skipping video processing");
        await testimonialRef.update({ status: "processed", processedAt: Date.now(), processedVideoURLs: {} });
        await sendCompletionEmails({ ownerEmail, clientEmail, data, companyName, processedVideoURLs: {} });
        return;
      }

      const tmpDir = os.tmpdir();

      // ── 5. Download source videos from Firebase Storage ──────────────────
      console.log(`[processTestimonial] downloading ${videoEntries.length} video(s)`);
      const localVideos = {};
      for (const [qIdx, url] of videoEntries) {
        const localPath = path.join(tmpDir, `${testimonialId}_q${qIdx}_src.webm`);
        await downloadFile(url, localPath);
        const dlSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
        localVideos[qIdx] = localPath;
        console.log(`[processTestimonial] downloaded Q${qIdx} → ${localPath} (${(dlSize / 1024).toFixed(0)} KB)`);
        if (dlSize < 1024) console.warn(`[processTestimonial] ⚠ Q${qIdx} source file suspiciously small: ${dlSize} bytes`);
      }

      // ── 6. Extract audio and transcribe with Claude ──────────────────────
      const anthropic   = getAnthropic();
      const transcripts = {};

      for (const [qIdx, localPath] of Object.entries(localVideos)) {
        const audioPath = path.join(tmpDir, `${testimonialId}_q${qIdx}.mp3`);
        try {
          // Extract up to 45 s of audio at low bitrate so the base64 payload stays small
          await extractAudio(localPath, audioPath, 45);

          const audioBuffer = fs.readFileSync(audioPath);
          // Skip transcription if file > 4 MB (base64 would exceed API limits)
          if (audioBuffer.length > 4 * 1024 * 1024) {
            console.warn(`[processTestimonial] audio for Q${qIdx} too large (${audioBuffer.length} bytes) — using text answer`);
            transcripts[qIdx] = data.answers?.[qIdx] || "";
          } else {
            const audioBase64 = audioBuffer.toString("base64");
            const response = await anthropic.messages.create({
              model: "claude-opus-4-6",
              max_tokens: 512,
              messages: [{
                role: "user",
                content: [
                  {
                    type: "audio",
                    source: {
                      type: "base64",
                      media_type: "audio/mpeg",
                      data: audioBase64,
                    },
                  },
                  {
                    type: "text",
                    text: "Transcribe this audio exactly as spoken. Return only the transcript text with no commentary or labels.",
                  },
                ],
              }],
            });
            transcripts[qIdx] = response.content[0]?.text || data.answers?.[qIdx] || "";
            console.log(`[processTestimonial] transcribed Q${qIdx}: "${transcripts[qIdx].substring(0, 80)}..."`);
          }
        } catch (e) {
          console.warn(`[processTestimonial] transcription failed for Q${qIdx}:`, e.message);
          // Fall back to typed answer
          transcripts[qIdx] = data.answers?.[qIdx] || "";
        } finally {
          try { fs.unlinkSync(audioPath); } catch {}
        }
      }

      // ── 7. Ask Claude to select the best clip ────────────────────────────
      const fullTranscript = Object.entries(transcripts)
        .filter(([, t]) => t)
        .map(([i, t]) => `Question ${Number(i) + 1}: ${t}`)
        .join("\n\n");

      // ── 7a. Generate testimonial quote from transcript ───────────────────
      let generatedQuote = data.quote && data.quote !== "Processing transcript..." ? data.quote : "";
      if (fullTranscript.trim()) {
        try {
          const quoteResponse = await anthropic.messages.create({
            model: "claude-opus-4-6",
            max_tokens: 200,
            messages: [{
              role: "user",
              content: `Here is a transcript from a video testimonial. Extract the most compelling quote or create a short polished testimonial from what they said. Return just the quote, 1-3 sentences, in first person, no quotation marks needed.\n\n${fullTranscript}`,
            }],
          });
          generatedQuote = quoteResponse.content[0]?.text?.trim() || generatedQuote;
          console.log(`[processTestimonial] generated quote: "${generatedQuote.substring(0, 100)}..."`);
        } catch (e) {
          console.warn("[processTestimonial] quote generation failed:", e.message);
        }
      }

      let clipSpec = null;
      if (fullTranscript.trim()) {
        try {
          const clipResponse = await anthropic.messages.create({
            model: "claude-opus-4-6",
            max_tokens: 256,
            messages: [{
              role: "user",
              content: `You are selecting the best short clip from a customer testimonial for marketing use.

Transcript:
${fullTranscript}

Pick the single most compelling 15–35 second excerpt. Respond with JSON only, no markdown:
{"questionIndex":0,"startSeconds":5,"endSeconds":30,"reason":"brief reason"}`,
            }],
          });
          const jsonMatch = clipResponse.content[0]?.text?.match(/\{[\s\S]*?\}/);
          if (jsonMatch) clipSpec = JSON.parse(jsonMatch[0]);
          console.log("[processTestimonial] clip spec:", clipSpec);
        } catch (e) {
          console.warn("[processTestimonial] clip selection failed:", e.message);
        }
      }

      // Defaults if Claude didn't return a usable spec
      const primaryQIdx  = clipSpec?.questionIndex ?? 0;
      const primaryVideo = localVideos[primaryQIdx] ?? Object.values(localVideos)[0];
      const startSec     = Math.max(0, clipSpec?.startSeconds ?? 0);
      const endSec       = clipSpec?.endSeconds ?? Math.min(startSec + 30, 60);
      const duration     = Math.max(5, endSec - startSec);

      const captionText  = safeForDrawtext(
        transcripts[primaryQIdx] || data.quote || "",
        72,
      );
      const clientName   = safeForDrawtext(data.clientName || "", 40);

      // ── 8. Render 3 formats with FFmpeg ──────────────────────────────────
      const formats = [
        { name: "landscape", width: 1920, height: 1080 },
        { name: "portrait",  width: 1080, height: 1920 },
        { name: "square",    width: 1080, height: 1080 },
      ];

      const processedVideoURLs = {};
      const bucket = storage.bucket();

      for (const fmt of formats) {
        const outputPath = path.join(tmpDir, `${testimonialId}_${fmt.name}.mp4`);
        console.log(`[processTestimonial] rendering ${fmt.name} (${fmt.width}x${fmt.height})`);

        await processVideoFormat({
          inputPath: primaryVideo,
          outputPath,
          startSec,
          duration,
          width: fmt.width,
          height: fmt.height,
        });

        // Verify output before upload
        const uploadSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
        console.log(`[processTestimonial] pre-upload size check — ${fmt.name}: ${(uploadSize / 1024).toFixed(0)} KB`);
        if (uploadSize < 1024 * 1024) {
          console.warn(`[processTestimonial] ⚠ ${fmt.name} output is < 1 MB — skipping upload of likely-corrupt file`);
          continue;
        }

        // Upload — public so download URLs never expire
        const storagePath = `users/${userId}/processed/${testimonialId}/${fmt.name}.mp4`;
        await bucket.upload(outputPath, {
          destination: storagePath,
          metadata: { contentType: "video/mp4", cacheControl: "public, max-age=31536000" },
          public: true,
        });

        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
        processedVideoURLs[fmt.name] = { url: publicUrl, storagePath };
        console.log(`[processTestimonial] uploaded ${fmt.name} → ${publicUrl}`);

        try { fs.unlinkSync(outputPath); } catch {}
      }

      // Clean up source videos
      for (const p of Object.values(localVideos)) {
        try { fs.unlinkSync(p); } catch {}
      }

      // ── 9. Update Firestore ──────────────────────────────────────────────
      await testimonialRef.update({
        status: "processed",
        processedAt: Date.now(),
        processedVideoURLs,
        transcripts,
        selectedClip: clipSpec,
        ...(generatedQuote ? { quote: generatedQuote } : {}),
      });
      console.log("[processTestimonial] Firestore updated — status: processed");

      // ── 10. Send completion emails ───────────────────────────────────────
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

/** Extract audio from a video file as MP3, capped at maxSeconds. */
function extractAudio(inputPath, outputPath, maxSeconds = 45) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate(64)
      .duration(maxSeconds)
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

/**
 * Strip characters that would break FFmpeg's drawtext filter and truncate.
 * Only allow printable ASCII minus shell-special chars.
 */
function safeForDrawtext(str, maxLen) {
  return (str || "")
    .replace(/[^a-zA-Z0-9 .,!?'"&()\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, maxLen)
    .trim();
}

/**
 * Render one output format using FFmpeg.
 *
 * Key design decisions:
 *   - Output-side -ss (not input-side seekInput): browser-recorded WebM files
 *     have no seek index, so input-side -ss can't find a keyframe and produces
 *     near-empty output (the 0.574-second / 100 KB corruption symptom).
 *     Output-side -ss decodes from the start and discards frames up to startSec,
 *     which is slower but reliable with any container format.
 *   - Simplified filter chain (scale+pad only): drawtext/drawbox are removed
 *     to eliminate font-not-found failures on Cloud Functions and reduce
 *     encoding complexity while diagnosing.
 *   - Full stderr capture so Cloud Function logs show exactly what FFmpeg did.
 */
function processVideoFormat({ inputPath, outputPath, startSec, duration, width, height }) {
  return new Promise((resolve, reject) => {
    const stderrLines = [];

    const srcSize = fs.existsSync(inputPath) ? fs.statSync(inputPath).size : 0;
    console.log(`[FFmpeg] encode start — ${path.basename(outputPath)} | ${width}x${height} | startSec:${startSec} duration:${duration}s | src:${(srcSize / 1024).toFixed(0)} KB`);

    const vf = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    ].join(",");

    const outputOpts = [
      `-t ${duration}`,
      `-crf 23`,
      `-preset fast`,
      `-movflags +faststart`,
    ];
    // Output-side seek: decode from 0, discard frames before startSec.
    // Must come before -t so -t counts from the seek point, not from 0.
    if (startSec > 0) outputOpts.unshift(`-ss ${startSec}`);

    ffmpeg(inputPath)
      .videoFilter(vf)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions(outputOpts)
      .on("stderr", line => {
        stderrLines.push(line);
        // Surface frame-progress and error lines without flooding logs
        if (/frame=|fps=|error|Error|invalid|Invalid/i.test(line)) {
          console.log("[FFmpeg stderr]", line);
        }
      })
      .on("end", () => {
        const outSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
        const outKB = (outSize / 1024).toFixed(0);
        console.log(`[FFmpeg] ✅ done — ${path.basename(outputPath)} — ${outKB} KB`);
        if (outSize < 1024 * 1024) {
          console.warn(`[FFmpeg] ⚠ output < 1 MB (${outKB} KB) — full FFmpeg stderr:\n${stderrLines.join("\n")}`);
        }
        resolve();
      })
      .on("error", err => {
        console.error(`[FFmpeg] ❌ failed — ${err.message}`);
        console.error(`[FFmpeg] full stderr:\n${stderrLines.join("\n")}`);
        reject(err);
      })
      .save(outputPath);
  });
}

/** Send the two completion emails via Resend. */
async function sendCompletionEmails({ ownerEmail, clientEmail, data, companyName, processedVideoURLs }) {
  console.log("[sendEmails] called — ownerEmail:", ownerEmail, "| clientEmail:", clientEmail, "| RESEND_API_KEY present:", !!process.env.RESEND_API_KEY, "| video formats:", Object.keys(processedVideoURLs));

  const resend      = getResend();
  const clientName  = data.clientName || "Your client";
  const displayComp = companyName || "your company";

  const downloadButtons = Object.entries(processedVideoURLs)
    .map(([fmt, { url }]) => {
      const label = fmt === "landscape" ? "16:9 Landscape"
        : fmt === "portrait" ? "9:16 Portrait"
        : "1:1 Square";
      return `<a href="${url}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 20px;background:#c8a96e;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">${label}</a>`;
    })
    .join("");

  console.log("[sendEmails] download buttons generated:", downloadButtons ? `${Object.keys(processedVideoURLs).length} format(s)` : "none (text-only testimonial)");

  // ── Owner notification email ─────────────────────────────────────────────────
  if (ownerEmail) {
    console.log("[sendEmails] sending owner notification email to:", ownerEmail);
    try {
      // Resend SDK v3 returns { data, error } instead of throwing on API errors
      const { data: emailData, error: emailError } = await resend.emails.send({
        from: "Vouch <hello@vouchbusiness.com>",
        to: [ownerEmail],
        subject: `Your testimonial from ${clientName} is ready to download`,
        html: buildOwnerEmail({ clientName, displayComp, downloadButtons }),
      });
      if (emailError) {
        console.error("[sendEmails] ❌ owner email API error:", JSON.stringify(emailError));
      } else {
        console.log("[sendEmails] ✅ owner email sent — Resend id:", emailData?.id);
      }
    } catch (e) {
      console.error("[sendEmails] ❌ owner email unexpected error:", e.message);
    }
  } else {
    console.warn("[sendEmails] skipping owner email — no ownerEmail resolved for this userId");
  }

  // ── Client thank-you email ───────────────────────────────────────────────────
  if (clientEmail) {
    console.log("[sendEmails] sending client thank-you email to:", clientEmail);
    try {
      const { data: emailData, error: emailError } = await resend.emails.send({
        from: `${displayComp} via Vouch <hello@vouchbusiness.com>`,
        to: [clientEmail],
        subject: `Thank you for your testimonial, ${clientName}!`,
        html: buildClientEmail({ clientName, displayComp }),
      });
      if (emailError) {
        console.error("[sendEmails] ❌ client email API error:", JSON.stringify(emailError));
      } else {
        console.log("[sendEmails] ✅ client email sent — Resend id:", emailData?.id);
      }
    } catch (e) {
      console.error("[sendEmails] ❌ client email unexpected error:", e.message);
    }
  } else {
    console.log("[sendEmails] no clientEmail — skipping client thank-you");
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
