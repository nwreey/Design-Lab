import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { logAiCall } from '../lib/usage-log.js';
import { scrubProviderText, GENERIC_IMAGE_ERROR, GENERIC_TEXT_ERROR } from '../lib/safe-error.js';
import { tryConsumeFreeFirstModification } from '../lib/free-mod.js';
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

/* Checks the caller's edit quota before an edit proceeds, returning an error message if
   they're over the limit, or null if they're clear to proceed. The master admin account
   and any user with no configured limit (project_limit/edit_limit left null) are
   unrestricted — this only actually blocks anything for a user an admin has explicitly
   capped. */
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
    // Fail open rather than blocking every edit if the quota check itself has a problem —
    // an unenforced limit for a few minutes is a much smaller issue than the whole edit
    // feature going down because of a database hiccup unrelated to the edit itself.
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

export default async function handler(req, res) {
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

  function extFromMime(mime) {
    if (mime && mime.includes('jpeg')) return 'jpg';
    if (mime && mime.includes('webp')) return 'webp';
    return 'png';
  }

  try {
    const { prompt, referenceImage, referenceMimeType, additionalReferenceImages, preferSpeed, size, isUserInitiatedEdit } = req.body || {};
    if (!prompt || !referenceImage) {
      res.status(400).json({ error: { message: 'Request body must include prompt and referenceImage.' } });
      return;
    }

    let freeApplied = false;
    if (isUserInitiatedEdit) {
      // Owner rule: first modification/other-option per project is free (lib/free-mod.js).
      freeApplied = (req.body || {}).isFreeFirstModification
        ? await tryConsumeFreeFirstModification(sql, caller.userId, (req.body || {}).projectId)
        : false;
      if (!freeApplied) {
        const quotaError = await checkEditQuota(caller);
        if (quotaError) {
          res.status(403).json({ error: { message: quotaError } });
          return;
        }
      }
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

    // Fire-and-forget usage logging for the admin Service Usage & Billing panel — never
    // awaited, never allowed to affect the actual edit (see lib/usage-log.js).
    logAiCall({ provider: 'openai', endpoint: 'edit-image-openai', ok: response.ok, status: response.status, message: !response.ok ? ((data.error && data.error.message) || rawText.slice(0, 300)) : '' });

    if (!response.ok) {
      const detail = (data.error && data.error.message) || rawText.slice(0, 300) || `HTTP ${response.status}`;
      console.error('OpenAI edit request failed:', response.status, detail);
      res.status(response.status).json({ error: { message: GENERIC_IMAGE_ERROR } });
      return;
    }

    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      console.error('OpenAI returned no edited image:', JSON.stringify(data).slice(0, 500));
      res.status(502).json({ error: { message: 'The design engine responded without an image this time. Please submit again — your request itself was fine.' } });
      return;
    }

    if (isUserInitiatedEdit && !freeApplied) await incrementEditCount(caller);
    res.status(200).json({ image: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error('edit-image-openai unexpected error:', err);
    res.status(500).json({ error: { message: scrubProviderText(err && err.message) || 'Unexpected server error.' } });
  }
}

