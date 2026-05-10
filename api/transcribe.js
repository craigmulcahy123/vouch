// Required env vars: FIREBASE_SERVICE_ACCOUNT_KEY, OPENAI_API_KEY

console.log('[transcribe] module loading...');
const admin = require('firebase-admin');
console.log('[transcribe] firebase-admin loaded');
const { OpenAI } = require('openai');
console.log('[transcribe] openai loaded');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
console.log('[transcribe] all imports loaded');

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

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    client.get(url, res => {
      if (res.statusCode === 404 || res.statusCode === 403) {
        file.close();
        fs.unlink(dest, () => {});
        return reject({ noFile: true, statusCode: res.statusCode });
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} downloading file`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

async function handler(req, res) {
  try {
    console.log('[transcribe] Function started, OPENAI_API_KEY present:', !!process.env.OPENAI_API_KEY);
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── Log env var presence (not values) ──────────────────────────────────
    console.log('[transcribe] env check:', {
      FIREBASE_SERVICE_ACCOUNT_KEY: !!process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    });

    const { userId, testimonialId, questionIndex } = req.body || {};
    console.log('[transcribe] request:', { userId, testimonialId, questionIndex });

    if (!userId || !testimonialId || questionIndex === undefined) {
      return res.status(400).json({ success: false, error: 'Missing userId, testimonialId, or questionIndex' });
    }

    // ── Firestore cache check ───────────────────────────────────────────────
    let db;
    try {
      db = getDb();
      console.log('[transcribe] Firestore initialised');
    } catch (err) {
      console.error('[transcribe] Firestore init failed:', err.message, err.stack);
      return res.status(500).json({ success: false, error: err.message, stack: err.stack, stage: 'firestore_init' });
    }

    const docRef = db.collection('users').doc(userId).collection('testimonials').doc(testimonialId);

    let snap;
    try {
      snap = await docRef.get();
    } catch (err) {
      console.error('[transcribe] Firestore get failed:', err.message, err.stack);
      return res.status(500).json({ success: false, error: err.message, stack: err.stack, stage: 'firestore_get' });
    }

    const data = snap.exists ? snap.data() : {};
    const cached = data.transcripts && data.transcripts[String(questionIndex)];
    if (cached && cached.text) {
      console.log('[transcribe] returning cached transcript for q' + questionIndex);
      return res.json({ success: true, transcript: cached.text, cached: true });
    }

    // ── Download MP4 from Firebase Storage ─────────────────────────────────
    const bucket = 'vouch-cdf1c.firebasestorage.app';
    const storageUrl = `https://storage.googleapis.com/${bucket}/users/${userId}/processed/${testimonialId}/q${questionIndex}.mp4`;
    const tmpPath = path.join('/tmp', `${testimonialId}_q${questionIndex}_${Date.now()}.mp4`);

    console.log('[transcribe] downloading:', storageUrl);

    try {
      await downloadFile(storageUrl, tmpPath);
      const fileSize = fs.statSync(tmpPath).size;
      console.log('[transcribe] download complete, saved to', tmpPath);
      console.log(`[transcribe] file size: ${fileSize} bytes`);
    } catch (err) {
      if (err && err.noFile) {
        console.log('[transcribe] no file at q' + questionIndex + ' (HTTP ' + err.statusCode + ')');
        return res.json({ success: false, reason: 'no_file' });
      }
      console.error('[transcribe] download failed:', err.message, err.stack);
      return res.status(500).json({ success: false, error: err.message, stack: err.stack, stage: 'download' });
    }

    // ── Whisper transcription ───────────────────────────────────────────────
    let transcript;
    try {
      console.log('[transcribe] sending to Whisper...');

      // Connectivity probe — confirms outbound HTTPS to OpenAI is reachable
      try {
        const probe = await fetch('https://api.openai.com', { method: 'HEAD' });
        console.log('[transcribe] OpenAI connectivity probe status:', probe.status);
      } catch (probeErr) {
        console.error('[transcribe] OpenAI connectivity probe FAILED:', probeErr.message);
      }

      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 55000 });
      const result = await openai.audio.transcriptions.create({
        model: 'whisper-1',
        file: fs.createReadStream(tmpPath),
      });
      transcript = result.text;
      console.log('[transcribe] Whisper done, transcript length:', transcript.length);
    } catch (err) {
      console.error('[transcribe] Whisper failed:', err.message, err.stack);
      return res.status(500).json({ success: false, error: err.message, stack: err.stack, stage: 'whisper' });
    } finally {
      fs.unlink(tmpPath, () => {});
    }

    // ── Store in Firestore ──────────────────────────────────────────────────
    try {
      await docRef.set({
        transcripts: {
          [String(questionIndex)]: { text: transcript, createdAt: Date.now() },
        },
      }, { merge: true });
      console.log('[transcribe] saved transcript to Firestore for q' + questionIndex);
    } catch (err) {
      console.error('[transcribe] Firestore write failed:', err.message, err.stack);
      return res.status(500).json({ success: false, error: err.message, stack: err.stack, stage: 'firestore_write' });
    }

    return res.json({ success: true, transcript });

  } catch (err) {
    // Top-level catch — ensures we always return JSON
    console.error('[transcribe] unhandled error:', err.message, err.stack);
    return res.status(500).json({ success: false, error: err.message, stack: err.stack, stage: 'unhandled' });
  }
}

module.exports = handler;
module.exports.maxDuration = 60;
