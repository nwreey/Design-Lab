/* Auto Fill Engine v2 backend — a thin, generic Structured-Outputs passthrough, deliberately kept
   domain-agnostic (no booth/event-specific logic lives here at all) so the SAME endpoint can be
   reused for every future project type the client asked for (pavilion, conference, retail
   activation, experience center) — see ai-design-studio.html's own "Auto Fill Engine v2" comment
   block for the client-facing side of this. The frontend already builds the full system prompt
   AND a strict JSON Schema tailored to whichever form is on screen (see buildAutofillFieldsSchema
   and its callers); this endpoint's only job is: never expose the OpenAI key to the browser (per
   explicit client requirement), call OpenAI's Responses API with that schema in Structured
   Outputs' strict mode, and hand back whatever JSON object comes back — or a clear, honest error
   if it can't.

   Distinct from api/generate.js (the older Chat Completions passthrough still used by the
   booth/event two-stage design pipeline) specifically because Structured Outputs strict mode and
   multi-image input use the Responses API's own request/response shape, not Chat Completions' —
   trying to bolt both shapes onto one endpoint would make either caller harder to reason about. */
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* Auth + per-user AI Auto-Fill quota (added with the trial-account rollout: every
   auto-approved user gets autofill_limit 1 by default; NULL = unlimited; admins and the
   master admin are exempt, matching every other quota in this app). The middleware
   already keeps guests out; this re-verifies the token to know WHICH user is calling,
   same defense-in-depth token check as api/admin-users.js. */
