// Required env vars: FIREBASE_SERVICE_ACCOUNT_KEY, OPENAI_API_KEY

const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
        return reject({ noFile: true });
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, testimonialId, questionIndex } = req.body || {};
  if (!userId || !testimonialId || questionIndex === undefined) {
    return res.status(400).json({ error: 'Missing userId, testimonialId, or questionIndex' });
  }

  const db = getDb();
  const docRef = db.collection('users').doc(userId).collection('testimonials').doc(testimonialId);

  const snap = await docRef.get();
  const data = snap.exists ? snap.data() : {};
  const cached = data.transcripts && data.transcripts[String(questionIndex)];
  if (cached && cached.text) {
    return res.json({ success: true, transcript: cached.text, cached: true });
  }

  const bucket = 'vouch-cdf1c.firebasestorage.app';
  const url = `https://storage.googleapis.com/${bucket}/users/${userId}/processed/${testimonialId}/q${questionIndex}.mp4`;
  const tmpPath = path.join('/tmp', `${testimonialId}_q${questionIndex}_${Date.now()}.mp4`);

  try {
    await downloadFile(url, tmpPath);
  } catch (err) {
    if (err && err.noFile) return res.json({ success: false, reason: 'no_file' });
    return res.status(500).json({ error: err.message || 'Download failed' });
  }

  let transcript;
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const result = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(tmpPath),
    });
    transcript = result.text;
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Whisper transcription failed' });
  } finally {
    fs.unlink(tmpPath, () => {});
  }

  await docRef.set({
    transcripts: {
      [String(questionIndex)]: { text: transcript, createdAt: Date.now() },
    },
  }, { merge: true });

  return res.json({ success: true, transcript });
}

module.exports = handler;
module.exports.maxDuration = 60;
