const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const app = express();
app.use(express.json({ limit: '10mb' }));

const COBALT_URL = process.env.COBALT_UPSTREAM_URL || 'https://cobalt-production-a07d.up.railway.app';
const PORT = process.env.PORT || 3000;

// Proxy rotation: RESIDENTIAL_PROXY_LIST is comma-separated list of proxy URLs
// e.g. "http://user:pass@ip1:port1,http://user:pass@ip2:port2"
// RESIDENTIAL_PROXY_URL is fallback for single proxy (legacy)
function parseProxyList() {
  const listEnv = process.env.RESIDENTIAL_PROXY_LIST || '';
  const singleEnv = process.env.RESIDENTIAL_PROXY_URL || '';
  if (listEnv) {
    return listEnv.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (singleEnv) return [singleEnv];
  return [];
}

const PROXY_LIST = parseProxyList();
let proxyIndex = 0;

function getNextProxy() {
  if (PROXY_LIST.length === 0) return '';
  const proxy = PROXY_LIST[proxyIndex % PROXY_LIST.length];
  proxyIndex++;
  return proxy;
}

let NODE_PATH = '/usr/local/bin/node';
try { NODE_PATH = execSync('which node').toString().trim(); } catch (e) {}
console.log(`[startup] Node path: ${NODE_PATH}`);

if (PROXY_LIST.length > 0) {
  console.log(`[startup] ${PROXY_LIST.length} residential proxy/proxies configured (round-robin)`);
} else {
  console.warn('[startup] No residential proxies set (RESIDENTIAL_PROXY_LIST or RESIDENTIAL_PROXY_URL)');
}

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

async function fetchTranscriptPython(videoId) {
  return new Promise((resolve) => {
    const scriptFile = path.join(os.tmpdir(), `transcript_${videoId}.py`);
    const proxy = getNextProxy();
    const proxyLine = proxy
      ? `os.environ['HTTP_PROXY'] = r"${proxy}"; os.environ['HTTPS_PROXY'] = r"${proxy}"`
      : '# no proxy';
    const pyLines = [
      'import sys, os',
      proxyLine,
      `vid = "${videoId}"`,
      'try:',
      '    from youtube_transcript_api import YouTubeTranscriptApi',
      '    api = YouTubeTranscriptApi()',
      `    t = api.fetch(vid, languages=["en","en-US","en-GB"])`,
      '    print(" ".join([s.text for s in t]))',
      'except Exception as e:',
      '    sys.stderr.write(str(e))',
      '    sys.exit(1)',
    ].join('\n');
    fs.writeFileSync(scriptFile, pyLines);
    if (proxy) console.log(`[transcript-api] Using proxy for ${videoId}: ${proxy.replace(/:[^@]+@/, ':***@')}`);
    exec(`python3 "${scriptFile}"`, { timeout: 30000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(scriptFile); } catch(_) {}
      if (err) {
        console.warn(`[transcript-api] Failed for ${videoId}: ${(stderr||'').slice(0,300)||err.message}`);
        resolve(null);
      } else {
        const text = stdout.trim();
        if (text && text.length > 50) {
          console.log(`[transcript-api] Got transcript for ${videoId}: ${text.length} chars`);
          resolve(text);
        } else {
          console.warn(`[transcript-api] Transcript too short for ${videoId}: ${text.length} chars`);
          resolve(null);
        }
      }
    });
  });
}

function buildYtDlpCmd(videoId, outTemplate, proxy) {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cookiesArg = fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';
  const proxyArg = proxy ? `--proxy "${proxy}"` : '';
  return [
    'yt-dlp',
    '-x',
    '--audio-format opus',
    '--audio-quality 9',
    `-o "${outTemplate}"`,
    '--no-playlist',
    '--no-check-certificates',
    '--age-limit 99',
    `--js-runtimes "node:${NODE_PATH}"`,
    // Use web-only when cookies present (android skips cookies)
    cookiesArg ? '--extractor-args "youtube:player_client=web"' : '--extractor-args "youtube:player_client=android,web"',
    cookiesArg,
    proxyArg,
    `"${ytUrl}"`,
  ].filter(Boolean).join(' ');
}

function findDownloadedFile(tmpDir, videoId, timestamp) {
  const prefix = `${videoId}_${timestamp}`;
  try {
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(prefix));
    if (files.length > 0) return path.join(tmpDir, files[0]);
  } catch (_) {}
  return null;
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
    console.log(`[ytdlp] Processing ${videoId}`);
    const transcript = await fetchTranscriptPython(videoId);
    if (transcript) {
      console.log(`[ytdlp] Sending transcript callback for ${videoId}`);
      try {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId, transcript }),
        });
        console.log(`[ytdlp] Transcript callback sent: ${videoId}`);
      } catch (cbErr) {
        console.error('[ytdlp] Transcript callback error:', cbErr.message);
      }
      return;
    }

    console.log(`[ytdlp] Transcript API failed, falling back to yt-dlp audio: ${videoId}`);
    const proxy = getNextProxy();
    if (proxy) console.log(`[ytdlp] Using proxy for download ${videoId}: ${proxy.replace(/:[^@]+@/, ':***@')}`);
    const timestamp = Date.now();
    const outTemplate = path.join(os.tmpdir(), `${videoId}_${timestamp}.%(ext)s`);
    const cmd = buildYtDlpCmd(videoId, outTemplate, proxy);
    console.log(`[ytdlp] Starting download: ${videoId}`);

    await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 300000 }, async (err, stdout, stderr) => {
        if (err) {
          console.error(`[ytdlp] FAILED ${videoId}:`, (stderr||'').slice(0,400)||err.message);
          try {
            await fetch(callbackUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoId, error: err.message }),
            });
          } catch (_) {}
          return reject(err);
        }
        console.log(`[ytdlp] Download done: ${videoId}`);
        const actualFile = findDownloadedFile(os.tmpdir(), videoId, timestamp);
        if (!actualFile) {
          console.error(`[ytdlp] Audio file not found for ${videoId}`);
          try {
            await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId, error: 'file not found after download' }) });
          } catch (_) {}
          return resolve();
        }
        try {
          const audioData = fs.readFileSync(actualFile);
          const base64Audio = audioData.toString('base64');
          console.log(`[ytdlp] Sending audio callback: ${videoId}, ${audioData.length} bytes`);
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId, audio: base64Audio }),
          });
          console.log(`[ytdlp] Audio callback sent: ${videoId}`);
        } catch (cbErr) {
          console.error('[ytdlp] Audio callback error:', cbErr.message);
        } finally {
          try { fs.unlinkSync(actualFile); } catch (_) {}
        }
        resolve();
      });
    });
  }).catch(err => console.error(`[ytdlp] Job error ${videoId}:`, err.message));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeJobs,
    queueLength: jobQueue.length,
    cookiesLoaded: fs.existsSync(COOKIES_FILE),
    proxyCount: PROXY_LIST.length,
    proxyIndex,
  });
});

app.listen(PORT, () => console.log(`cobalt-audio-proxy listening on port ${PORT}`));
