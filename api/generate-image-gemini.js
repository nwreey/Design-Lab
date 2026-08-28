const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');
const { logAiCall } = require('../lib/usage-log.js');
const { scrubProviderText, GENERIC_IMAGE_ERROR } = require('../lib/safe-error.js');
const { tryConsumeFreeFirstModification } = require('../lib/free-mod.js');
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
    res.status(500).json({ error: { message: 'The image service is not configured on the server. Please contact the administrator.' } });
    return;
  }

  try {
    const { prompt, referenceImage, referenceMimeType, additionalReferenceImages, isUserInitiatedEdit, quotaKind, aspectRatio, engineMode, imageSize } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: { message: 'Request body must include a "prompt" string.' } });
      return;
    }

    // Aspect ratio is computed client-side from the booth's own real width:depth footprint
    // (computeBoothAspectRatio in ai-design-studio.html) so the requested image frame actually
    // matches the shape being described in the prompt, instead of always forcing a fixed 16:9
    // widescreen frame regardless of whether the booth is square, wide, or deep — a real
    // contributor to booths rendering at the wrong apparent scale. Whitelisted against Gemini's
    // documented supported aspect ratios (ai.google.dev/gemini-api/docs/image-generation);
    // anything missing or unrecognized falls back to the previous default so this can never
    // send an invalid value to the API.
    const SUPPORTED_ASPECT_RATIOS = new Set(['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
    const resolvedAspectRatio = SUPPORTED_ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : '16:9';

    // Always 1K now, for every caller — admin panel and user panel both, no branching by role.
    // Went 2K -> 1K -> (briefly, invalid) '0.5K' -> 1K -> 512 -> back to 1K, across several rounds
    // of the same speed-vs-quality tension: 512 made generation faster but the actual image quality
    // dropped too far (real client feedback: "too low resolution"), so this settled back on 1K —
    // gemini-3.1-flash-image's own documented default — as the working middle ground between the
    // original slow 2K and the too-soft 512. If it's still too slow, the next step down is 512
    // (confirmed-working value, unlike the invalid '0.5K'); if it's still too soft, the next step up
    // is 2K. engineMode is still accepted on the request body (older/cached clients may still send
    // it) but no longer has any effect — kept only so a stray 'test' value can never throw here.
    // High resolutions are honored only when explicitly requested (the event board's
    // Approve flow asks for 4K, falling back to 2K); everything else stays on 1K.
    const resolvedImageSize = ['2K', '4K'].includes(imageSize) ? imageSize : '1K';

    // Owner decision: EVERY user-initiated modification (Modify Design and Other option
    // alike) counts against the modify quota — the old "first modification is free"
    // exemption is gone, and since it lived server-side there is no client flag that can
    // reinstate it.
    if (isUserInitiatedEdit) {
      // Owner rule: the FIRST modification/other-option per project is on us (lib/free-mod.js
      // is the atomic source of truth). When granted, no quota check and no increment.
      const body = req.body || {};
      const freeApplied = body.isFreeFirstModification
        ? await tryConsumeFreeFirstModification(sql, caller.userId, body.projectId)
        : false;
      if (!freeApplied) {
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

    const callModel = async (parts, modalities) => {
      const geminiResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: modalities,
            imageConfig: { imageSize: resolvedImageSize, aspectRatio: resolvedAspectRatio },
          },
        }),
      });
      const data = await geminiResponse.json();
      // Fire-and-forget usage logging for the admin Service Usage & Billing panel — never
      // awaited, never allowed to affect the actual generation (see lib/usage-log.js).
      logAiCall({ provider: 'gemini', endpoint: 'generate-image-gemini', ok: geminiResponse.ok, status: geminiResponse.status, message: !geminiResponse.ok ? ((data.error && data.error.message) || '') : '' });
      return { geminiResponse, data };
    };

    let { geminiResponse, data } = await callModel(requestParts, ['TEXT', 'IMAGE']);

    if (!geminiResponse.ok) {
      // Full raw error to the Vercel function logs only — the client gets a provider-free
      // message (OWNER RULE: users must never see which providers power DesignsLab). The
      // raw status/body distinguish wrong-model vs billing vs availability causes.
      console.error('Gemini image request failed:', geminiResponse.status, model, JSON.stringify(data));
      res.status(geminiResponse.status).json({ error: { message: GENERIC_IMAGE_ERROR } });
      return;
    }

    const extractImagePart = (d) => {
      const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
      return { imagePart: parts.find((p) => p.inlineData && p.inlineData.data), textPart: parts.find((p) => p.text) };
    };

    let { imagePart, textPart } = extractImagePart(data);

    // The model occasionally ANSWERS the brief in prose ("I have rendered the stand…")
    // instead of returning the render — seen in the wild on Modify Design with global
    // design changes. One automatic retry with an image-only response modality and an
    // explicit output instruction recovers nearly all of these without the user ever
    // seeing a failure (the quota was already spent, so the retry protects the user's
    // credit as much as the experience).
    if (!imagePart) {
      console.error('Gemini returned text instead of an image — retrying image-only. Text was:', textPart ? textPart.text.slice(0, 300) : '(none)');
      const retryParts = requestParts.slice(0, -1).concat([{
        text: requestParts[requestParts.length - 1].text +
          '\n\nOUTPUT REQUIREMENT — ABSOLUTE: Respond with the rendered IMAGE ONLY. Do NOT describe the design, do NOT summarize what you did, do NOT reply with any text. Your entire response must be a single generated image.',
      }]);
      ({ geminiResponse, data } = await callModel(retryParts, ['IMAGE']));
      if (geminiResponse.ok) ({ imagePart, textPart } = extractImagePart(data));
    }

    if (!imagePart) {
      // Both attempts failed to produce an image. Provider name and the model's own prose
      // stay in the server logs only.
      console.error('Gemini produced no image after retry. Last text:', textPart ? textPart.text.slice(0, 300) : '(none)');
      res.status(500).json({ error: { message: 'The design engine responded without an image this time. Please submit again — your request itself was fine.' } });
      return;
    }

    const mime = imagePart.inlineData.mimeType || 'image/png';
    res.status(200).json({ image: `data:${mime};base64,${imagePart.inlineData.data}` });
  } catch (err) {
    console.error('generate-image-gemini unexpected error:', err);
    res.status(500).json({ error: { message: scrubProviderText(err && err.message) || 'Unexpected server error.' } });
  }
};
