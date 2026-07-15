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

    if (!openaiResponse.ok) {
      res.status(openaiResponse.status).json({ error: data.error || { message: 'OpenAI request failed.' } });
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
