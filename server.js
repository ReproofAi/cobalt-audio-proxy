const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const app = express();
app.use(express.json({ limit: '10mb' }));

const COBALT_URL = process.env.COBALT_UPSTREAM_URL || 'https://cobalt-production-a07d.up.railway.app';
const PORT = process.env.PORT || 3000;

// Detect Node.js path for yt-dlp JS runtime
let NODE_PATH = '/usr/local/bin/node';
try {
  NODE_PATH = execSync('which node').toString().trim();
} catch (e) {}
console.log(`[startup] Node.js path for yt-dlp: ${NODE_PATH}`);

// Concurrency limiter — max 2 yt-dlp jobs at once to prevent OOM
let activeJobs = 0;
const MAX_CONCURRENT = 2;
const jobQueue = [];

function runWithConcurrencyLimit(fn) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (activeJobs < MAX_CONCURRENT) {
        activeJobs++;
        Promise.resolve()
          .then(fn)
          .then(resolve)
          .catch(reject)
          .finally(() => {
            activeJobs--;
            if (jobQueue.length > 0) {
              const next = jobQueue.shift();
              next();
            }
          });
      } else {
        jobQueue.push(attempt);
      }
    };
    attempt();
  });
}

// Build yt-dlp command with JS runtime so YouTube extraction works
function buildYtDlpCmd(videoId, outFile) {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  // Pass Node.js as the JS runtime so yt-dlp can extract YouTube formats
  // Also use android_vr player client as fallback which doesn't need JS
  return [
    'yt-dlp',
    '-x',
    '--audio-format mp3',
    '--audio-quality 5',
    `-o "${outFile}"`,
    '--no-playlist',
    `--js-runtimes "node:${NODE_PATH}"`,
    '--extractor-args "youtube:player_client=android_vr,web"',
    `"${ytUrl}"`,
  ].join(' ');
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'cobalt-audio-proxy', activeJobs, queued: jobQueue.length, nodePath: NODE_PATH });
});

// Download proxy: accepts a videoId, calls Cobalt API internally
app.post('/download', async (req, res) => {
  try {
    const { videoId, url: tunnelUrl } = req.body;
    let audioUrl = tunnelUrl;

    if (videoId && !tunnelUrl) {
      const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
      console.log(`[download-proxy] Calling Cobalt for videoId: ${videoId}`);
      const cobaltRes = await fetch(`${COBALT_URL}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ url: youtubeUrl, audioFormat: 'mp3', isAudioOnly: true }),
      });
      const cobaltData = await cobaltRes.json();
      console.log(`[download-proxy] Cobalt response status: ${cobaltData.status}`);
      if (cobaltData.status === 'tunnel' || cobaltData.status === 'redirect' || cobaltData.status === 'stream') {
        audioUrl = cobaltData.url;
      } else {
        return res.status(502).json({ error: `Cobalt returned status: ${cobaltData.status}`, cobaltData });
      }
    }

    if (!audioUrl) return res.status(400).json({ error: 'No URL or videoId provided' });

    const audioRes = await fetch(audioUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!audioRes.ok) return res.status(502).json({ error: `Tunnel fetch failed: ${audioRes.status}` });
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    if (buffer.length === 0) return res.status(502).json({ error: 'Tunnel returned 0 bytes' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    console.error('[download-proxy] Error:', err.message);
    res.status(500).json({ error: err.message?.substring(0, 500) || 'download failed' });
  }
});

// yt-dlp fallback endpoint - async callback pattern with concurrency limiting
app.post('/ytdlp', async (req, res) => {
  const { videoId, callbackUrl, callbackHeaders } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  const outFile = path.join(os.tmpdir(), `${videoId}_${Date.now()}.mp3`);
  const cmd = buildYtDlpCmd(videoId, outFile);

  console.log(`[ytdlp] Queued job for ${videoId} (active: ${activeJobs}/${MAX_CONCURRENT}, queued: ${jobQueue.length})`);

  if (callbackUrl) {
    res.status(202).json({ status: 'accepted', videoId, activeJobs, queued: jobQueue.length });

    runWithConcurrencyLimit(() => new Promise((resolve) => {
      console.log(`[ytdlp] Starting download for ${videoId}`);
      exec(cmd, { timeout: 300000 }, async (err, stdout, stderr) => {
        if (err) {
          const errMsg = (stderr || err.message || '').substring(0, 300);
          console.error(`[ytdlp] Error for ${videoId}:`, errMsg);
          resolve();
          return;
        }
        try {
          const stat = fs.statSync(outFile);
          console.log(`[ytdlp] Sending ${stat.size} bytes to callback for ${videoId}`);
          const fileStream = fs.createReadStream(outFile);
          const chunks = [];
          for await (const chunk of fileStream) chunks.push(chunk);
          const audioBuffer = Buffer.concat(chunks);
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { ...callbackHeaders, 'Content-Type': 'audio/mpeg' },
            body: audioBuffer,
          });
          console.log(`[ytdlp] Callback sent for ${videoId}`);
        } catch (cbErr) {
          console.error(`[ytdlp] Callback failed for ${videoId}:`, cbErr.message?.substring(0, 200));
        } finally {
          fs.unlink(outFile, () => {});
          resolve();
        }
      });
    }));
    return;
  }

  // Synchronous mode (no callback)
  try {
    await runWithConcurrencyLimit(() => new Promise((resolve, reject) => {
      exec(cmd, { timeout: 300000 }, (err) => { if (err) reject(err); else resolve(); });
    }));
    const audioBuffer = fs.readFileSync(outFile);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message?.substring(0, 500) });
  } finally {
    fs.unlink(outFile, () => {});
  }
});

// Forward all other requests to upstream Cobalt service
app.all('*', async (req, res) => {
  try {
    const targetUrl = `${COBALT_URL}${req.path}`;
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
    });
    const data = await upstreamRes.json();
    res.status(upstreamRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`cobalt-audio-proxy listening on port ${PORT} (max concurrent yt-dlp jobs: ${MAX_CONCURRENT})`);
});
