const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const app = express();
app.use(express.json({ limit: '10mb' }));

const COBALT_URL = process.env.COBALT_UPSTREAM_URL || 'https://cobalt-production-a07d.up.railway.app';
const PORT = process.env.PORT || 3000;

let NODE_PATH = '/usr/local/bin/node';
try { NODE_PATH = execSync('which node').toString().trim(); } catch (e) {}
console.log(`[startup] Node path: ${NODE_PATH}`);

const COOKIES_FILE = path.join(os.tmpdir(), 'yt-cookies.txt');
if (process.env.YOUTUBE_COOKIES_B64) {
  try {
    const decoded = Buffer.from(process.env.YOUTUBE_COOKIES_B64, 'base64').toString('utf8');
    fs.writeFileSync(COOKIES_FILE, decoded);
    console.log('[startup] Cookies written to', COOKIES_FILE);
  } catch (e) {
    console.error('[startup] Failed to write cookies:', e.message);
  }
} else {
  console.warn('[startup] No YOUTUBE_COOKIES_B64 set');
}

const MAX_CONCURRENT = 1;
const MAX_QUEUE = 3;
let activeJobs = 0;
const jobQueue = [];

function runWithConcurrencyLimit(fn) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (activeJobs < MAX_CONCURRENT) {
        activeJobs++;
        Promise.resolve().then(fn).then(resolve).catch(reject).finally(() => {
          activeJobs--;
          if (jobQueue.length > 0) jobQueue.shift()();
        });
      } else {
        jobQueue.push(attempt);
      }
    };
    attempt();
  });
}

function buildYtDlpCmd(videoId, outFile) {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cookiesArg = fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';
  return [
    'yt-dlp',
    '-x',
    '--audio-format mp3',
    '--audio-quality 5',
    `-o "${outFile}"`,
    '--no-playlist',
    '--no-check-certificates',
    '--age-limit 99',
    `--js-runtimes "node:${NODE_PATH}"`,
    '--extractor-args "youtube:player_client=tv_embedded,web_creator,mweb"',
    cookiesArg,
    `"${ytUrl}"`,
  ].filter(Boolean).join(' ');
}

app.post('/download', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  try {
    const cobaltRes = await fetch(`${COBALT_URL}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, downloadMode: 'audio', audioFormat: 'mp3' }),
    });
    const data = await cobaltRes.json();
    if (data.url) return res.json({ url: data.url });
    return res.status(502).json({ error: 'Cobalt no URL', detail: data });
  } catch (err) {
    console.error('[cobalt] Error:', err.message);
    return res.status(502).json({ error: err.message });
  }
});

app.post('/ytdlp', async (req, res) => {
  const { videoId, callbackUrl } = req.body;
  if (!videoId || !callbackUrl) return res.status(400).json({ error: 'videoId and callbackUrl required' });
  if (jobQueue.length >= MAX_QUEUE) {
    console.warn(`[ytdlp] Queue full, rejecting ${videoId}`);
    return res.status(429).json({ error: 'queue_full' });
  }
  res.status(202).json({ status: 'queued', videoId });
  runWithConcurrencyLimit(async () => {
    const outFile = path.join(os.tmpdir(), `${videoId}_${Date.now()}.mp3`);
    const cmd = buildYtDlpCmd(videoId, outFile);
    console.log(`[ytdlp] Starting: ${videoId}`);
    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 300000 }, async (err, stdout, stderr) => {
        if (err) {
          console.error(`[ytdlp] FAILED ${videoId}:`, stderr?.slice(0, 400) || err.message);
          try {
            await fetch(callbackUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoId, error: err.message }),
            });
          } catch (_) {}
          return reject(err);
        }
        console.log(`[ytdlp] Done: ${videoId}`);
        try {
          const audioData = fs.readFileSync(outFile);
          const base64Audio = audioData.toString('base64');
          console.log(`[ytdlp] Sending callback: ${videoId}, ${audioData.length} bytes`);
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId, audio: base64Audio }),
          });
          console.log(`[ytdlp] Callback sent: ${videoId}`);
        } catch (cbErr) {
          console.error('[ytdlp] Callback error:', cbErr.message);
        } finally {
          try { fs.unlinkSync(outFile); } catch (_) {}
        }
        resolve();
      });
    });
  }).catch(err => console.error(`[ytdlp] Job error ${videoId}:`, err.message));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeJobs, queueLength: jobQueue.length, cookiesLoaded: fs.existsSync(COOKIES_FILE) });
});

app.listen(PORT, () => console.log(`cobalt-audio-proxy listening on port ${PORT}`));
