import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { sendTransactionalEmail, buildContactMessageEmail, buildBrandedEmail } from '../lib/email.js';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* ================= Contact / Get help / Enterprise endpoint =================
   Handles TWO public forms, distinguished by body.kind:
   - 'help' (default): the Get help / Contact form.
   - 'enterprise': the Enterprise access request form (company, phone, size, industry,
     expected users) — same triple pipeline below, with enterprise-specific email copy.

   Public POST — a submitted help request now does THREE things at once (owner request):
   1. Is stored in contact_messages so it appears in the admin panel's Help Requests
      section (nothing depends on email delivery alone anymore).
   2. Is emailed to the company inbox (info@designslab.ai) AND directly to the owner
      (moe@dmrarabia.com), Reply-To set to the visitor so answering goes straight back.
   3. Sends the visitor a branded acknowledgment email ("we got your message") — owner
      decision, overriding the earlier no-auto-reply stance; the per-IP rate limit is the
      spam guard for that. The acknowledgment is best-effort: its failure never fails the
      submission itself.

   Admin-only methods for the panel: GET lists messages, PUT {id,status} marks
   new/handled, DELETE ?id= removes one.

   Rate limited per IP (same table-based approach as api/signup.js): max 5 messages
   per IP per hour. If delivery to our own inboxes fails, the visitor gets an honest
   error pointing them at info@designslab.ai — but the message is still saved for the
   admin panel, and the response says so. */

const CONTACT_INBOX = 'info@designslab.ai';
const OWNER_INBOX = 'moe@dmrarabia.com';

/* TEMPORARY — RATE LIMIT DISABLED FOR OWNER TESTING (set back to false to re-enable).
   Same flag/reason as api/signup.js. */
const RATE_LIMIT_DISABLED = true;

/* Same admin re-verification as the other admin-aware endpoints (see api/admin-users.js). */
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

async function ensureMessagesSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  // Enterprise-request columns (idempotent migrations — the table may pre-exist without them).
  await sql`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'help';`;
  await sql`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS company TEXT;`;
  await sql`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS phone TEXT;`;
  await sql`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS meta JSONB;`;
}

