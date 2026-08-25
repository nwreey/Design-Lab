import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* ================= Set-password endpoint (approval onboarding) =================
   The other half of the one-click onboarding started in api/signup.js's approval flow:
   the applicant clicks the personal link in their approval email, chooses a password
   here, and is signed in immediately (same cookie/token scheme as api/login.js), so
   there is never a separate "here are your credentials" message.

   POST {token, password}:
   - token: the raw 64-hex single-use token from the email link. Only its SHA-256 hash
     is stored server-side; tokens expire after 7 days and are consumed on first use.
   - password: min 6 chars (same rule as admin-created accounts).
   On success: sets the user's real password (scrypt salt:hash, same as api/login.js),
   marks the token used, and returns Set-Cookie design_lab_auth so the browser lands
   in the studio already authenticated.

   GET ?token= : lightweight pre-check used by set-password.html on load, so an expired
   or already-used link shows an honest message instead of a form that fails on submit.
   Reveals only validity + the username it belongs to (their own email), nothing else. */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function signToken(payloadObj, secret) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

async function findValidToken(rawToken) {
  if (!/^[a-f0-9]{64}$/.test(rawToken || '')) return null;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const rows = await sql`
    SELECT t.token_hash, t.user_id, t.expires_at, t.used_at, u.username, u.role
    FROM password_setup_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ${tokenHash};
  `;
  if (rows.rows.length === 0) return null;
  const row = rows.rows[0];
  if (row.used_at) return { invalid: 'used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { invalid: 'expired' };
  return row;
}

export default async function handler(req, res) {
  const signingSecret = process.env.SITE_PASSWORD || '';

  if (req.method === 'GET') {
    try {
      const found = await findValidToken((req.query && req.query.token) || '');
      if (!found) {
        res.status(200).json({ valid: false, reason: 'invalid' });
        return;
      }
      if (found.invalid) {
        res.status(200).json({ valid: false, reason: found.invalid });
        return;
      }
      res.status(200).json({ valid: true, username: found.username });
    } catch (err) {
      console.error('set-password: token check failed:', err);
      res.status(500).json({ error: { message: 'Could not check this link right now. Please try again.' } });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed.' } });
    return;
  }

  const { token, password } = req.body || {};
  if (typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: { message: 'Please choose a password of at least 6 characters.' } });
    return;
  }

  try {
    const found = await findValidToken(token || '');
    if (!found || found.invalid) {
      const reason = found && found.invalid === 'expired'
        ? 'This link has expired. Please contact us and we’ll send you a fresh one.'
        : found && found.invalid === 'used'
          ? 'This link was already used. If that wasn’t you, contact us immediately — otherwise just sign in with the password you set.'
          : 'This link is not valid. Please use the exact link from your approval email.';
      res.status(400).json({ error: { message: reason } });
      return;
    }

    // Set the real password, then consume the token — in that order, so a failure
    // between the two can only ever leave a still-usable link, never a locked-out user.
    await sql`UPDATE users SET password_hash = ${hashPassword(password)} WHERE id = ${found.user_id};`;
    await sql`UPDATE password_setup_tokens SET used_at = NOW() WHERE token_hash = ${found.token_hash};`;

    // Sign them in directly — same payload/cookie scheme as api/login.js (8h session,
    // the non-"remember me" default; they can use Remember me on their next sign-in).
    const maxAgeSeconds = 8 * 3600;
    const tokenPayload = {
      userId: found.user_id,
      username: found.username,
      role: found.role,
      expiry: Math.floor(Date.now() / 1000) + maxAgeSeconds,
    };
    const authToken = signToken(tokenPayload, signingSecret);
    res.setHeader('Set-Cookie', `design_lab_auth=${authToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
    res.status(200).json({ ok: true, username: found.username });
  } catch (err) {
    console.error('set-password: could not set password:', err);
    res.status(500).json({ error: { message: 'Could not set your password right now. Please try again.' } });
  }
}
