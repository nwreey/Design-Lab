import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { sendTransactionalEmail, buildPurchaseRequestEmail } from '../lib/email.js';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* ================= Plan Purchase Request endpoint =================
   Per explicit product decision: purchasing a plan REQUIRES a registered, logged-in
   account — no guest can ever submit a purchase — and since no payment gateway is
   connected yet, a purchase is recorded as a REQUEST the admin activates manually
   (mirroring the request-access model in api/signup.js). Two layers enforce the
   registration requirement: middleware.js does not list /api/purchase as public (a
   guest's request never even reaches this code — it gets redirected to login), and
   this endpoint independently re-verifies the token anyway, defense in depth, same
   pattern as api/admin-users.js.

   POST   (logged-in users)  — {plan: 'Starter'|'Studio'|'Pro'} record/replace the
                               caller's pending purchase request (one pending per user —
                               choosing a different plan updates it rather than stacking)
   GET    (admin only)       — list all purchase requests, newest first
   PATCH  (admin only)       — {id, status: 'pending'|'handled'} mark a request
   DELETE (admin only, ?id=) — remove a request

   Token verification duplicated per-file by this project's own established convention
   (each serverless function self-contained — see api/admin-users.js's comment). */

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

// Plans + add-on quota packs (owner request): packs go through the same request/approval
// flow — the admin activates them by raising the user's limits in Users List.
// Edits are priced at $0.35 each (owner rule) -> 20-edit pack = $7.
const VALID_PLANS = ['Starter', 'Studio', 'Pro',
  // Add-on packs, volume-discounted (owner rule: base $0.35/edit, $0.70/modification):
  'Edits Pack 20', 'Edits Pack 50', 'Edits Pack 100',
  'Modifications Pack 10', 'Modifications Pack 25', 'Modifications Pack 50'];

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS plan_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      plan TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
}

export default async function handler(req, res) {
  const signingSecret = process.env.SITE_PASSWORD || '';

  // EVERY verb here requires a registered, logged-in caller — this is the server-side
  // guarantee behind "no one can purchase a package without being registered."
  const token = parseCookie(req.headers.cookie, 'design_lab_auth');
  const payload = verifyTokenNode(token, signingSecret);
  if (!payload) {
    res.status(401).json({ error: { message: 'You need an account to purchase a plan. Please sign in, or request access first.' } });
    return;
  }

  try {
    await ensureSchema();
  } catch (err) {
    console.error('purchase: could not ensure schema:', err);
    res.status(500).json({ error: { message: 'Server error. Please try again later.' } });
    return;
  }

  /* ---------- Logged-in users: submit/replace their purchase request ---------- */
  if (req.method === 'POST') {
    const plan = (req.body && req.body.plan) || '';
    if (!VALID_PLANS.includes(plan)) {
      res.status(400).json({ error: { message: 'Please choose a valid plan.' } });
      return;
    }
    const username = payload.username || payload.userId || 'unknown';
    const id = 'plan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    try {
      // One PENDING request per user — picking a different plan later replaces the
      // earlier choice instead of stacking duplicates in the admin's review list.
      // Already-handled requests are history and are never overwritten.
      const existing = await sql`SELECT id FROM plan_requests WHERE user_id = ${String(payload.userId)} AND status = 'pending' LIMIT 1;`;
      if (existing.rows.length > 0) {
        await sql`UPDATE plan_requests SET plan = ${plan}, username = ${String(username)}, created_at = NOW() WHERE id = ${existing.rows[0].id};`;
      } else {
        await sql`INSERT INTO plan_requests (id, user_id, username, plan) VALUES (${id}, ${String(payload.userId)}, ${String(username)}, ${plan});`;
      }
    } catch (err) {
      console.error('purchase: could not store request:', err);
      res.status(500).json({ error: { message: 'Could not submit your purchase request right now. Please try again later.' } });
      return;
    }
    // Confirmation email — the users table only carries an email if the admin filled one
    // in when creating the account (users.email is optional, added by api/admin-users.js's
    // schema), so this looks it up defensively and silently skips when absent or when the
    // column doesn't exist yet on an older deployment. Never blocks the purchase itself.
    let emailResult = { sent: false };
    try {
      const userRows = await sql`SELECT email FROM users WHERE id = ${String(payload.userId)};`;
      const userEmail = userRows.rows.length > 0 ? userRows.rows[0].email : null;
      if (userEmail) {
        const emailContent = buildPurchaseRequestEmail({ username: String(username), plan });
        emailResult = await sendTransactionalEmail({ toEmail: userEmail, toName: String(username), subject: emailContent.subject, html: emailContent.html });
      }
    } catch (err) {
      console.error('purchase: could not send confirmation email (continuing):', err);
    }

    res.status(200).json({ ok: true, plan, emailSent: emailResult.sent });
    return;
  }

  /* ---------- Admin: review workflow ---------- */
  if (payload.role !== 'admin') {
    res.status(403).json({ error: { message: 'Admin access required.' } });
    return;
  }

  if (req.method === 'GET') {
    try {
      const rows = await sql`SELECT id, user_id, username, plan, status, created_at FROM plan_requests ORDER BY created_at DESC;`;
      res.status(200).json({ requests: rows.rows });
    } catch (err) {
      console.error('purchase: could not list requests:', err);
      res.status(500).json({ error: { message: 'Could not load purchase requests.' } });
    }
    return;
  }

  if (req.method === 'PATCH') {
    const { id, status } = req.body || {};
    if (!id || !['pending', 'handled'].includes(status)) {
      res.status(400).json({ error: { message: 'Provide a request id and a status of "pending" or "handled".' } });
      return;
    }
    try {
      await sql`UPDATE plan_requests SET status = ${status} WHERE id = ${id};`;
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('purchase: could not update request:', err);
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
      await sql`DELETE FROM plan_requests WHERE id = ${id};`;
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('purchase: could not delete request:', err);
      res.status(500).json({ error: { message: 'Could not delete the request.' } });
    }
    return;
  }

  res.status(405).json({ error: { message: 'Method not allowed.' } });
}