async function checkSubmitRateLimit(ip) {
  if (RATE_LIMIT_DISABLED) return true;
  await sql`
    CREATE TABLE IF NOT EXISTS contact_rate (
      ip TEXT PRIMARY KEY,
      submit_count INTEGER NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  const rows = await sql`SELECT submit_count, window_start FROM contact_rate WHERE ip = ${ip};`;
  const now = Date.now();
  if (rows.rows.length === 0) {
    await sql`INSERT INTO contact_rate (ip, submit_count, window_start) VALUES (${ip}, 1, NOW()) ON CONFLICT (ip) DO UPDATE SET submit_count = contact_rate.submit_count + 1;`;
    return true;
  }
  const windowStart = new Date(rows.rows[0].window_start).getTime();
  if (now - windowStart > 60 * 60 * 1000) {
    await sql`UPDATE contact_rate SET submit_count = 1, window_start = NOW() WHERE ip = ${ip};`;
    return true;
  }
  if (rows.rows[0].submit_count >= 5) return false;
  await sql`UPDATE contact_rate SET submit_count = submit_count + 1 WHERE ip = ${ip};`;
  return true;
}

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

export default async function handler(req, res) {
  /* ---------- Admin panel methods ---------- */
  if (req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE') {
    const caller = getCaller(req);
    if (!caller || caller.role !== 'admin') {
      res.status(403).json({ error: { message: 'Admin access required.' } });
      return;
    }
    try {
      await ensureMessagesSchema();
      if (req.method === 'GET') {
        const result = await sql`SELECT id, name, email, subject, message, status, kind, company, phone, meta, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 200;`;
        res.status(200).json({ messages: result.rows });
        return;
      }
      if (req.method === 'PUT') {
        const { id, status } = req.body || {};
        if (!id || !['new', 'handled'].includes(status)) {
          res.status(400).json({ error: { message: 'Body must include id and status (new|handled).' } });
          return;
        }
        await sql`UPDATE contact_messages SET status = ${status} WHERE id = ${id};`;
        res.status(200).json({ ok: true });
        return;
      }
      // DELETE ?id=N
      const id = parseInt((req.query && req.query.id) || '', 10);
      if (!id) {
        res.status(400).json({ error: { message: 'id query parameter required.' } });
        return;
      }
      await sql`DELETE FROM contact_messages WHERE id = ${id};`;
      res.status(200).json({ ok: true });
      return;
    } catch (err) {
      res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
      return;
    }
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
    return;
  }

  const body = req.body || {};
  const kind = body.kind === 'enterprise' ? 'enterprise' : 'help';
  const name = cleanText(body.name, 120);
  const email = cleanText(body.email, 200);
  const subject = cleanText(body.subject, 200);
  const message = cleanText(body.message, 5000);
  const company = cleanText(body.company, 200);
  const phone = cleanText(body.phone, 60);
  const meta = kind === 'enterprise' ? {
    companySize: cleanText(body.companySize, 40),
    industry: cleanText(body.industry, 120),
    expectedUsers: cleanText(body.expectedUsers, 40),
  } : null;

  if (!name || !email || !message) {
    res.status(400).json({ error: { message: 'Please fill in your name, email, and message.' } });
    return;
  }
  if (kind === 'enterprise' && !company) {
    res.status(400).json({ error: { message: 'Please fill in your company name.' } });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    res.status(400).json({ error: { message: 'Please enter a valid email address.' } });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  try {
    const allowed = await checkSubmitRateLimit(ip);
    if (!allowed) {
      res.status(429).json({ error: { message: 'Too many messages from this connection. Please try again in an hour, or email us directly at ' + CONTACT_INBOX + '.' } });
      return;
    }
  } catch (err) {
    // Rate limiting must never block a legitimate message on its own failure.
    console.error('contact: rate-limit check failed (continuing):', err);
  }

  // 1. Store for the admin panel FIRST — the record must exist even if every email below
  // fails, so a help request can never silently vanish.
  let stored = false;
  try {
    await ensureMessagesSchema();
    await sql`INSERT INTO contact_messages (name, email, subject, message, kind, company, phone, meta) VALUES (${name}, ${email}, ${subject || null}, ${message}, ${kind}, ${company || null}, ${phone || null}, ${meta ? JSON.stringify(meta) : null});`;
    stored = true;
  } catch (err) {
    console.error('contact: could not store message (continuing to email):', err);
  }

  // 2. Notify our own inboxes — company inbox AND the owner directly (owner request).
  // Enterprise requests get their own subject + a full details block so the owner's email
  // contains the entire request at a glance.
  const emailContent = kind === 'enterprise'
    ? {
        subject: 'Enterprise access request — ' + company,
        html: buildBrandedEmail({
          previewText: 'New Enterprise access request from ' + company,
          greeting: 'Enterprise request received',
          paragraphs: [
            '<strong>Company:</strong> ' + company
              + '<br><strong>Contact:</strong> ' + name
              + '<br><strong>Email:</strong> ' + email
              + (phone ? '<br><strong>Phone:</strong> ' + phone : '')
              + (meta && meta.companySize ? '<br><strong>Company size:</strong> ' + meta.companySize : '')
              + (meta && meta.industry ? '<br><strong>Industry:</strong> ' + meta.industry : '')
              + (meta && meta.expectedUsers ? '<br><strong>Expected users:</strong> ' + meta.expectedUsers : ''),
            '<strong>Their message:</strong><br>' + message.replace(/</g, '&lt;').replace(/\n/g, '<br>'),
            'Reply directly to this email to reach them (Reply-To is set), and the request is also listed under Enterprise Requests in the admin panel.',
          ],
          footnote: 'Sent automatically by the Enterprise form on designslab.ai.',
        }),
      }
    : buildContactMessageEmail({ name, email, subject, message });
  const [inboxResult, ownerResult] = await Promise.all([
    sendTransactionalEmail({ toEmail: CONTACT_INBOX, toName: 'DesignsLab AI', subject: emailContent.subject, html: emailContent.html, replyTo: email }),
    sendTransactionalEmail({ toEmail: OWNER_INBOX, toName: 'Moe', subject: emailContent.subject, html: emailContent.html, replyTo: email }),
  ]);

  // 3. Branded acknowledgment to the visitor (owner request) — best-effort only.
  try {
    const ackHtml = kind === 'enterprise'
      ? buildBrandedEmail({
          previewText: 'Your Enterprise request is with our team. Expect a tailored plan shortly.',
          greeting: name,
          paragraphs: [
            'Thank you for your interest in <strong>DesignsLab AI Enterprise</strong>. We\'ve received your request for ' + company + ' and it\'s already with our team.',
            'We\'ll review your team size and requirements and come back with a plan sized to fit, usually within one business day.',
            'If anything is urgent in the meantime, you can reach us directly at ' + CONTACT_INBOX + '.',
          ],
          footnote: 'You are receiving this one-time confirmation because this address was used on the DesignsLab AI Enterprise form. No reply is needed.',
        })
      : buildBrandedEmail({
          previewText: 'We received your message — the DesignsLab team will get back to you shortly.',
          greeting: name,
          paragraphs: [
            'Thank you for reaching out to DesignsLab AI — your message has been received and is already with our team.',
            subject ? ('Your subject: "' + subject + '"') : 'We have your full message on file.',
            'We usually respond within one business day. If anything is urgent in the meantime, you can reach us directly at ' + CONTACT_INBOX + '.',
          ],
          footnote: 'You are receiving this one-time confirmation because this address was used on the DesignsLab AI contact form. No reply is needed.',
        });
    await sendTransactionalEmail({
      toEmail: email,
      toName: name,
      subject: kind === 'enterprise' ? 'We received your Enterprise request — DesignsLab AI' : 'We received your message — DesignsLab AI',
      html: ackHtml,
    });
  } catch (err) {
    console.error('contact: acknowledgment email failed (non-fatal):', err);
  }

  if (!inboxResult.sent && !ownerResult.sent && !stored) {
    // Truly nothing worked — honest failure with a direct way to reach us.
    res.status(502).json({ error: { message: 'Sorry, your message could not be sent right now. Please email us directly at ' + CONTACT_INBOX + '.' } });
    return;
  }

  res.status(200).json({ ok: true });
}
