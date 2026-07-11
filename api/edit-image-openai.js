export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'Server misconfiguration: OPENAI_API_KEY is not set.' } });
    return;
  }

  function extFromMime(mime) {
    if (mime && mime.includes('jpeg')) return 'jpg';
    if (mime && mime.includes('webp')) return 'webp';
    return 'png';
  }

  try {
    const { prompt, referenceImage, referenceMimeType, additionalReferenceImages, preferSpeed, size } = req.body || {};
    if (!prompt || !referenceImage) {
      res.status(400).json({ error: { message: 'Request body must include prompt and referenceImage.' } });
      return;
    }

    const ALLOWED_SIZES = ['1024x1024', '1024x1536', '1536x1024', 'auto'];
    const finalSize = ALLOWED_SIZES.includes(size) ? size : 'auto';

    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('prompt', prompt);
    form.append('quality', preferSpeed ? 'low' : 'medium');
    form.append('size', finalSize);

    const mainBuffer = Buffer.from(referenceImage, 'base64');
    const mainExt = extFromMime(referenceMimeType);
    form.append('image[]', new Blob([mainBuffer], { type: referenceMimeType || 'image/png' }), `image.${mainExt}`);

    if (Array.isArray(additionalReferenceImages)) {
      additionalReferenceImages.forEach((img, i) => {
        if (img && img.data && img.mimeType) {
          const buf = Buffer.from(img.data, 'base64');
          const ext = extFromMime(img.mimeType);
          form.append('image[]', new Blob([buf], { type: img.mimeType }), `reference-${i}.${ext}`);
        }
      });
    }

    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const rawText = await response.text();
    let data = {};
    try { data = JSON.parse(rawText); } catch (parseErr) { /* leave data as {} */ }

    if (!response.ok) {
      const detail = (data.error && data.error.message) || rawText.slice(0, 300) || `HTTP ${response.status}`;
      res.status(response.status).json({ error: { message: detail } });
      return;
    }

    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      res.status(502).json({ error: { message: 'OpenAI did not return an edited image.' }, raw: data });
      return;
    }

    res.status(200).json({ image: `data:image/png;base64,${b64}` });
  } catch (err) {
    res.status(500).json({ error: { message: err.message || 'Unexpected server error.' } });
  }
}
