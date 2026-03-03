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
try { NODE_PATH = execSync('which node').toString().trim(); } catch (e) {}
console.log(`[startup] Node.js path for yt-dlp: ${NODE_PATH}`);

// Concurrency config
const MAX_CONCURRENT = 2;
const MAX_QUEUE = 4;

let activeJobs = 0;
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
            if (jobQueue.length > 0) jobQueue.shift()();
          });
      } else {
        jobQueue.push(attempt);
      }
    };
    attempt();
  });
}

// Build yt-dlp command — use ios/mweb clients to bypass bot detection
// ios client is authenticated and doesn't require cookies for most videos
function buildYtDlpCmd(videoId, outFile) {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  return [
    'yt-dlp',
    '-x',
    '--audio-format mp3',
    '--audio-quality 5',
    `-o "${outFile}"`,
    '--no-playlist',
    // ios client bypasses bot detection and doesn't need cookies
    '--extractor-args "youtube:player_client=ios,android,mweb"',
    // Skip age gate attempts to avoid login prompts
    '--extractor-args "youtube:player_skip=webpage,configs,js"',
    '--no-check-certificates',
    `"${ytUrl}"`,
  ].join(' ');
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'cobalt-audio-proxy', activeJobs, queued: jobQueue.length });
});

// Download proxy: accepts a videoId, calls Cobalt internally
app.post('/download', async (req, res) => {
  try {
    const { videoId, url: tunnelUrl } = req.body;
    let audioUrl = tunnelUrl;

    if (videoId && !tunnelUrl) {
      console.log(`[download-proxy] Calling Cobalt for videoId: ${videoId}`);
      const cobaltRes = await fetch(`${COBALT_URL}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, audioFormat: 'mp3', isAudioOnly: true }),
      });
      const cobaltData = await cobaltRes.json();
      console.log(`[download-proxy] Cobalt response status: ${cobaltData.status}`);
      if (['tunnel', 'redirect', 'stream'].includes(cobaltData.status)) {
        audioUrl = cobaltData.url;
      } else {
        return res.status(502).json({ error: `Cobalt returned status: ${cobaltData.status}` });
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
    res.status(500).json({ error: err.message?.substring(0, 300) });
  }
});

// yt-dlp endpoint — async callback with concurrency + queue cap
app.post('/ytdlp', async (req, res) => {
  const { videoId, callbackUrl, callbackHeaders } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  if (jobQueue.length >= MAX_QUEUE) {
    console.log(`[ytdlp] Queue full (${jobQueue.length}/${MAX_QUEUE}), rejecting ${videoId}`);
    return res.status(429).json({ error: 'queue_full', activeJobs, queued: jobQueue.length });
  }

  const outFile = path.join(os.tmpdir(), `${videoId}_${Date.now()}.mp3`);
  const cmd = buildYtDlpCmd(videoId, outFile);

  console.log(`[ytdlp] Queued job for ${videoId} (active: ${activeJobs}/${MAX_CONCURRENT}, queued: ${jobQueue.length}/${MAX_QUEUE})`);

  if (callbackUrl) {
    res.status(202).json({ status: 'accepted', videoId, activeJobs, queued: jobQueue.length });

    runWithConcurrencyLimit(() => new Promise((resolve) => {
      console.log(`[ytdlp] Starting download for ${videoId}`);
      exec(cmd, { timeout: 300000 }, async (err, stdout, stderr) => {
        if (err) {
          console.error(`[ytdlp] Error for ${videoId}:`, (stderr || err.message || '').substring(0, 300));
          resolve();
          return;
        }
        try {
          const stat = fs.statSync(outFile);
          console.log(`[ytdlp] Sending ${stat.size} bytes to callback for ${videoId}`);
          const chunks = [];
          for await (const chunk of fs.createReadStream(outFile)) chunks.push(chunk);
          const audioBuffer = Buffer.concat(chunks);
          const cbRes = await fetch(callbackUrl, {
            method: 'POST',
            headers: { ...callbackHeaders, 'Content-Type': 'audio/mpeg' },
            body: audioBuffer,
          });
          console.log(`[ytdlp] Callback sent for ${videoId} — status: ${cbRes.status}`);
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

  // Synchronous mode
  try {
    await runWithConcurrencyLimit(() => new Promise((resolve, reject) => {
      exec(cmd, { timeout: 300000 }, (err) => { if (err) reject(err); else resolve(); });
    }));
    const audioBuffer = fs.readFileSync(outFile);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message?.substring(0, 300) });
  } finally {
    fs.unlink(outFile, () => {});
  }
});

// Forward all other requests to upstream Cobalt
app.all('*', async (req, res) => {
  try {
    const upstreamRes = await fetch(`${COBALT_URL}${req.path}`, {
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
  console.log(`cobalt-audio-proxy listening on port ${PORT} (max: ${MAX_CONCURRENT} concurrent, ${MAX_QUEUE} queued)`);
});
