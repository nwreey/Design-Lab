import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* Same token verification duplicated across the auth-aware endpoints in this project —
   see api/projects.js for the fuller explanation of why this isn't a shared import. */
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
    CREATE TABLE IF NOT EXISTS login_attempts (
      attempt_key TEXT PRIMARY KEY,
      failed_count INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
}

export default async function handler(req, res) {
  const signingSecret = process.env.SITE_PASSWORD || '';
  const cookieHeader = req.headers.cookie || '';
  const token = parseCookie(cookieHeader, 'design_lab_auth');
  const payload = signingSecret ? verifyTokenNode(token, signingSecret) : null;

  if (!payload || payload.role !== 'admin') {
    res.status(403).json({ error: { message: 'Admin access required.' } });
    return;
  }

  try {
    await ensureSchema();
  } catch (err) {
    console.error('Schema setup failed:', err);
    res.status(500).json({ error: { message: 'Database is not reachable.' } });
    return;
  }

  if (req.method === 'GET') {
    // Only rows with meaningful state — either currently locked, or with at least one
    // recorded failure — so a clean login history doesn't clutter the admin view.
    // attempt_key is "username|ip"; split it back out for a readable table.
    const result = await sql`
      SELECT attempt_key, failed_count, locked_until, last_attempt_at
      FROM login_attempts
      WHERE failed_count > 0
      ORDER BY last_attempt_at DESC;
    `;
    const rows = result.rows.map(r => {
      const separatorIndex = r.attempt_key.lastIndexOf('|');
      return {
        username: separatorIndex === -1 ? r.attempt_key : r.attempt_key.substring(0, separatorIndex),
        ip: separatorIndex === -1 ? 'unknown' : r.attempt_key.substring(separatorIndex + 1),
        failedCount: r.failed_count,
        lockedUntil: r.locked_until,
        isCurrentlyLocked: r.locked_until ? new Date(r.locked_until) > new Date() : false,
        lastAttemptAt: r.last_attempt_at,
        attemptKey: r.attempt_key,
      };
    });
    res.status(200).json(rows);
    return;
  }

  if (req.method === 'DELETE') {
    const { attemptKey, clearResolved } = req.query;

    // Bulk cleanup: wipe every row that isn't currently locked (either it never triggered a
    // lockout, or the lockout window has already passed) in one request, so the admin doesn't
    // have to remove stale failed-attempt history one row at a time. Currently-locked rows are
    // deliberately left alone here — clearing an active lockout is a more consequential action
    // and stays a deliberate per-row "Unlock now" click instead.
    if (clearResolved) {
      await sql`DELETE FROM login_attempts WHERE locked_until IS NULL OR locked_until <= NOW();`;
      res.status(200).json({ ok: true });
      return;
    }

    // Single-row removal — used both to unlock an actively-locked row and to remove a resolved
    // row's history. Either way this clears that row entirely, same as a successful login would
    // have done: resets both the lockout and the failure count back to a clean slate.
    if (!attemptKey) {
      res.status(400).json({ error: { message: 'attemptKey is required.' } });
      return;
    }
    await sql`DELETE FROM login_attempts WHERE attempt_key = ${attemptKey};`;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: { message: 'Method not allowed.' } });
}
