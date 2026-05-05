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
// ffprobe lives alongside ffmpeg in the @ffmpeg-installer static build
ffmpeg.setFfprobePath(ffmpegPath.replace(/ffmpeg(\.exe)?$/, (_, ext) => `ffprobe${ext || ""}`));

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
        .sort(([a], [b]) => Number(a) - Number(b));  // ensure Q0, Q1, Q2... order

      if (videoEntries.length === 0) {
        console.log("[processTestimonial] no videos — skipping video processing");
        await testimonialRef.update({ status: "processed", processedAt: Date.now(), processedVideoURLs: {} });
        await sendCompletionEmails({ ownerEmail, clientEmail, data, companyName, processedVideoURLs: {} });
        return;
      }

      const tmpDir = os.tmpdir();

      // ── 5. Download source WebM files ────────────────────────────────────
      console.log(`[processTestimonial] downloading ${videoEntries.length} video(s)`);
      const localWebms = {};  // { "0": "/tmp/..._q0_src.webm", ... }

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

      // ── 6. Probe + normalize each clip to 1920×1080 30fps 44100Hz stereo ──
      // Uniform specs are required for concat -c copy to work correctly.
      const normalizedPaths = {};  // { "0": "/tmp/..._q0_norm.mp4", ... }

      for (const [qIdx, srcPath] of Object.entries(localWebms)) {
        const normPath = path.join(tmpDir, `${testimonialId}_q${qIdx}_norm.mp4`);

        // Probe the actual file format before choosing an encode strategy
        let probeInfo = null;
        try {
          probeInfo = await probeVideo(srcPath);
          const vs = probeInfo.streams.find(s => s.codec_type === "video");
          const as = probeInfo.streams.find(s => s.codec_type === "audio");
          console.log(
            `[processTestimonial] Q${qIdx} probe — ` +
            `format: ${probeInfo.format?.format_name} | ` +
            `video: ${vs?.codec_name ?? "none"} ${vs?.width}x${vs?.height} | ` +
            `audio: ${as?.codec_name ?? "none"} ${as?.sample_rate}Hz`,
          );
        } catch (e) {
          console.warn(`[processTestimonial] ⚠ Q${qIdx} probe failed (will still attempt normalize): ${e.message}`);
        }

        try {
          await normalizeClipRobust(srcPath, normPath, probeInfo);
          const normSize = fs.existsSync(normPath) ? fs.statSync(normPath).size : 0;
          console.log(`[processTestimonial] Q${qIdx} normalized — ${(normSize / 1024 / 1024).toFixed(2)} MB`);
          if (normSize < 1024 * 1024) {
            console.warn(`[processTestimonial] ⚠ Q${qIdx} normalized output < 1 MB — skipping`);
          } else {
            normalizedPaths[qIdx] = normPath;
          }
        } catch (e) {
          console.error(`[processTestimonial] ❌ normalize failed Q${qIdx}: ${e.message}`);
        }
      }

      if (Object.keys(normalizedPaths).length === 0) {
        throw new Error("All normalizations failed — nothing to merge");
      }

      // ── 7. Concat-merge normalized clips ─────────────────────────────────
      const orderedNormPaths = Object.entries(normalizedPaths)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, p]) => p);

      let mergedPath;

      if (orderedNormPaths.length === 1) {
        // Only one clip — skip the merge step entirely
        mergedPath = orderedNormPaths[0];
        console.log(`[processTestimonial] single clip — skipping concat, using ${path.basename(mergedPath)} as merged`);
      } else {
        const concatOutputPath = path.join(tmpDir, `${testimonialId}_merged.mp4`);
        try {
          await concatMerge(orderedNormPaths, concatOutputPath);
          const mergedSize = fs.existsSync(concatOutputPath) ? fs.statSync(concatOutputPath).size : 0;
          console.log(`[processTestimonial] merged — ${(mergedSize / 1024 / 1024).toFixed(2)} MB`);
          if (mergedSize < 2 * 1024 * 1024) {
            console.warn(`[processTestimonial] ⚠ merged output < 2 MB`);
          }
          mergedPath = concatOutputPath;
        } catch (e) {
          console.error(`[processTestimonial] ❌ concat failed: ${e.message} — falling back to Q0`);
          mergedPath = normalizedPaths["0"] ?? orderedNormPaths[0];
        }
      }

      const bucket = storage.bucket();
      const processedVideoURLs = {};

      // ── 8. Resize merged to landscape / portrait / square ────────────────
      const outputFormats = [
        { name: "landscape", width: 1920, height: 1080 },
        { name: "portrait",  width: 1080, height: 1920 },
        { name: "square",    width: 1080, height: 1080 },
      ];

      for (const fmt of outputFormats) {
        const outputPath = path.join(tmpDir, `${testimonialId}_${fmt.name}.mp4`);
        try {
          await resizeVideo({ inputPath: mergedPath, outputPath, width: fmt.width, height: fmt.height });

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
          console.error(`[processTestimonial] ❌ ${fmt.name} render/upload failed: ${e.message}`);
        } finally {
          try { fs.unlinkSync(outputPath); } catch {}
        }
      }

      // ── 9. Upload individual normalized question files ───────────────────
      for (const [qIdx, normPath] of Object.entries(normalizedPaths)) {
        try {
          const uploadSize = fs.existsSync(normPath) ? fs.statSync(normPath).size : 0;
          if (uploadSize < 1024 * 1024) {
            console.warn(`[processTestimonial] ⚠ q${qIdx}.mp4 < 1 MB — skipping upload`);
            continue;
          }
          const storagePath = `users/${userId}/processed/${testimonialId}/q${qIdx}.mp4`;
          await bucket.upload(normPath, {
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

      // ── 10. Cleanup /tmp ─────────────────────────────────────────────────
      const allTmpFiles = [
        ...Object.values(localWebms),
        ...Object.values(normalizedPaths),
        path.join(tmpDir, `${testimonialId}_merged.mp4`),
      ];
      for (const p of allTmpFiles) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
      }

      // ── 11. Update Firestore ─────────────────────────────────────────────
      await testimonialRef.update({
        status: "processed",
        processedAt: Date.now(),
        processedVideoURLs,
      });
      console.log(`[processTestimonial] done — uploaded formats: ${Object.keys(processedVideoURLs).join(", ")}`);

      // ── 12. Send completion emails ───────────────────────────────────────
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

/** Run ffprobe on a file and return the parsed metadata object. */
function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}

/**
 * Normalize any video to a consistent spec for concat:
 *   1920×1080, 30 fps, libx264/aac, 44100 Hz stereo, faststart.
 *
 * Tries three strategies in order, stopping at the first one that produces
 * a file ≥ 1 MB. Logs the full FFmpeg stderr on every failure.
 *
 * Strategy order:
 *   1. Full re-encode — libx264 + aac (handles WebM, VP8/VP9, missing keyframes)
 *   2. Copy video + re-encode audio — faster when video is already H.264
 *   3. Copy both streams — last resort remux
 */
async function normalizeClipRobust(inputPath, outputPath, probeInfo) {
  const srcMB = (fs.existsSync(inputPath) ? fs.statSync(inputPath).size : 0) / 1024 / 1024;
  console.log(`[normalize] ${path.basename(inputPath)} → ${path.basename(outputPath)} | input: ${srcMB.toFixed(2)} MB`);

  const vs = probeInfo?.streams?.find(s => s.codec_type === "video");
  const as = probeInfo?.streams?.find(s => s.codec_type === "audio");
  const videoCodec = vs?.codec_name ?? "unknown";
  const audioCodec = as?.codec_name ?? "unknown";
  const isH264  = videoCodec === "h264";
  const isAAC   = audioCodec === "aac";

  // Scale+pad filter used by attempts that re-encode video
  const VF = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1";

  const attempts = [
    {
      label: "full re-encode libx264+aac",
      vf: VF,
      videoCodec: "libx264",
      audioCodec: "aac",
      extraOpts: ["-r 30", "-ar 44100", "-ac 2", "-preset fast", "-crf 23", "-movflags +faststart"],
    },
    {
      // Skip if already H.264 — copy video saves time and avoids re-encode quality loss
      label: "copy video + encode aac audio",
      skip: !isH264,
      vf: null,
      videoCodec: "copy",
      audioCodec: "aac",
      extraOpts: ["-ar 44100", "-ac 2", "-movflags +faststart"],
    },
    {
      label: "copy both streams (remux only)",
      vf: null,
      videoCodec: "copy",
      audioCodec: "copy",
      extraOpts: ["-movflags +faststart"],
    },
  ];

  for (const attempt of attempts) {
    if (attempt.skip) {
      console.log(`[normalize] skipping "${attempt.label}" (not applicable)`);
      continue;
    }
    // Remove any partial output before each attempt
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}

    console.log(`[normalize] trying: ${attempt.label}`);
    try {
      await runNormalize(inputPath, outputPath, attempt);
      const outSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      if (outSize >= 1024 * 1024) {
        console.log(`[normalize] ✅ succeeded — ${attempt.label} | output: ${(outSize / 1024 / 1024).toFixed(2)} MB`);
        return;
      }
      console.warn(`[normalize] ⚠ "${attempt.label}" produced ${outSize} bytes (< 1 MB) — trying next`);
    } catch (e) {
      console.warn(`[normalize] ❌ "${attempt.label}" threw: ${e.message}`);
    }
  }

  throw new Error(`All normalization attempts failed for ${path.basename(inputPath)} (video:${videoCodec} audio:${audioCodec})`);
}

/** Low-level FFmpeg encode call used by normalizeClipRobust. */
function runNormalize(inputPath, outputPath, { vf, videoCodec, audioCodec, extraOpts }) {
  return new Promise((resolve, reject) => {
    const stderrLines = [];
    let cmd = ffmpeg(inputPath);

    if (vf) cmd = cmd.videoFilter(vf);

    cmd
      .videoCodec(videoCodec)
      .audioCodec(audioCodec)
      .outputOptions(extraOpts)
      .on("stderr", line => {
        stderrLines.push(line);
        // Always log progress lines + anything that looks like an error
        if (/frame=|fps=|error|Error|invalid|corrupt|failed/i.test(line)) {
          console.log("[FFmpeg stderr]", line);
        }
      })
      .on("end", () => {
        const outMB = (fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0) / 1024 / 1024;
        console.log(`[FFmpeg] end — ${path.basename(outputPath)} ${outMB.toFixed(2)} MB`);
        if (outMB < 1) {
          // Dump full stderr so we can see exactly what went wrong
          console.error(`[FFmpeg] ⚠ output < 1 MB. Full stderr:\n${stderrLines.join("\n")}`);
        }
        resolve();
      })
      .on("error", err => {
        console.error(`[FFmpeg] ❌ ${err.message}\nFull stderr:\n${stderrLines.join("\n")}`);
        reject(err);
      })
      .save(outputPath);
  });
}

/**
 * Concatenate normalized MP4 clips using the concat demuxer with -c copy.
 * All inputs must share the same codec/resolution/fps (guaranteed by normalizeClip).
 */
function concatMerge(inputPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const concatTxt = outputPath + ".txt";
    fs.writeFileSync(concatTxt, inputPaths.map(p => `file '${p}'`).join("\n"));
    console.log(`[FFmpeg] concat — merging ${inputPaths.length} clips → ${path.basename(outputPath)}`);
    inputPaths.forEach((p, i) => {
      const mb = (fs.existsSync(p) ? fs.statSync(p).size : 0) / 1024 / 1024;
      console.log(`[FFmpeg] concat input[${i}]: ${path.basename(p)} — ${mb.toFixed(2)} MB`);
    });

    const stderrLines = [];
    ffmpeg()
      .input(concatTxt)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy", "-movflags +faststart"])
      .on("stderr", line => {
        stderrLines.push(line);
        if (/frame=|fps=|error|Error/i.test(line)) console.log("[FFmpeg stderr]", line);
      })
      .on("end", () => {
        try { fs.unlinkSync(concatTxt); } catch {}
        const outMB = (fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0) / 1024 / 1024;
        console.log(`[FFmpeg] ✅ concat ${path.basename(outputPath)} — output: ${outMB.toFixed(2)} MB`);
        if (outMB < 2) {
          console.warn(`[FFmpeg] ⚠ merged output < 2 MB. stderr:\n${stderrLines.slice(-20).join("\n")}`);
        }
        resolve();
      })
      .on("error", err => {
        try { fs.unlinkSync(concatTxt); } catch {}
        console.error(`[FFmpeg] ❌ concat: ${err.message}\nstderr:\n${stderrLines.slice(-20).join("\n")}`);
        reject(err);
      })
      .save(outputPath);
  });
}

/**
 * Resize a video to target dimensions with scale+pad+setsar.
 * No seeking, no trimming, no drawtext.
 * Logs input and output sizes in MB.
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
      .outputOptions(["-preset fast", "-crf 23", "-movflags +faststart"])
      .on("stderr", line => {
        stderrLines.push(line);
        if (/frame=|fps=|error|Error/i.test(line)) console.log("[FFmpeg stderr]", line);
      })
      .on("end", () => {
        const outMB = (fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0) / 1024 / 1024;
        console.log(`[FFmpeg] ✅ resize ${path.basename(outputPath)} — output: ${outMB.toFixed(2)} MB`);
        if (outMB < 1) {
          console.error(`[FFmpeg] ❌ resize output < 1 MB — likely corrupt. stderr:\n${stderrLines.slice(-20).join("\n")}`);
        }
        resolve();
      })
      .on("error", err => {
        console.error(`[FFmpeg] ❌ resize ${path.basename(outputPath)}: ${err.message}\nstderr:\n${stderrLines.slice(-20).join("\n")}`);
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

  // Only show landscape/portrait/square in the email, not the raw q files
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
