/* ================= Transactional email (Mandrill / Mailchimp Transactional) =================
   One shared module for every notification email the platform sends, so all of them share
   the same professional branded template and the same delivery path. Imported by the api/
   serverless functions (Vercel bundles lib/ files into each function automatically; nothing
   under lib/ is ever exposed as an endpoint itself).

   Sender: notification@designslab.ai (per explicit product decision).
   API key: read from the MANDRILL_API_KEY environment variable — NEVER hardcoded here,
   so the key can be rotated in Vercel without a code change and never lives in git.

   Delivery is deliberately fire-safe: sendTransactionalEmail never throws. Email is a
   courtesy layer on top of flows that must keep working even if Mandrill is down or the
   env var isn't set yet — the caller gets back { sent, error } to log, and the main
   operation (signup, purchase, approval) always completes regardless.

   Note for deployment: Mandrill only delivers reliably once the sending domain
   (designslab.ai) is verified in Mailchimp Transactional (SPF + DKIM records). Until
   then sends may be rejected — the error surfaces in the Vercel function logs. */

const FROM_EMAIL = 'notification@designslab.ai';
const FROM_NAME = 'DesignsLab AI';
const SITE_URL = 'https://designslab.ai';
const MANDRILL_SEND_URL = 'https://mandrillapp.com/api/1.0/messages/send.json';
import { logAiCall } from './usage-log.js';

/* ---------- Branded template ----------
   Table-based layout with inline styles (email clients ignore <style> blocks and modern
   CSS), monochrome brand language matching the site: black wordmark band, white content
   card, single black CTA button, quiet legal footer. Text-based wordmark rather than a
   logo image, since images are blocked by default in most inboxes. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function buildBrandedEmail({ previewText, greeting, paragraphs, ctaLabel, ctaUrl, footnote }) {
  const paras = (paragraphs || []).map(p =>
    `<p style="margin:0 0 16px;font-size:14.5px;line-height:1.7;color:#333333;">${p}</p>`
  ).join('');
  const cta = ctaLabel && ctaUrl ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px auto 6px;">
      <tr>
        <td style="background:#111111;border-radius:12px;">
          <a href="${ctaUrl}" style="display:inline-block;padding:14px 34px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#FFFFFF;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
        </td>
      </tr>
    </table>` : '';
  const foot = footnote
    ? `<p style="margin:22px 0 0;font-size:12px;line-height:1.6;color:#999999;">${footnote}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F4F4;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(previewText || '')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F4;padding:34px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td style="background:#111111;border-radius:16px 16px 0 0;padding:26px 40px;text-align:center;">
            <span style="font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:bold;letter-spacing:-0.3px;color:#FFFFFF;">DesignsLab&nbsp;AI</span><br>
            <span style="font-family:Arial,Helvetica,sans-serif;font-size:10.5px;letter-spacing:2px;color:#9A9A9A;text-transform:uppercase;">AI Design Studio for Events &amp; Exhibitions</span>
          </td>
        </tr>
        <tr>
          <td style="background:#FFFFFF;border-radius:0 0 16px 16px;padding:38px 40px 34px;font-family:Arial,Helvetica,sans-serif;">
            <p style="margin:0 0 18px;font-size:16px;font-weight:bold;color:#111111;">${escapeHtml(greeting || 'Hello,')}</p>
            ${paras}
            ${cta}
            ${foot}
          </td>
        </tr>
        <tr>
          <td style="padding:22px 20px;text-align:center;font-family:Arial,Helvetica,sans-serif;">
            <p style="margin:0;font-size:11.5px;color:#9A9A9A;line-height:1.7;">
              DesignsLab AI &middot; Events &bull; Exhibition Booths &bull; Display Stands<br>
              &copy; 2026 DMR Arabia. All rights reserved.<br>
              <a href="${SITE_URL}" style="color:#9A9A9A;">designslab.ai</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/* ---------- Delivery ---------- */
export async function sendTransactionalEmail({ toEmail, toName, subject, html, replyTo }) {
  const apiKey = process.env.MANDRILL_API_KEY;
  if (!apiKey) {
    console.error('email: MANDRILL_API_KEY is not set — skipping send of "' + subject + '" to ' + toEmail);
    return { sent: false, error: 'MANDRILL_API_KEY not configured' };
  }
  if (!toEmail) {
    return { sent: false, error: 'no recipient email' };
  }
  try {
    const response = await fetch(MANDRILL_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: apiKey,
        message: {
          html,
          subject,
          from_email: FROM_EMAIL,
          from_name: FROM_NAME,
          to: [{ email: toEmail, name: toName || undefined, type: 'to' }],
          // Reply-To lets an internal notification (e.g. a Contact form message sent to
          // info@) be answered with one click straight to the visitor's own address.
          headers: replyTo ? { 'Reply-To': replyTo } : undefined,
          track_opens: true,
          track_clicks: false,
          auto_text: true, // Mandrill generates the plain-text part from the HTML
        },
      }),
    });
    const data = await response.json().catch(() => null);
    // Mandrill returns 200 with a per-recipient array; "rejected"/"invalid" statuses are
    // still delivery failures worth logging even though HTTP succeeded.
    const first = Array.isArray(data) ? data[0] : null;
    if (!response.ok || !first || first.status === 'rejected' || first.status === 'invalid') {
      const reason = first ? (first.reject_reason || first.status) : (data && data.message) || ('HTTP ' + response.status);
      console.error('email: Mandrill did not accept "' + subject + '" to ' + toEmail + ':', reason);
      // Fire-and-forget usage logging for the admin Service Usage & Billing panel (./usage-log.js).
      logAiCall({ provider: 'mandrill', endpoint: 'send-email', ok: false, status: response.status, message: String(reason) });
      return { sent: false, error: String(reason) };
    }
    logAiCall({ provider: 'mandrill', endpoint: 'send-email', ok: true, status: response.status, message: '' });
    return { sent: true };
  } catch (err) {
    console.error('email: send failed for "' + subject + '" to ' + toEmail + ':', err);
    return { sent: false, error: err && err.message ? err.message : 'send failed' };
  }
}

