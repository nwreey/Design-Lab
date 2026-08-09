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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'Server is missing OPENAI_API_KEY. Set it in your Vercel project environment variables.' } });
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

    if (!openaiResponse.ok) {
      res.status(openaiResponse.status).json({ error: data.error || { message: 'OpenAI request failed.' } });
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
      res.status(502).json({ error: { message: 'OpenAI returned no usable output text.' }, raw: data });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch (parseErr) {
      // Structured Outputs' strict mode is specifically designed to make this unreachable in
      // practice — surfaced as a real error rather than silently swallowed, so a genuine API-side
      // anomaly is never mistaken for a clean empty result.
      res.status(502).json({ error: { message: 'OpenAI returned output that was not valid JSON despite a strict schema.' }, raw: outputText.slice(0, 2000) });
      return;
    }

    res.status(200).json({ result: parsed });
  } catch (err) {
    res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
  }
};
