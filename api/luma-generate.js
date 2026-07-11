module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
    return;
  }

  const apiKey = process.env.LUMA_AGENTS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'Server is missing LUMA_AGENTS_API_KEY. Set it in your Vercel project environment variables.' } });
    return;
  }

  try {
    const { mode, prompt, imageBase64, mimeType, sourceGenerationId, keyframes, keyframeBase64, keyframeMimeType, keyframeIndex } = req.body || {};

    if (!prompt) {
      res.status(400).json({ error: { message: 'Request body must include prompt.' } });
      return;
    }

    let body;

    if (mode === 'edit') {
      // Editing an existing 360 video — re-render the whole clip, anchored at every
      // frame the user marked up. Multiple pinned keyframes let Luma track several
      // distinct fixes across the clip in one re-render, rather than anchoring at
      // only one point and hoping the rest of the orbit follows along.
      if (!sourceGenerationId) {
        res.status(400).json({ error: { message: 'Edit mode requires sourceGenerationId.' } });
        return;
      }

      // Accept either the new multi-keyframe array shape, or the older single-keyframe
      // fields (kept working as a one-item array) for backward compatibility.
      let keyframeList = Array.isArray(keyframes) ? keyframes : null;
      if (!keyframeList && keyframeBase64 && typeof keyframeIndex === 'number') {
        keyframeList = [{ data: keyframeBase64, mediaType: keyframeMimeType, index: keyframeIndex }];
      }

      if (!keyframeList || keyframeList.length === 0) {
        res.status(400).json({ error: { message: 'Edit mode requires at least one keyframe (data + index).' } });
        return;
      }
      for (const kf of keyframeList) {
        if (!kf.data || typeof kf.index !== 'number') {
          res.status(400).json({ error: { message: 'Each keyframe needs a data field and a numeric index.' } });
          return;
        }
      }
      // Luma requires keyframe indexes to be unique and in ascending order.
      const sortedKeyframes = [...keyframeList].sort((a, b) => a.index - b.index);
      const uniqueIndexes = new Set(sortedKeyframes.map((kf) => kf.index));
      if (uniqueIndexes.size !== sortedKeyframes.length) {
        res.status(400).json({ error: { message: 'Keyframe indexes must be unique — two edits landed on the same frame position.' } });
        return;
      }

      body = {
        model: 'ray-3.2',
        type: 'video_edit',
        prompt,
        source: { generation_id: sourceGenerationId },
        video: {
          resolution: '720p',
          edit: {
            keyframes: sortedKeyframes.map((kf) => ({ data: kf.data, media_type: kf.mediaType || 'image/png' })),
            keyframe_indexes: sortedKeyframes.map((kf) => kf.index),
          },
        },
      };
    } else {
      // Initial 360-degree orbit generation from the approved design photo.
      if (!imageBase64) {
        res.status(400).json({ error: { message: 'Request body must include imageBase64 for initial generation.' } });
        return;
      }
      body = {
        model: 'ray-3.2',
        type: 'video',
        prompt,
        aspect_ratio: '4:3',
        video: {
          resolution: '720p',
          duration: '5s',
          loop: true,
          start_frame: { data: imageBase64, media_type: mimeType || 'image/png' },
        },
      };
    }

    const lumaResponse = await fetch('https://agents.lumalabs.ai/v1/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const rawText = await lumaResponse.text();
    let data = {};
    try { data = JSON.parse(rawText); } catch (e) { /* leave as {} */ }

    if (!lumaResponse.ok || !data.id) {
      res.status(lumaResponse.status || 500).json({
        error: { message: (data && (data.message || data.error)) || rawText.slice(0, 300) || 'Luma generation request failed.' },
      });
      return;
    }

    res.status(200).json({ generationId: data.id, state: data.state || 'queued' });
  } catch (err) {
    res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
  }
};
