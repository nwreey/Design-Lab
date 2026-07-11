import crypto from 'crypto';

/* Signs a simple "expiry.signature" token using SITE_PASSWORD as the HMAC key. This is not
   a general-purpose auth system — it's a same-level replacement for the Basic Auth this
   project used before: a single shared site password, just fronted by a real login page
   instead of the browser's native prompt. The signature stops a client from forging or
   extending a cookie themselves (they'd need the server-side password to compute it),
   without needing a separate secret or a session store. */
function signToken(expiry, secret) {
  return crypto.createHmac('sha256', secret).update(String(expiry)).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
    return;
  }

  const validUser = process.env.SITE_USERNAME || '';
  const validPass = process.env.SITE_PASSWORD || '';
  if (!validUser || !validPass) {
    res.status(500).json({ error: { message: 'Server misconfiguration: SITE_USERNAME / SITE_PASSWORD are not set.' } });
    return;
  }

  const { username, password, remember } = req.body || {};

  // Constant-time-ish comparison isn't critical for a single shared site password behind
  // TLS, but there's no reason not to use timingSafeEqual where lengths already match.
  const userOk = typeof username === 'string' && username === validUser;
  const passOk = typeof password === 'string' && password.length === validPass.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(validPass));

  if (!userOk || !passOk) {
    res.status(401).json({ error: { message: 'Incorrect username or password.' } });
    return;
  }

  const maxAgeSeconds = remember ? 30 * 24 * 3600 : 8 * 3600;
  const expiry = Math.floor(Date.now() / 1000) + maxAgeSeconds;
  const signature = signToken(expiry, validPass);
  const token = `${expiry}.${signature}`;

  res.setHeader('Set-Cookie', `design_lab_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
  res.status(200).json({ ok: true });
}
