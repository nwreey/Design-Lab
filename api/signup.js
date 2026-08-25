import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { sendTransactionalEmail, buildAccessRequestReceivedEmail, buildAccessApprovedEmail } from '../lib/email.js';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* ================= Access Request endpoint (Early Access Program) =================
   The public marketing site's "Sign up" is a REQUEST-ACCESS flow, per explicit product
   decision (matching the homepage's own Early Access copy: "Access is granted after
   account review") — it never creates a real account by itself. A visitor's POST stores
   one row in signup_requests; the admin reviews requests in admin.html's Signup Requests
   section and creates the actual account via the existing Add-a-team-member flow
   (api/admin-users.js), which is where per-user quotas are assigned. This keeps
   self-service registration from ever consuming real OpenAI/Gemini credits unreviewed.

   POST   (public, rate-limited)  — submit a request  {name, company, email, phone?, role?, useCase}
   GET    (admin only)            — list all requests, newest first
   PATCH  (admin only)            — {id, status: 'reviewed'|'pending'} mark a request
   DELETE (admin only, ?id=)      — remove a request

   Token verification is duplicated from api/admin-users.js rather than shared — each
   serverless function here is deliberately self-contained, matching the pattern used
   across this project (see that file's own comment on the same tradeoff). */

function verifyTokenNode(token, secret) {
  if (!token) return null;
  const separatorIndex = token.indexOf('.');
  if (separatorIndex === -1) return null;
  const payloadB64 = token.substring(0, separatorIndex);
  const signature = token.substring(separatorIndex + 1);
  const expectedSignature = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
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

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS signup_requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      role TEXT,
      use_case TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
}

/* Simple per-IP rate limit on submissions, reusing the same table-based approach as
   login's lockouts (no external store on serverless): max 5 requests per IP per hour.
   Deliberately quiet — an over-limit caller gets the same friendly 429 either way. */
async function checkSubmitRateLimit(ip) {
  await sql`
    CREATE TABLE IF NOT EXISTS signup_rate (
      ip TEXT PRIMARY KEY,
      submit_count INTEGER NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  const rows = await sql`SELECT submit_count, window_start FROM signup_rate WHERE ip = ${ip};`;
  const now = Date.now();
  if (rows.rows.length === 0) {
    await sql`INSERT INTO signup_rate (ip, submit_count, window_start) VALUES (${ip}, 1, NOW()) ON CONFLICT (ip) DO UPDATE SET submit_count = signup_rate.submit_count + 1;`;
    return true;
  }
  const windowStart = new Date(rows.rows[0].window_start).getTime();
  if (now - windowStart > 60 * 60 * 1000) {
    await sql`UPDATE signup_rate SET submit_count = 1, window_start = NOW() WHERE ip = ${ip};`;
    return true;
  }
  if (rows.rows[0].submit_count >= 5) return false;
  await sql`UPDATE signup_rate SET submit_count = submit_count + 1 WHERE ip = ${ip};`;
  return true;
}

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

export default async function handler(req, res) {
  const signingSecret = process.env.SITE_PASSWORD || '';

  try {
    await ensureSchema();
  } catch (err) {
    console.error('signup: could not ensure schema:', err);
    res.status(500).json({ error: { message: 'Server error. Please try again later.' } });
    return;
  }

  /* ---------- PUBLIC: submit a request ---------- */
  if (req.method === 'POST') {
    const body = req.body || {};
    const name = cleanText(body.name, 120);
    const company = cleanText(body.company, 160);
    const email = cleanText(body.email, 200);
    const phone = cleanText(body.phone, 60);
    const role = cleanText(body.role, 80);
    const useCase = cleanText(body.useCase, 2000);

    if (!name || !company || !email || !useCase) {
      res.status(400).json({ error: { message: 'Please fill in your name, company, work email, and what you plan to use DesignsLab AI for.' } });
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
        res.status(429).json({ error: { message: 'Too many requests from this connection — please try again in an hour.' } });
        return;
      }
    } catch (err) {
      // Rate limiting must never block a legitimate request outright on its own failure.
      console.error('signup: rate-limit check failed (continuing):', err);
    }

    // One pending request per email — a resubmission updates the existing pending row
    // instead of stacking duplicates in the admin's review list.
    const id = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    try {
      const existing = await sql`SELECT id FROM signup_requests WHERE email = ${email} AND status = 'pending' LIMIT 1;`;
      if (existing.rows.length > 0) {
        await sql`
          UPDATE signup_requests
          SET name = ${name}, company = ${company}, phone = ${phone || null}, role = ${role || null}, use_case = ${useCase}, created_at = NOW()
          WHERE id = ${existing.rows[0].id};
        `;
      } else {
        await sql`
          INSERT INTO signup_requests (id, name, company, email, phone, role, use_case)
          VALUES (${id}, ${name}, ${company}, ${email}, ${phone || null}, ${role || null}, ${useCase});
        `;
      }
    } catch (err) {
      console.error('signup: could not store request:', err);
      res.status(500).json({ error: { message: 'Could not submit your request right now. Please try again later.' } });
      return;
    }

    // Confirmation email to the requester — a courtesy on top of the stored request;
    // sendTransactionalEmail never throws, so a mail outage can never fail the signup.
    const emailContent = buildAccessRequestReceivedEmail({ name });
    const emailResult = await sendTransactionalEmail({ toEmail: email, toName: name, subject: emailContent.subject, html: emailContent.html });

    res.status(200).json({ ok: true, emailSent: emailResult.sent });
    return;
  }

  /* ---------- ADMIN: everything below requires a valid admin token ---------- */
  // Cookie name matches api/login.js's Set-Cookie ('design_lab_auth') — originally written
  // as 'site_auth' by mistake, which made every admin verb here 403 unconditionally.
  const token = parseCookie(req.headers.cookie, 'design_lab_auth');
  const payload = await verifyTokenNode(token, signingSecret);
  if (!payload || payload.role !== 'admin') {
    res.status(403).json({ error: { message: 'Admin access required.' } });
    return;
  }

  if (req.method === 'GET') {
    try {
      const rows = await sql`SELECT id, name, company, email, phone, role, use_case, status, created_at FROM signup_requests ORDER BY created_at DESC;`;
      res.status(200).json({ requests: rows.rows });
    } catch (err) {
      console.error('signup: could not list requests:', err);
      res.status(500).json({ error: { message: 'Could not load signup requests.' } });
    }
    return;
  }

  if (req.method === 'PATCH') {
    const { id, status, notify } = req.body || {};
    if (!id || !['pending', 'reviewed'].includes(status)) {
      res.status(400).json({ error: { message: 'Provide a request id and a status of "pending" or "reviewed".' } });
      return;
    }
    try {
      // Approval email (admin clicked "Approve & email") — sent to the request's own
      // address, before the status flips, so a DB failure never emails without recording.
      let emailResult = { sent: false };
      if (notify && status === 'reviewed') {
        const rows = await sql`SELECT name, email FROM signup_requests WHERE id = ${id};`;
        if (rows.rows.length > 0) {
          const emailContent = buildAccessApprovedEmail({ name: rows.rows[0].name });
          emailResult = await sendTransactionalEmail({ toEmail: rows.rows[0].email, toName: rows.rows[0].name, subject: emailContent.subject, html: emailContent.html });
        }
      }
      await sql`UPDATE signup_requests SET status = ${status} WHERE id = ${id};`;
      res.status(200).json({ ok: true, emailSent: emailResult.sent });
    } catch (err) {
      console.error('signup: could not update request:', err);
      res.status(500).json({ error: { message: 'Could not update the request.' } });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const id = (req.query && req.query.id) || '';
    if (!id) {
      res.status(400).json({ error: { message: 'Provide a request id.' } });
      return;
    }
    try {
      await sql`DELETE FROM signup_requests WHERE id = ${id};`;
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('signup: could not delete request:', err);
      res.status(500).json({ error: { message: 'Could not delete the request.' } });
    }
    return;
  }

  res.status(405).json({ error: { message: 'Method not allowed.' } });
}
