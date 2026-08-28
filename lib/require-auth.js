/* ================= Shared session verification (defense in depth) =================
   Route-level protection already lives in middleware.js — every non-public path needs a
   valid session cookie before the request even reaches a function. These helpers add the
   SAME check inside the endpoints that spend provider money (OpenAI/image/video calls),
   so a future mistake in the middleware's public-path lists can never silently turn one
   of them into an open, unauthenticated proxy that burns paid API credits.

   CommonJS on purpose — same mixed ESM/CJS interop reasoning as lib/usage-log.js, and
   the CJS endpoints (api/generate.js, api/luma-*.js) can require() it directly. */

const crypto = require('crypto');

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
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload.expiry || payload.expiry < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/* Sends a 401 and returns null when the request has no valid session; returns the
   decoded caller payload ({userId, username, role, expiry}) otherwise. */
function requireCaller(req, res) {
  const caller = getCaller(req);
  if (!caller) {
    res.status(401).json({ error: { message: 'You must be signed in to use this.' } });
    return null;
  }
  return caller;
}

module.exports = { getCaller, requireCaller };
