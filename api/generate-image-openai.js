import crypto from 'crypto';

/* Same token verification duplicated across the auth-aware endpoints in this project —
   see api/projects.js for the fuller explanation of why this isn't a shared import. */
function getCaller(req) {
  const signingSecret = process.env.SITE_PASSWORD || '';
  if (!signingSecret) return null;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|; )design_lab_auth=([^;]*)/);
  const token = match ? decodeURIComponent(match[1]) : null;
  if (!token) return null;
  const separatorIndex = token.indexOf('.');
  if (separatorIndex === -1) return null;
  const payloadB64 = token.substring(0, separatorIndex);
  const signature = token.substring(separatorIndex + 1);
  const expectedSignature = crypto.createHmac('sha256', signingSecret).update(payloadB64).digest('hex');
  if (signature !== expectedSignature) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload.expiry || payload.expiry < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// Gemini's aspectRatio strings (e.g. "16:9", "4:3", "3:4") don't map onto OpenAI's image
// endpoints, which only accept one of three fixed sizes — this picks whichever fixed size
// best matches the requested orientation so the two engines are at least comparing a
// similarly-shaped frame, not a wide Gemini render against a square OpenAI one.
function sizeFromAspectRatio(aspectRatio) {
  if (!aspectRatio || typeof aspectRatio !== 'string' || !aspectRatio.includes(':')) return 'auto';
  const [wStr, hStr] = aspectRatio.split(':');
  const w = parseFloat(wStr);
  const h = parseFloat(hStr);
  if (!w || !h) return 'auto';
  const ratio = w / h;
  if (ratio > 1.1) return '1536x1024';
  if (ratio < 0.9) return '1024x1536';
  return '1024x1024';
}

function extFromMime(mime) {
  if (mime && mime.includes('jpeg')) return 'jpg';
  if (mime && mime.includes('webp')) return 'webp';
  return 'png';
}

/* Admin-only test tool (see the "Image Engine" selector in ai-design-studio.html): sends the
   exact same final Stage 2 prompt that normally goes to api/generate-image-gemini.js to
   OpenAI's own image models instead, purely so an admin can compare Gemini's and OpenAI's
   design quality on the identical prompt. This deliberately never touches the two-call
   Project Analysis Engine (Stage 1/Stage 2) — only the final image-rendering step is swapped,
   and only for whoever explicitly picks "OpenAI" from that admin-only selector. Restricted to
   admin callers only, both to keep this experimental path out of regular users' quota-metered
   flow and to avoid surprise OpenAI image-generation costs from anyone else. */
export default async function handler(req, res) {
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

  const caller = getCaller(req);
  if (!caller) {
    res.status(401).json({ error: { message: 'Not logged in.' } });
    return;
  }
  if (caller.role !== 'admin') {
    res.status(403).json({ error: { message: 'This OpenAI comparison tool is admin-only.' } });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'Server misconfiguration: OPENAI_API_KEY is not set.' } });
    return;
  }

  try {
    const { prompt, referenceImage, referenceMimeType, additionalReferenceImages, aspectRatio } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: { message: 'Request body must include a "prompt" string.' } });
      return;
    }

    const size = sizeFromAspectRatio(aspectRatio);

    let response;
    if (referenceImage) {
      // A reference image is attached (e.g. the client's own logo) — use the edits endpoint
      // so OpenAI actually sees those exact pixels, same reasoning as api/edit-image-openai.js.
      const form = new FormData();
      form.append('model', 'gpt-image-2');
      form.append('prompt', prompt);
      form.append('quality', 'medium');
      form.append('size', size);

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

      response = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } else {
      // No reference image — a genuine from-scratch generation from the prompt text alone.
      response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt,
          quality: 'medium',
          size,
        }),
      });
    }

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
      res.status(502).json({ error: { message: 'OpenAI did not return an image.' }, raw: data });
      return;
    }

    res.status(200).json({ image: `data:image/png;base64,${b64}` });
  } catch (err) {
    res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
  }
}
