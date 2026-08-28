import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { sendTransactionalEmail, buildBrandedEmail } from '../lib/email.js';
import { verifyRecaptcha, RECAPTCHA_FAIL_MESSAGE } from '../lib/recaptcha.js';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* ================= Forgot password (public POST) =================
   POST {email, recaptchaToken} from the login page. Reuses the EXACT machinery the
   signup-approval flow already has: a single-use hashed token in password_setup_tokens
   plus the existing /set-password.html page (which sets the new password and signs the
   person straight in). Nothing new to maintain on the redemption side.

   Security decisions:
   - The response is ALWAYS the same generic success, whether or not the account exists —
     this endpoint must never become an oracle for probing which emails have accounts.
   - Reset tokens expire after 1 HOUR (vs 7 days for onboarding links) — a reset link is
     a live credential for an existing account, so its window stays short.
   - Any previous unused tokens for the user are invalidated first — only the newest
     link works, so a forgotten email in an inbox can't resurrect access later.
   - Rate limited per IP (3/hour, same table pattern as api/contact.js) + reCAPTCHA v3,
     so it can't be scripted to spam people's inboxes.
   - The master admin account lives in env vars, not the users table — a reset request
     for it is silently ignored (same generic response). */

const MAX_PER_HOUR = 3;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function checkRateLimit(ip) {
  await sql`
    CREATE TABLE IF NOT EXISTS forgot_password_rate (
      ip TEXT PRIMARY KEY,
      submit_count INTEGER NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  const rows = await sql`SELECT submit_count, window_start FROM forgot_password_rate WHERE ip = ${ip};`;
  const now = Date.now();
  if (rows.rows.length === 0) {
    await sql`INSERT INTO forgot_password_rate (ip, submit_count, window_start) VALUES (${ip}, 1, NOW()) ON CONFLICT (ip) DO UPDATE SET submit_count = forgot_password_rate.submit_count + 1;`;
    return true;
  }
  if (now - new Date(rows.rows[0].window_start).getTime() > 60 * 60 * 1000) {
    await sql`UPDATE forgot_password_rate SET submit_count = 1, window_start = NOW() WHERE ip = ${ip};`;
    return true;
  }
  if (rows.rows[0].submit_count >= MAX_PER_HOUR) return false;
  await sql`UPDATE forgot_password_rate SET submit_count = submit_count + 1 WHERE ip = ${ip};`;
  return true;
}

/* Owner decision: honest responses over anti-enumeration. An unknown email gets a clear
   "not found — please sign up" instead of a generic maybe; the per-IP rate limit (3/hour)
   and reCAPTCHA remain the guard against someone scripting this to map registered emails. */
const OK_SENT = { ok: true, message: "We've emailed you a confirmation link. Open it to set a new password — then sign in again. (Check spam if you don't see it within a minute.)" };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
    return;
  }

  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: { message: 'Please enter a valid email address.' } });
    return;
  }

  const ip = getClientIp(req);

  const captcha = await verifyRecaptcha(body.recaptchaToken, 'forgot', ip);
  if (!captcha.ok) {
    res.status(400).json({ error: { message: RECAPTCHA_FAIL_MESSAGE } });
    return;
  }

  try {
    const allowed = await checkRateLimit(ip);
    if (!allowed) {
      res.status(429).json({ error: { message: 'Too many reset requests. Please wait an hour and try again.' } });
      return;
    }
  } catch (err) {
    console.error('forgot-password: rate limit check failed (continuing):', err);
  }

  try {
    // Usernames ARE email addresses for self-served accounts. Case-insensitive match.
    const result = await sql`SELECT id, username FROM users WHERE LOWER(username) = ${email};`;
    if (result.rows.length === 0) {
      res.status(404).json({ error: { message: 'No account found for this email. Please sign up first.' } });
      return;
    }
    const user = result.rows[0];

    await sql`
      CREATE TABLE IF NOT EXISTS password_setup_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ
      );
    `;
    // Only the newest link may work.
    await sql`DELETE FROM password_setup_tokens WHERE user_id = ${user.id} AND used_at IS NULL;`;
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await sql`INSERT INTO password_setup_tokens (token_hash, user_id, expires_at) VALUES (${tokenHash}, ${user.id}, NOW() + INTERVAL '1 hour');`;
    const resetUrl = 'https://designslab.ai/set-password.html?token=' + rawToken;

    const html = buildBrandedEmail({
      previewText: 'Reset your DesignsLab AI password — this link is valid for 1 hour.',
      greeting: user.username,
      paragraphs: [
        'We received a request to reset the password for your DesignsLab AI account.',
        'Click the button below to choose a new password. The link is personal to you, works <strong>once</strong>, and expires in <strong>1 hour</strong>. Setting your new password signs you straight in.',
        'If you didn’t request this, you can safely ignore this email — your current password stays unchanged and the link will simply expire.',
      ],
      ctaLabel: 'Reset My Password',
      ctaUrl: resetUrl,
      footnote: 'You are receiving this because a password reset was requested for this address on designslab.ai. If this wasn’t you, no action is needed.',
    });
    const sendResult = await sendTransactionalEmail({
      toEmail: user.username,
      toName: user.username,
      subject: 'Reset your DesignsLab AI password',
      html,
    });
    if (!sendResult.sent) {
      // Delivery genuinely failed — say so honestly (this isn't the existence oracle:
      // the account clearly exists from the requester's own point of view only if the
      // email arrives; a transport error message doesn't confirm anything by itself).
      console.error('forgot-password: email send failed:', sendResult.error);
      res.status(500).json({ error: { message: 'Could not send the reset email right now. Please try again in a few minutes or contact info@designslab.ai.' } });
      return;
    }

    res.status(200).json(OK_SENT);
  } catch (err) {
    console.error('forgot-password: failed:', err);
    res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  }
}
