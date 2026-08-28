import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { logAiCall } from '../lib/usage-log.js';
import { scrubProviderText, GENERIC_IMAGE_ERROR, GENERIC_TEXT_ERROR } from '../lib/safe-error.js';
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

// Gemini's aspectRatio strings (e.g. "16:9", "4:3", "3:4") don't map onto OpenAI's image
// endpoints — this picks whichever OpenAI size best matches the requested orientation, so the
// two engines are at least comparing a similarly-shaped frame, not a wide Gemini render against
// a square OpenAI one.
//
// gpt-image-2 supports arbitrary WIDTHxHEIGHT strings (width/height both divisible by 16, aspect
// ratio between 1:3 and 3:1) rather than only a few fixed presets — used here to request a
// genuinely smaller render, not just the old three largest-available presets (1536x1024/
// 1024x1536/1024x1024).
//
// First attempt at this (960x640/640x960/768x768) was rejected outright by the live API — HTTP
// error "Requested resolution is below the current minimum pixel budget." gpt-image-2 enforces a
// hard floor of 655,360 total pixels (in addition to the divisible-by-16/aspect-ratio rules
// above); those three sizes were all just under it (614,400/614,400/589,824). These values clear
// that floor with a small safety margin while still being meaningfully smaller than the old
// defaults — landscape/portrait at ~44% of the old pixel count, square at ~66% — per the original
// client feedback that OpenAI's output resolution was too high. If this now reads too soft, the
// old values were 1536x1024 / 1024x1536 / 1024x1024.
function sizeFromAspectRatio(aspectRatio) {
  if (!aspectRatio || typeof aspectRatio !== 'string' || !aspectRatio.includes(':')) return 'auto';
  const [wStr, hStr] = aspectRatio.split(':');
  const w = parseFloat(wStr);
  const h = parseFloat(hStr);
  if (!w || !h) return 'auto';
  const ratio = w / h;
  if (ratio > 1.1) return '1024x672';
  if (ratio < 0.9) return '672x1024';
  return '832x832';
}

function extFromMime(mime) {
  if (mime && mime.includes('jpeg')) return 'jpg';
  if (mime && mime.includes('webp')) return 'webp';
  return 'png';
}

/* Same modify-quota logic as api/generate-image-gemini.js, duplicated rather than shared for
   the same reason as getCaller above. This matters here specifically because "Other option"
   now automatically alternates between this endpoint and Gemini's (see
   confirmRegenerateOtherOption in ai-design-studio.html) — a user's modify limit has to be
   enforced identically regardless of which engine happens to render that particular attempt,
   or landing on an OpenAI turn would be a free, unmetered bypass of their limit. */
async function checkModifyQuota(caller) {
  if (!caller || caller.role === 'admin') return null;
  try {
    const result = await sql`SELECT modify_limit, modify_count FROM users WHERE id = ${caller.userId};`;
    if (result.rows.length === 0) return null;
    const { modify_limit, modify_count } = result.rows[0];
    if (modify_limit != null && modify_count >= modify_limit) {
      return `You've reached your modify limit (${modify_limit}). Please contact your administrator to increase this limit.`;
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

/* Modify Design charges the EDIT quota (owner decision) while Other option keeps charging
   the MODIFY quota — the client says which via quotaKind on the request body. Same shape
   as api/edit-image-openai.js's own edit-quota gate. */
async function checkEditQuota(caller) {
  if (!caller || caller.role === 'admin') return null;
  try {
    const result = await sql`SELECT edit_limit, edit_count FROM users WHERE id = ${caller.userId};`;
    if (result.rows.length === 0) return null;
    const { edit_limit, edit_count } = result.rows[0];
    if (edit_limit != null && edit_count >= edit_limit) {
      return `You've reached your edit limit (${edit_limit}). Please contact your administrator to increase this limit.`;
    }
  } catch (err) {
    console.error('Could not check edit quota:', err);
  }
  return null;
}

async function incrementEditCount(caller) {
  if (!caller || caller.role === 'admin') return;
  try {
    await sql`UPDATE users SET edit_count = edit_count + 1 WHERE id = ${caller.userId};`;
  } catch (err) {
    console.error('Could not increment edit count:', err);
  }
}


/* Sends the exact same final Stage 2 prompt that normally goes to api/generate-image-gemini.js
   to OpenAI's own image models instead. Two callers use this: (1) the admin-only "Image
   Engine" selector on the main form, for deliberately comparing Gemini vs. OpenAI design
   quality on an initial generation; and (2) confirmRegenerateOtherOption's automatic
   alternation, which now sends every other "Other option" click here for every user, not just
   admins. Either way, this never touches the two-call Project Analysis Engine (Stage 1/Stage
   2) — only the final image-rendering step is swapped. */
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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'The image service is not configured on the server. Please contact the administrator.' } });
    return;
  }

  try {
    const { prompt, referenceImage, referenceMimeType, additionalReferenceImages, aspectRatio, isUserInitiatedEdit, quotaKind } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: { message: 'Request body must include a "prompt" string.' } });
      return;
    }

    if (isUserInitiatedEdit) {
      const chargesEditQuota = quotaKind === 'edit';
      const quotaError = chargesEditQuota ? await checkEditQuota(caller) : await checkModifyQuota(caller);
      if (quotaError) {
        res.status(403).json({ error: { message: quotaError } });
        return;
      }
      // Owner decision: the credit is spent the moment the user commits (clicks OK),
      // not when the image finishes rendering — so charge it up front, before the
      // model call. Modify Design sends quotaKind 'edit' (edit quota); Other option
      // sends nothing and stays on the modify quota.
      if (chargesEditQuota) await incrementEditCount(caller); else await incrementModifyCount(caller);
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

    // Fire-and-forget usage logging for the admin Service Usage & Billing panel — never
    // awaited, never allowed to affect the actual generation (see lib/usage-log.js).
    logAiCall({ provider: 'openai', endpoint: 'generate-image-openai', ok: response.ok, status: response.status, message: !response.ok ? ((data.error && data.error.message) || rawText.slice(0, 300)) : '' });

    if (!response.ok) {
      const detail = (data.error && data.error.message) || rawText.slice(0, 300) || `HTTP ${response.status}`;
      console.error('OpenAI image request failed:', response.status, detail);
      res.status(response.status).json({ error: { message: GENERIC_IMAGE_ERROR } });
      return;
    }

    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      console.error('OpenAI returned no image:', JSON.stringify(data).slice(0, 500));
      res.status(502).json({ error: { message: 'The design engine responded without an image this time. Please submit again — your request itself was fine.' } });
      return;
    }

    res.status(200).json({ image: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error('generate-image-openai unexpected error:', err);
    res.status(500).json({ error: { message: scrubProviderText(err && err.message) || 'Unexpected server error.' } });
  }
}