function verifyTokenNode(token, secret) {
  if (!token) return null;
  const separatorIndex = token.indexOf('.');
  if (separatorIndex === -1) return null;
  const payloadB64 = token.substring(0, separatorIndex);
  const signature = token.substring(separatorIndex + 1);
  const expectedSignature = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  if (signature !== expectedSignature) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')); } catch (err) { return null; }
  if (!payload.expiry || payload.expiry < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

const { logAiCall } = require('../lib/usage-log.js');
const { scrubProviderText, GENERIC_TEXT_ERROR } = require('../lib/safe-error.js');

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

  // ---- Quota gate (before any OpenAI cost is incurred) ----
  const callerToken = parseCookie(req.headers.cookie, 'design_lab_auth');
  const caller = verifyTokenNode(callerToken, process.env.SITE_PASSWORD || '');
  if (!caller) {
    res.status(401).json({ error: { message: 'Please sign in to use AI Auto Fill.' } });
    return;
  }
  const quotaApplies = caller.role !== 'admin' && caller.userId !== 'master-admin';
  if (quotaApplies) {
    try {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS autofill_limit INTEGER;`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS autofill_count INTEGER NOT NULL DEFAULT 0;`;
      const rows = await sql`SELECT autofill_limit, autofill_count FROM users WHERE id = ${String(caller.userId)};`;
      if (rows.rows.length > 0) {
        const { autofill_limit, autofill_count } = rows.rows[0];
        if (autofill_limit != null && (autofill_count || 0) >= autofill_limit) {
          res.status(403).json({ error: {
            code: 'autofill_quota',
            message: `You've used your AI Auto Fill allowance (${autofill_count} of ${autofill_limit}). Please fill in the form manually, or contact us to increase your allowance.`,
          } });
          return;
        }
      }
    } catch (err) {
      // A broken quota lookup must never take the whole feature down — log and continue.
      console.error('autofill: quota check failed (continuing):', err);
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'The design service is not configured on the server. Please contact the administrator.' } });
    return;
  }

  try {
    const { system, content, schema, schemaName, max_output_tokens } = req.body || {};

    if (!system || typeof system !== 'string') {
      res.status(400).json({ error: { message: 'Request body must include a "system" string.' } });
      return;
    }
    if (!Array.isArray(content) || content.length === 0) {
      res.status(400).json({ error: { message: 'Request body must include a non-empty "content" array.' } });
      return;
    }
    if (!schema || typeof schema !== 'object') {
      res.status(400).json({ error: { message: 'Request body must include a "schema" object (a JSON Schema for Structured Outputs).' } });
      return;
    }

    // Converts this app's existing content-part convention (used throughout
    // ai-design-studio.html — { type: 'text', text } / { type: 'image', source: { type: 'base64',
    // media_type, data } }) into the Responses API's own input-part shape. Kept here, not
    // duplicated client-side, so the frontend never needs to know which OpenAI API version is
    // actually in use underneath.
    const userContent = content
      .map((block) => {
        if (block.type === 'text') return { type: 'input_text', text: block.text };
        if (block.type === 'image') {
          const mime = block.source && block.source.media_type;
          const data = block.source && block.source.data;
          if (!mime || !data) return null;
          return { type: 'input_image', image_url: `data:${mime};base64,${data}` };
        }
        return null;
      })
      .filter(Boolean);

    const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        input: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: schemaName || 'autofill_result',
            schema,
            strict: true,
          },
        },
        // The full field schema for a large form (every Requirements checkbox/quantity pair,
        // plus a proposed Brand Portfolio or Area Planning array) can run to a sizeable response —
        // same reasoning as callPromptWriterApi's own max_tokens comment on the older pipeline.
        max_output_tokens: max_output_tokens || 16000,
      }),
    });

    const data = await openaiResponse.json();

    // Fire-and-forget usage logging for the admin Service Usage & Billing panel (lib/usage-log.js).
    logAiCall({ provider: 'openai', endpoint: 'autofill', ok: openaiResponse.ok, status: openaiResponse.status, message: !openaiResponse.ok ? ((data.error && data.error.message) || '') : '' });

    if (!openaiResponse.ok) {
      console.error('OpenAI autofill failed:', openaiResponse.status, JSON.stringify(data.error || {}).slice(0, 500));
      res.status(openaiResponse.status).json({ error: { message: GENERIC_TEXT_ERROR } });
      return;
    }

    // The Responses API's raw HTTP shape nests the actual message under output[] (an array that
    // can also contain non-message items like reasoning summaries) — walk it defensively rather
    // than assuming output[0] is always the message, and separately detect a refusal item (the
    // model declining to produce structured output for this input) so the frontend can surface
    // that distinctly from a genuine parse failure. Falls back to the SDK-convenience
    // "output_text" field if a future API revision starts sending that directly.
    let outputText = typeof data.output_text === 'string' ? data.output_text : '';
    let refusalText = '';
    if (!outputText && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (!item || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part && part.type === 'output_text' && typeof part.text === 'string') outputText += part.text;
          if (part && part.type === 'refusal' && typeof part.refusal === 'string') refusalText += part.refusal;
        }
      }
    }

    if (refusalText) {
      res.status(200).json({ refusal: refusalText });
      return;
    }
    if (!outputText) {
      console.error('OpenAI autofill returned no output text:', JSON.stringify(data).slice(0, 500));
      res.status(502).json({ error: { message: 'The assistant returned no usable result. Please run Auto Fill again.' } });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch (parseErr) {
      // Structured Outputs' strict mode is specifically designed to make this unreachable in
      // practice — surfaced as a real error rather than silently swallowed, so a genuine API-side
      // anomaly is never mistaken for a clean empty result.
      console.error('OpenAI autofill returned invalid JSON:', outputText.slice(0, 500));
      res.status(502).json({ error: { message: 'The assistant returned an unreadable result. Please run Auto Fill again.' } });
      return;
    }

    // Successful generation — consume one auto-fill from the caller's allowance. Counted
    // only here, after OpenAI actually returned a usable result: a failed or refused run
    // never costs the user their allowance.
    if (quotaApplies) {
      try {
        await sql`UPDATE users SET autofill_count = COALESCE(autofill_count, 0) + 1 WHERE id = ${String(caller.userId)};`;
      } catch (err) {
        console.error('autofill: could not increment autofill_count:', err);
      }
    }
    res.status(200).json({ result: parsed });
  } catch (err) {
    res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
  }
};
