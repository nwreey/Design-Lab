const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

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

/* Modify Design (a deliberate, user-chosen edit action) counts against the MODIFY quota —
   deliberately separate from "Edit Image" (api/edit-image-openai.js), which uses its own
   edit_limit/edit_count instead. These are genuinely different actions the admin needs to
   be able to limit independently, not one combined counter. The INITIAL design generation
   also goes through this same endpoint, but that's covered by the separate project quota
   instead; counting it here too would double-count the same action under two different
   limits. Fails open on a database hiccup, same reasoning as api/edit-image-openai.js: an
   unenforced limit briefly is a smaller problem than the whole generation feature going
   down over an unrelated quota-check error. */
async function checkModifyQuota(caller) {
  if (!caller || caller.role === 'admin') return null;
  try {
    const result = await sql`SELECT modify_limit, modify_count FROM users WHERE id = ${caller.userId};`;
    if (result.rows.length === 0) return null;
    const { modify_limit, modify_count } = result.rows[0];
    if (modify_limit != null && modify_count >= modify_limit) {
      return `You've reached your modify limit (${modify_limit}). Ask an admin to raise it.`;
    }
  } catch (err) {
    console.error('Could not check modify quota:', err);
  }
  return null;
}

async function incrementModifyCount(caller) {
  if (!caller || caller.role === 'admin') return;
  try {
    await sql`UPDATE users SET modify_count = modify_count + 1 WHERE id = ${caller.userId};`;
  } catch (err) {
    console.error('Could not increment modify count:', err);
  }
}

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

  const caller = getCaller(req);
  if (!caller) {
    res.status(401).json({ error: { message: 'Not logged in.' } });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'Server is missing GEMINI_API_KEY.' } });
    return;
  }

  try {
    const { prompt, referenceImage, referenceMimeType, additionalReferenceImages, isUserInitiatedEdit } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: { message: 'Request body must include a "prompt" string.' } });
      return;
    }

    if (isUserInitiatedEdit) {
      const quotaError = await checkModifyQuota(caller);
      if (quotaError) {
        res.status(403).json({ error: { message: quotaError } });
        return;
      }
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
    if (isUserInitiatedEdit) await incrementModifyCount(caller);
    res.status(200).json({ image: `data:${mime};base64,${imagePart.inlineData.data}` });
  } catch (err) {
    res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
  }
};
