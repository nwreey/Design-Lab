import crypto from 'crypto';
import dns from 'dns';

/* ================= SSRF protection =================
   This endpoint fetches a user-supplied URL on the server. Without these checks a
   signed-in user could point it at INTERNAL addresses (cloud metadata services,
   localhost, private-network hosts) and read back whatever they return — a classic
   Server-Side Request Forgery. Defense: resolve the hostname and refuse anything
   that lands in a private/reserved range, and re-validate on EVERY redirect hop
   (redirect:'manual' below) so a public host can't bounce us to an internal one. */
function isPrivateIp(ip) {
  if (!ip) return true;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — strip the prefix and test the IPv4 part.
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;            // this-net, private, loopback
    if (a === 169 && b === 254) return true;                       // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;              // private
    if (a === 192 && b === 168) return true;                       // private
    if (a === 100 && b >= 64 && b <= 127) return true;             // CGNAT
    if (a >= 224) return true;                                     // multicast/reserved
    return false;
  }
  // IPv6: loopback, unspecified, link-local, unique-local.
  const lower = ip.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fe80:') ||
         lower.startsWith('fc') || lower.startsWith('fd');
}

async function assertPublicHost(parsed) {
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host === 'metadata.google.internal') {
    throw new Error('blocked-host');
  }
  // IP literal? Test it directly (URL keeps IPv6 literals in brackets).
  const bare = host.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(bare) || bare.includes(':')) {
    if (isPrivateIp(bare)) throw new Error('blocked-host');
    return;
  }
  // Hostname: resolve every address it maps to; ANY private result blocks the fetch.
  const results = await dns.promises.lookup(bare, { all: true, verbatim: true });
  if (!results.length || results.some(r => isPrivateIp(r.address))) throw new Error('blocked-host');
}

/* Same token verification duplicated across the auth-aware endpoints in this project — see
   api/projects.js for the fuller explanation of why this isn't a shared import. Route-level
   protection already lives in middleware.js (every non-public path requires a valid session),
   but this endpoint re-derives the caller independently too, same "defense in depth" reasoning
   as api/admin-users.js — a bug or future change in the middleware's path list can't silently
   turn this into an open URL-fetching proxy. This used to also require caller.role === 'admin',
   back when the only thing that called it (the AI Auto-fill Helper) was an admin-only test —
   now that the helper is open to every user, any logged-in caller is enough here. */
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

// Strips <script>/<style>/<noscript> blocks entirely (their text content is never real page
// copy), then strips every remaining tag, then collapses whitespace/decodes the handful of
// entities actually likely to show up in ordinary marketing copy. Intentionally not a full
// HTML parser — this only needs to turn a page into rough readable text for an AI prompt, not
// produce clean structured content.
function htmlToPlainText(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  return text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim().slice(0, 200) : '';
}

export default async function handler(req, res) {
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
    res.status(403).json({ error: { message: 'You must be signed in to use this.' } });
    return;
  }

  try {
    let { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: { message: 'Request body must include a "url" string.' } });
      return;
    }
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      res.status(400).json({ error: { message: 'That does not look like a valid URL.' } });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ error: { message: 'Only http/https URLs are supported.' } });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      // Redirects are followed MANUALLY so each hop's host gets the same SSRF check —
      // otherwise a public URL could 302 to an internal address and bypass the guard.
      let currentUrl = parsed;
      for (let hop = 0; hop <= 3; hop++) {
        await assertPublicHost(currentUrl);
        response = await fetch(currentUrl.toString(), {
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            // A generic browser-like UA — some marketing sites block obvious non-browser
            // clients outright, which would otherwise make this feature fail on exactly the
            // kind of company website it's meant to read.
            'User-Agent': 'Mozilla/5.0 (compatible; DesignsLabAI/1.0; +https://designslab.ai)',
            Accept: 'text/html,application/xhtml+xml',
          },
        });
        if (response.status >= 300 && response.status < 400) {
          const loc = response.headers.get('location');
          if (!loc || hop === 3) break;
          currentUrl = new URL(loc, currentUrl);
          if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') break;
          continue;
        }
        break;
      }
    } catch (err) {
      const message = err && err.message === 'blocked-host'
        ? 'That address is not reachable from here — please use a public website URL.'
        : err && err.name === 'AbortError'
          ? 'Timed out reading that website.'
          : 'Could not reach that website: ' + (err && err.message ? err.message : 'unknown error');
      res.status(200).json({ text: '', title: '', warning: message });
      return;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      res.status(200).json({ text: '', title: '', warning: `Website responded with HTTP ${response.status} — continuing without it.` });
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('xml') && contentType !== '') {
      res.status(200).json({ text: '', title: '', warning: 'That URL did not return an HTML page — continuing without it.' });
      return;
    }

    // Cap how much we read, not just how much we keep — a huge page shouldn't tie up the
    // function buffering megabytes of markup we're about to throw away anyway.
    const reader = response.body ? response.body.getReader() : null;
    let html = '';
    if (reader) {
      const decoder = new TextDecoder();
      let received = 0;
      const CAP = 2_000_000; // 2MB of raw HTML is far more than enough for any marketing page's visible copy
      while (received < CAP) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        html += decoder.decode(value, { stream: true });
      }
      try { reader.cancel(); } catch (e) { /* ignore */ }
    } else {
      html = await response.text();
    }

    const title = extractTitle(html);
    const text = htmlToPlainText(html).slice(0, 8000); // plenty for a design brief; keeps the downstream AI prompt a sane size

    res.status(200).json({ text, title });
  } catch (err) {
    res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
  }
}
