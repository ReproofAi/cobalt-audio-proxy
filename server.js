const express = require('express');
const app = express();
app.use(express.json());

const COBALT_URL = process.env.COBALT_UPSTREAM_URL || 'http://localhost:9000';
const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'cobalt-audio-proxy' });
});

// Download proxy: buffers a tunnel stream URL and returns raw audio bytes
app.post('/download', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing url' });

    console.log('[download-proxy] Fetching tunnel:', url.slice(0, 100) + '...');

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'audio/*, */*',
        'Accept-Encoding': 'identity',
      },
    });

    if (!response.ok) {
      console.error('[download-proxy] Upstream error:', response.status);
      return res.status(response.status).json({ error: 'Upstream ' + response.status });
    }

    const chunks = [];
    for await (const chunk of response.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length === 0) {
      console.error('[download-proxy] Got 0 bytes from tunnel');
      return res.status(502).json({ error: 'Tunnel returned 0 bytes' });
    }

    console.log('[download-proxy] Downloaded', buffer.length, 'bytes, sending to client');
    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('[download-proxy] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Forward all other requests to the upstream Cobalt service
app.use('*', async (req, res) => {
  try {
    const targetUrl = COBALT_URL + req.originalUrl;
    const fetchOptions = {
      method: req.method,
      headers: { ...req.headers, host: new URL(COBALT_URL).host },
    };
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      fetchOptions.body = JSON.stringify(req.body);
      fetchOptions.headers['content-type'] = 'application/json';
    }

    const upstreamRes = await fetch(targetUrl, fetchOptions);
    const data = await upstreamRes.json().catch(() => null);

    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    if (data !== null) {
      res.json(data);
    } else {
      res.end();
    }
  } catch (err) {
    console.error('[proxy] Forward error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('cobalt-audio-proxy listening on port', PORT);
});
