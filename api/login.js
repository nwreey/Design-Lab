import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* ================= Password hashing ================= */
/* Node's built-in scrypt — no extra dependency needed. Each password gets its own random
   salt; the stored value is "salt:hash" so verification never needs a separate lookup. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const hashToVerify = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashToVerify, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ================= Token signing ================= */
/* Encodes {userId, role, expiry} rather than just an expiry timestamp, now that there can
   be more than one account. Still signed with SITE_PASSWORD as the HMAC key — that value
   was already a server-only secret before any of this, so reusing it here avoids requiring
   a brand new environment variable just for this. The payload is base64-encoded JSON
   followed by ".", followed by the hex signature — same "signed token, no session store"
   shape as before, just carrying more information now. */
function signToken(payloadObj, secret) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

async function ensureUsersSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      project_limit INTEGER,
      edit_limit INTEGER,
      edit_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
    return;
  }

  const { username, password, remember } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(401).json({ error: { message: 'Incorrect username or password.' } });
    return;
  }

  const signingSecret = process.env.SITE_PASSWORD || '';
  if (!signingSecret) {
    res.status(500).json({ error: { message: 'Server misconfiguration: SITE_PASSWORD is not set.' } });
    return;
  }

  let tokenPayload = null;

  // 1. Master admin fallback — the original single shared credential, kept working
  //    exactly as before so the account that's been using it never gets locked out,
  //    regardless of what happens with the new multi-user table.
  const masterUser = process.env.SITE_USERNAME || '';
  const masterPass = process.env.SITE_PASSWORD || '';
  if (masterUser && username === masterUser && password.length === masterPass.length &&
      crypto.timingSafeEqual(Buffer.from(password), Buffer.from(masterPass))) {
    tokenPayload = { userId: 'master-admin', username: masterUser, role: 'admin' };
  }

  // 2. Team member accounts, checked against the users table.
  if (!tokenPayload) {
    try {
      await ensureUsersSchema();
      const result = await sql`SELECT id, username, password_hash, role FROM users WHERE username = ${username};`;
      if (result.rows.length > 0) {
        const user = result.rows[0];
        if (verifyPassword(password, user.password_hash)) {
          tokenPayload = { userId: user.id, username: user.username, role: user.role };
        }
      }
    } catch (err) {
      console.error('Login lookup failed:', err);
      res.status(500).json({ error: { message: 'Could not verify credentials right now.' } });
      return;
    }
  }

  if (!tokenPayload) {
    res.status(401).json({ error: { message: 'Incorrect username or password.' } });
    return;
  }

  const maxAgeSeconds = remember ? 30 * 24 * 3600 : 8 * 3600;
  tokenPayload.expiry = Math.floor(Date.now() / 1000) + maxAgeSeconds;
  const token = signToken(tokenPayload, signingSecret);

  res.setHeader('Set-Cookie', `design_lab_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
  res.status(200).json({ ok: true, role: tokenPayload.role });
}
