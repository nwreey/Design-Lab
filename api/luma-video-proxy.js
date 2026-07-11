const ALLOWED_HOST_SUFFIXES = ['lumalabs.ai', 'storage.googleapis.com', 'amazonaws.com', 'cloudfront.net'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

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

    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      res.status(videoResponse.status).json({ error: { message: 'Could not fetch the video file from the source host.' } });
      return;
    }

    const arrayBuffer = await videoResponse.arrayBuffer();
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=3300');
    res.setHeader('Accept-Ranges', 'bytes');
    res.status(200).send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
  }
};
