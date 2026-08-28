const { logAiCall } = require('../lib/usage-log.js');
const { scrubProviderText, GENERIC_TEXT_ERROR } = require('../lib/safe-error.js');
const { requireCaller } = require('../lib/require-auth.js');

module.exports = async (req, res) => {
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

  if (!requireCaller(req, res)) return;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'The design service is not configured on the server. Please contact the administrator.' } });
    return;
  }

  try {
    const { system, messages, max_tokens } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: { message: 'Request body must include a non-empty "messages" array.' } });
      return;
    }

    const openaiMessages = [];
    if (system) {
      openaiMessages.push({ role: 'system', content: system });
    }

    messages.forEach((m) => {
      if (Array.isArray(m.content)) {
        const converted = m.content
          .map((block) => {
            if (block.type === 'text') {
              return { type: 'text', text: block.text };
            }
            if (block.type === 'image') {
              const mime = block.source && block.source.media_type;
              const data = block.source && block.source.data;
              if (!mime || !data) return null;
              return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } };
            }
            return null;
          })
          .filter(Boolean);
        openaiMessages.push({ role: m.role, content: converted });
      } else {
        openaiMessages.push({ role: m.role, content: m.content });
      }
    });

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: openaiMessages,
        max_tokens: max_tokens || 8192,
      }),
    });

    const data = await openaiResponse.json();

    // Fire-and-forget usage logging for the admin Service Usage & Billing panel (lib/usage-log.js).
    logAiCall({ provider: 'openai', endpoint: 'generate', ok: openaiResponse.ok, status: openaiResponse.status, message: !openaiResponse.ok ? ((data.error && data.error.message) || '') : '' });

    if (!openaiResponse.ok) {
      console.error('OpenAI generate failed:', openaiResponse.status, JSON.stringify(data.error || {}).slice(0, 500));
      res.status(openaiResponse.status).json({ error: { message: GENERIC_TEXT_ERROR } });
      return;
    }

    const text =
      (data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content) ||
      '';

    // Pass finish_reason through so the client can tell a genuinely truncated response
    // ("length" — ran out of max_tokens mid-output) apart from any other kind of malformed
    // JSON, instead of guessing from the parse error alone.
    const finishReason = (data.choices && data.choices[0] && data.choices[0].finish_reason) || null;

    res.status(200).json({ content: [{ type: 'text', text }], finish_reason: finishReason });
  } catch (err) {
    res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
  }
};
