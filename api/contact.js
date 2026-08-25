import { neon } from '@neondatabase/serverless';
import { sendTransactionalEmail, buildContactMessageEmail } from '../lib/email.js';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* ================= Contact form endpoint =================
   Public POST — delivers the visitor's message to the company inbox
   (info@designslab.ai) via Mandrill, per explicit product decision. The email's
   Reply-To is the visitor's own address, so answering from the inbox goes straight
   back to them.

   No customer-facing acknowledgment email is sent on purpose: the recipient address
   is visitor-typed and unverified, so auto-replying to it would make this endpoint a
   backscatter-spam relay (anyone could make us email an arbitrary address). The one
   email that IS sent goes only to our own fixed inbox.

   Rate limited per IP (same table-based approach as api/signup.js — no external
   store on serverless): max 5 messages per IP per hour. If Mandrill itself fails,
   the visitor gets an honest error pointing them at info@designslab.ai directly —
   nothing is silently dropped. */

const CONTACT_INBOX = 'info@designslab.ai';

async function checkSubmitRateLimit(ip) {
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
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
    return;
  }

  const body = req.body || {};
  const name = cleanText(body.name, 120);
  const email = cleanText(body.email, 200);
  const subject = cleanText(body.subject, 200);
  const message = cleanText(body.message, 5000);

  if (!name || !email || !message) {
    res.status(400).json({ error: { message: 'Please fill in your name, email, and message.' } });
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
      res.status(429).json({ error: { message: 'Too many messages from this connection — please try again in an hour, or email us directly at ' + CONTACT_INBOX + '.' } });
      return;
    }
  } catch (err) {
    // Rate limiting must never block a legitimate message on its own failure.
    console.error('contact: rate-limit check failed (continuing):', err);
  }

  const emailContent = buildContactMessageEmail({ name, email, subject, message });
  const result = await sendTransactionalEmail({
    toEmail: CONTACT_INBOX,
    toName: 'DesignsLab AI',
    subject: emailContent.subject,
    html: emailContent.html,
    replyTo: email,
  });

  if (!result.sent) {
    // Honest failure — the message was NOT delivered anywhere, so tell the visitor
    // exactly how to still reach us rather than pretending it worked.
    res.status(502).json({ error: { message: 'Sorry — your message could not be sent right now. Please email us directly at ' + CONTACT_INBOX + '.' } });
    return;
  }

  res.status(200).json({ ok: true });
}