/* ---------- The three product emails ---------- */

// 1. Sent the moment a visitor submits the signup (request access) form.
// NOTE: greeting values are passed RAW — buildBrandedEmail escapes the greeting itself,
// so pre-escaping here would double-escape (rendering artifacts like O&#39;Brien).
export function buildAccessRequestReceivedEmail({ name }) {
  const firstName = (name || '').split(' ')[0] || 'there';
  return {
    subject: 'We received your access request | DesignsLab AI',
    html: buildBrandedEmail({
      previewText: 'Thanks for requesting access to DesignsLab AI. Our team is reviewing your request.',
      greeting: `Hi ${firstName},`,
      paragraphs: [
        'Thank you for requesting access to <strong>DesignsLab AI</strong>, the AI design studio for events &amp; exhibition professionals.',
        'Our team reviews every request personally to make sure the platform is the right fit for your work. You’ll hear from us at this email address, usually within <strong>one business day</strong>.',
        'Once your account is approved, we’ll set it up for you and send your sign-in details.',
      ],
      ctaLabel: 'Explore the Product',
      ctaUrl: SITE_URL + '/product.html',
      footnote: 'You’re receiving this email because this address was used to request access at designslab.ai. If that wasn’t you, you can safely ignore this message.',
    }),
  };
}

// 2. Sent when a registered user's plan purchase request is recorded successfully.
export function buildPurchaseRequestEmail({ username, plan }) {
  const safePlan = escapeHtml(plan);
  return {
    subject: `Your ${plan} plan request is confirmed | DesignsLab AI`,
    html: buildBrandedEmail({
      previewText: `We received your ${plan} plan request. Our team is activating it for you.`,
      greeting: `Hi ${username || 'there'},`, // raw — buildBrandedEmail escapes the greeting
      paragraphs: [
        `Great choice! We’ve received your request for the <strong>${safePlan}</strong> plan.`,
        'Our team is preparing your plan activation now and will contact you shortly to complete the setup. You don’t need to do anything else at this point.',
        'You can keep using your account as usual in the meantime.',
      ],
      ctaLabel: 'Open DesignsLab AI',
      ctaUrl: SITE_URL + '/login.html',
      footnote: 'You’re receiving this email because a plan was requested from your DesignsLab AI account. If this wasn’t you, please contact us immediately.',
    }),
  };
}

// 4. Internal notification: a Contact form message, delivered to the company inbox
// (info@designslab.ai — see api/contact.js). Every visitor-provided value is escaped;
// the visitor's address is repeated in the body AND set as Reply-To by the caller.
export function buildContactMessageEmail({ name, email, subject, message }) {
  const safeSubject = (subject || '').trim();
  return {
    subject: `New contact message${safeSubject ? ': ' + safeSubject : ''} | designslab.ai`,
    html: buildBrandedEmail({
      previewText: `New message from ${name} via the designslab.ai contact form.`,
      greeting: 'New message from the Contact form',
      paragraphs: [
        `<strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;`,
        safeSubject ? `<strong>Subject:</strong> ${escapeHtml(safeSubject)}` : '',
        `<div style="border-left:3px solid #111111;padding:10px 16px;background:#F7F7F7;border-radius:0 8px 8px 0;white-space:pre-wrap;">${escapeHtml(message)}</div>`,
        'Reply directly to this email to answer them. The Reply-To is set to their address.',
      ].filter(Boolean),
      footnote: 'Sent automatically by the designslab.ai contact form.',
    }),
  };
}

// 3. Sent when the admin approves an access request from the admin panel. Per explicit
// product decision the account is created automatically at approval time (username = the
// applicant's email) and this email carries their personal set-password link — clicking
// it lets them choose a password and lands them signed in directly, no separate
// credentials message needed.
export function buildAccessApprovedEmail({ name, email, setupUrl }) {
  const firstName = (name || '').split(' ')[0] || 'there'; // raw — buildBrandedEmail escapes the greeting
  return {
    subject: 'Your DesignsLab AI account is approved 🎉',
    html: buildBrandedEmail({
      previewText: 'Welcome aboard! Set your password and start designing.',
      greeting: `Hi ${firstName},`,
      paragraphs: [
        'Good news! Your access request has been <strong>approved</strong>. Welcome to DesignsLab AI!',
        `Your account is ready. Your username is your email address:<br><strong>${escapeHtml(email || '')}</strong>`,
        'Click the button below to set your password. You’ll be signed in immediately and can start creating exhibition booths, event concepts, and presentation-ready visuals right away.',
        'This link is personal to you and expires in 7 days.',
      ],
      ctaLabel: 'Set Your Password & Sign In',
      ctaUrl: setupUrl || (SITE_URL + '/login.html'),
      footnote: 'You’re receiving this email because your access request at designslab.ai was approved. If you didn’t request access, you can safely ignore this message. Need help? Just reply to this email.',
    }),
  };
}
