import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* ================= User Feedback endpoint =================
   Backs the "Give feedback" item in the studio's account settings menu. Feedback is
   product input from signed-in users (distinct from api/ratings.js, which rates a
   specific generated design, and from api/contact.js, which is the public contact
   form) — collected here and reviewed in the admin panel's Feedback section.

   POST   (logged-in users)  — {message} store one feedback entry (max 3000 chars)
   GET    (admin only)       — list all feedback, newest first
   PATCH  (admin only)       — {id, status: 'new'|'reviewed'} mark an entry
   DELETE (admin only, ?id=) — remove an entry

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

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
}

export default async function handler(req, res) {
  const signingSecret = process.env.SITE_PASSWORD || '';

  // Every verb requires a signed-in caller (feedback is a member feature, never
  // anonymous); admin-only verbs re-check the role below.
  const token = parseCookie(req.headers.cookie, 'design_lab_auth');
  const payload = verifyTokenNode(token, signingSecret);
  if (!payload) {
    res.status(401).json({ error: { message: 'Please sign in to send feedback.' } });
    return;
  }

  try {
    await ensureSchema();
  } catch (err) {
    console.error('feedback: could not ensure schema:', err);
    res.status(500).json({ error: { message: 'Server error. Please try again later.' } });
    return;
  }

  if (req.method === 'POST') {
    const message = (typeof (req.body || {}).message === 'string' ? req.body.message : '').trim().slice(0, 3000);
    if (!message) {
      res.status(400).json({ error: { message: 'Please write your feedback before sending.' } });
      return;
    }
    const id = 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    try {
      await sql`INSERT INTO user_feedback (id, user_id, username, message) VALUES (${id}, ${String(payload.userId)}, ${String(payload.username || payload.userId)}, ${message});`;
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('feedback: could not store feedback:', err);
      res.status(500).json({ error: { message: 'Could not send your feedback right now. Please try again later.' } });
    }
    return;
  }

  /* ---------- Admin: review workflow ---------- */
  if (payload.role !== 'admin') {
    res.status(403).json({ error: { message: 'Admin access required.' } });
    return;
  }

  if (req.method === 'GET') {
    try {
      const rows = await sql`SELECT id, user_id, username, message, status, created_at FROM user_feedback ORDER BY created_at DESC;`;
      res.status(200).json({ feedback: rows.rows });
    } catch (err) {
      console.error('feedback: could not list feedback:', err);
      res.status(500).json({ error: { message: 'Could not load feedback.' } });
    }
    return;
  }

  if (req.method === 'PATCH') {
    const { id, status } = req.body || {};
    if (!id || !['new', 'reviewed'].includes(status)) {
      res.status(400).json({ error: { message: 'Provide a feedback id and a status of "new" or "reviewed".' } });
      return;
    }
    try {
      await sql`UPDATE user_feedback SET status = ${status} WHERE id = ${id};`;
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('feedback: could not update feedback:', err);
      res.status(500).json({ error: { message: 'Could not update the feedback.' } });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const id = (req.query && req.query.id) || '';
    if (!id) {
      res.status(400).json({ error: { message: 'Provide a feedback id.' } });
      return;
    }
    try {
      await sql`DELETE FROM user_feedback WHERE id = ${id};`;
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('feedback: could not delete feedback:', err);
      res.status(500).json({ error: { message: 'Could not delete the feedback.' } });
    }
    return;
  }

  res.status(405).json({ error: { message: 'Method not allowed.' } });
}
