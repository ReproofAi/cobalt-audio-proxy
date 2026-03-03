const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const app = express();
app.use(express.json({ limit: '500mb' }));

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

// yt-dlp fallback endpoint - supports async callback pattern
app.post('/ytdlp', async (req, res) => {
  const { videoId, callbackUrl, callbackHeaders } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  const outFile = path.join(os.tmpdir(), `${videoId}_${Date.now()}.mp3`);
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cmd = `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${outFile}" --no-playlist "${ytUrl}"`;

  console.log(`[ytdlp] Downloading audio for ${videoId}...`);

  // If caller provided a callbackUrl, respond immediately and process in background
  if (callbackUrl) {
    res.status(202).json({ status: 'accepted', videoId });

    exec(cmd, { timeout: 300000 }, async (err, stdout, stderr) => {
      if (err) {
        console.error(`[ytdlp] Error for ${videoId}:`, err.message);
        return;
      }
      try {
        const audioBuffer = fs.readFileSync(outFile);
        console.log(`[ytdlp] Sending ${audioBuffer.length} bytes to callback for ${videoId}`);
        await fetch(callbackUrl, {
          method: 'POST',
          headers: {
            ...callbackHeaders,
            'Content-Type': 'audio/mpeg',
          },
          body: audioBuffer,
        });
        console.log(`[ytdlp] Callback sent for ${videoId}`);
      } catch (cbErr) {
        console.error(`[ytdlp] Callback failed for ${videoId}:`, cbErr.message);
      } finally {
        fs.unlink(outFile, () => {});
      }
    });
    return;
  }

  // No callback - synchronous mode (stream back audio)
  exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
    if (err) {
      console.error(`[ytdlp] Error for ${videoId}:`, err.message);
      return res.status(500).json({ error: err.message?.substring(0, 500) });
    }
    try {
      const audioBuffer = fs.readFileSync(outFile);
      console.log(`[ytdlp] Returning ${audioBuffer.length} bytes for ${videoId}`);
      res.set('Content-Type', 'audio/mpeg');
      res.send(audioBuffer);
    } catch (readErr) {
      res.status(500).json({ error: readErr.message });
    } finally {
      fs.unlink(outFile, () => {});
    }
  });
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
