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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'Server is missing GEMINI_API_KEY.' } });
    return;
  }

  try {
    const { prompt, referenceImage, referenceMimeType, additionalReferenceImages } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: { message: 'Request body must include a "prompt" string.' } });
      return;
    }

    const model = 'gemini-3.1-flash-image';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const requestParts = [];
    if (referenceImage && referenceMimeType) {
      requestParts.push({ inlineData: { mimeType: referenceMimeType, data: referenceImage } });
    }
    if (Array.isArray(additionalReferenceImages)) {
      additionalReferenceImages.forEach((img) => {
        if (img && img.data && img.mimeType) {
          requestParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
        }
      });
    }
    requestParts.push({ text: prompt });

    const geminiResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: requestParts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { imageSize: '2K' },
        },
      }),
    });

    const data = await geminiResponse.json();

    if (!geminiResponse.ok) {
      res.status(geminiResponse.status).json({ error: data.error || { message: 'Gemini image request failed.' } });
      return;
    }

    const parts =
      (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const imagePart = parts.find((p) => p.inlineData && p.inlineData.data);

    if (!imagePart) {
      const textPart = parts.find((p) => p.text);
      const detail = textPart ? ` Model responded with text instead of an image: "${textPart.text.slice(0, 200)}"` : '';
      res.status(500).json({ error: { message: 'No image data returned by Gemini.' + detail } });
      return;
    }

    const mime = imagePart.inlineData.mimeType || 'image/png';
    res.status(200).json({ image: `data:${mime};base64,${imagePart.inlineData.data}` });
  } catch (err) {
    res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
  }
};
