const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const app = express();
app.use(express.json());

const COBALT_URL = process.env.COBALT_UPSTREAM_URL || 'https://cobalt-production-a07d.up.railway.app';
const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'cobalt-audio-proxy' });
});

// Download proxy: accepts a videoId, calls Cobalt API internally,
// buffers the tunnel stream, and returns raw audio bytes
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

    console.log(`[download-proxy] Downloading audio from tunnel URL`);
    const audioRes = await fetch(audioUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!audioRes.ok) return res.status(502).json({ error: `Tunnel fetch failed: ${audioRes.status}` });
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    console.log(`[download-proxy] Downloaded ${buffer.length} bytes`);
    if (buffer.length === 0) return res.status(502).json({ error: 'Tunnel returned 0 bytes' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    console.error('[download-proxy] Error:', err.message);
    res.status(500).json({ error: err.message?.substring(0, 500) || 'download failed' });
  }
});

// yt-dlp fallback endpoint
app.post('/ytdlp', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  const tmpFile = path.join(os.tmpdir(), `${videoId}.mp3`);
  try {
    console.log(`[ytdlp] Downloading audio for videoId: ${videoId}`);
    execSync(
      `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${tmpFile}" --no-playlist "https://www.youtube.com/watch?v=${videoId}"`,
      { timeout: 120000, stdio: 'pipe' }
    );
    const buffer = fs.readFileSync(tmpFile);
    fs.unlinkSync(tmpFile);
    if (buffer.length === 0) return res.status(502).json({ error: 'yt-dlp returned 0 bytes' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    res.status(500).json({ error: err.message?.substring(0, 500) || 'yt-dlp failed' });
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
  console.log(`cobalt-audio-proxy listening on port ${PORT}`);
});
