module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: { message: 'Method not allowed. Use GET.' } });
    return;
  }

  const apiKey = process.env.LUMA_AGENTS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'Server is missing LUMA_AGENTS_API_KEY. Set it in your Vercel project environment variables.' } });
    return;
  }

  try {
    const generationId = req.query && req.query.generationId;
    if (!generationId) {
      res.status(400).json({ error: { message: 'Query must include generationId.' } });
      return;
    }

    const lumaResponse = await fetch(`https://agents.lumalabs.ai/v1/generations/${encodeURIComponent(generationId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const rawText = await lumaResponse.text();
    let data = {};
    try { data = JSON.parse(rawText); } catch (e) { /* leave as {} */ }

    if (!lumaResponse.ok || !data.id) {
      res.status(lumaResponse.status || 500).json({
        error: { message: (data && (data.message || data.error)) || rawText.slice(0, 300) || 'Luma status check failed.' },
      });
      return;
    }

    const videoOutput = Array.isArray(data.output) ? data.output.find((o) => o.type === 'video') : null;

    res.status(200).json({
      state: data.state || 'queued',
      videoUrl: videoOutput ? videoOutput.url : null,
      failureReason: data.failure_reason || null,
    });
  } catch (err) {
    res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
  }
};
