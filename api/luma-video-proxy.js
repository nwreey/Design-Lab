const { Readable } = require('stream');

const ALLOWED_HOST_SUFFIXES = ['lumalabs.ai', 'storage.googleapis.com', 'amazonaws.com', 'cloudfront.net'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: { message: 'Method not allowed. Use GET.' } });
    return;
  }

  try {
    const videoUrl = req.query && req.query.url;
    if (!videoUrl) {
      res.status(400).json({ error: { message: 'Query must include url.' } });
      return;
    }

    let parsed;
    try {
      parsed = new URL(videoUrl);
    } catch (e) {
      res.status(400).json({ error: { message: 'Invalid url.' } });
      return;
    }

    if (parsed.protocol !== 'https:') {
      res.status(400).json({ error: { message: 'Only https URLs are allowed.' } });
      return;
    }

    const hostAllowed = ALLOWED_HOST_SUFFIXES.some(
      (suffix) => parsed.hostname === suffix || parsed.hostname.endsWith('.' + suffix)
    );
    if (!hostAllowed) {
      res.status(403).json({ error: { message: 'This host is not on the allowlist for video proxying.' } });
      return;
    }

    // Forward the browser's own Range header (if any) to the source host, and mirror
    // whatever status/headers it gives back. Previously this proxy always buffered the
    // ENTIRE video into memory with arrayBuffer() and sent it back as one full 200 response
    // no matter what the browser actually asked for — while still claiming
    // `Accept-Ranges: bytes` without ever honoring a real Range request. That contradiction is
    // exactly what breaks a <video> element's own buffering/seeking logic: it thinks it can
    // request byte ranges, gets a full-file 200 back instead of a 206, and ends up stalling,
    // re-buffering heavily, or giving up before reaching the end of a longer video. Buffering
    // the whole file in memory before responding also meant no bytes reached the browser
    // until the entire source download finished, and risked this function's own duration
    // limit truncating larger videos mid-transfer.
    const upstreamHeaders = {};
    if (req.headers.range) upstreamHeaders.range = req.headers.range;

    const videoResponse = await fetch(videoUrl, { headers: upstreamHeaders });
    if (!videoResponse.ok) {
      res.status(videoResponse.status).json({ error: { message: 'Could not fetch the video file from the source host.' } });
      return;
    }

    // 206 when the source host honored our Range request (normal for seeking/progressive
    // playback), 200 for a full-file request — mirrored straight through to the browser so
    // its own <video> buffering logic sees an honest, consistent response.
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
      const value = videoResponse.headers.get(h);
      if (value) res.setHeader(h, value);
    });
    if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'video/mp4');
    if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3300');
    res.statusCode = videoResponse.status;

    // Stream the response body straight through instead of buffering the whole video first —
    // this starts playback sooner (the browser gets its first bytes immediately rather than
    // after the full source download completes) and avoids holding a large file entirely in
    // this function's memory.
    if (videoResponse.body) {
      Readable.fromWeb(videoResponse.body).pipe(res);
    } else {
      const arrayBuffer = await videoResponse.arrayBuffer();
      res.end(Buffer.from(arrayBuffer));
    }
  } catch (err) {
    res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
  }
};
