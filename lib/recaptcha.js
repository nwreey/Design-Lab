/* ================= reCAPTCHA v3 server-side verification =================
   Shared by every public form endpoint (contact/enterprise, signup, login). v3 is the
   invisible, score-based variant: the client attaches a token per submission and Google
   scores it 0.0 (bot) to 1.0 (human); we reject below 0.5 (Google's recommended default).

   Setup: create v3 keys at https://www.google.com/recaptcha/admin/create for
   designslab.ai, put the SITE key in /recaptcha-config.js and the SECRET key in the
   RECAPTCHA_SECRET_KEY Vercel env var.

   Fail-open by configuration: if RECAPTCHA_SECRET_KEY is not set, verification is
   skipped entirely — forms keep working before the keys exist. Once the secret IS set,
   a missing/invalid/low-score token rejects the submission.
   Fail-open on Google outage: if the siteverify call itself errors, the submission is
   allowed through (the per-IP rate limits remain as the backstop) — a Google hiccup
   must not take down signups.

   CommonJS on purpose — same mixed ESM/CJS interop reasoning as lib/usage-log.js. */

async function verifyRecaptcha(token, expectedAction, ip) {
  const secret = (process.env.RECAPTCHA_SECRET_KEY || '').trim();
  if (!secret) return { ok: true, skipped: true };
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing token' };
  try {
    const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token.slice(0, 2000), remoteip: ip || '' }).toString(),
    });
    const data = await resp.json().catch(() => ({}));
    if (!data.success) {
      const reason = (data['error-codes'] || []).join(',') || 'verification failed';
      // Server logs only — never shown to visitors. 'invalid-input-secret' here means the
      // RECAPTCHA_SECRET_KEY env var doesn't belong to the site key the pages are using.
      console.error('recaptcha: siteverify rejected:', reason);
      return { ok: false, reason };
    }
    if (expectedAction && data.action && data.action !== expectedAction) {
      console.error('recaptcha: action mismatch — expected', expectedAction, 'got', data.action);
      return { ok: false, reason: 'action mismatch (' + data.action + ')' };
    }
    if (typeof data.score === 'number' && data.score < 0.5) {
      console.error('recaptcha: low score', data.score, 'for action', expectedAction);
      return { ok: false, reason: 'low score ' + data.score };
    }
    return { ok: true, score: data.score };
  } catch (err) {
    console.error('recaptcha: siteverify unreachable (allowing submission):', err && err.message);
    return { ok: true, unavailable: true };
  }
}

/* The message every endpoint returns on a failed check — one place, consistent wording. */
const RECAPTCHA_FAIL_MESSAGE = 'Security check failed. Please reload the page and try again.';

module.exports = { verifyRecaptcha, RECAPTCHA_FAIL_MESSAGE };
