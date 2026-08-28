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

async function ensureSchema() {
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
  await sql`
    CREATE TABLE IF NOT EXISTS login_attempts (
      attempt_key TEXT PRIMARY KEY,
      failed_count INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
}

/* ================= Rate limiting ================= */
/* Tracked per (username + client IP), not username alone — locking out by username only
   would let an attacker deliberately fail login attempts against a KNOWN username (like
   the master admin's) purely to lock the real, legitimate person out — turning the
   protection itself into a denial-of-service tool. Keying by IP too means an attacker
   hammering the master admin username from their own machine only locks THAT combination;
   the actual admin logging in from their own computer is unaffected. 5 failed attempts
   locks that specific (username, IP) pair for 15 minutes. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function checkLockout(attemptKey) {
  const result = await sql`SELECT locked_until FROM login_attempts WHERE attempt_key = ${attemptKey};`;
  if (result.rows.length === 0) return null;
  const lockedUntil = result.rows[0].locked_until;
  if (lockedUntil && new Date(lockedUntil) > new Date()) {
    const minutesLeft = Math.ceil((new Date(lockedUntil) - new Date()) / 60000);
    return `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`;
  }
  return null;
}

async function recordFailedAttempt(attemptKey) {
  const existing = await sql`SELECT failed_count FROM login_attempts WHERE attempt_key = ${attemptKey};`;
  const newCount = (existing.rows.length > 0 ? existing.rows[0].failed_count : 0) + 1;
  const lockedUntil = newCount >= MAX_FAILED_ATTEMPTS
    ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000).toISOString()
    : null;
  await sql`
    INSERT INTO login_attempts (attempt_key, failed_count, locked_until, last_attempt_at)
    VALUES (${attemptKey}, ${newCount}, ${lockedUntil}, NOW())
    ON CONFLICT (attempt_key) DO UPDATE SET failed_count = ${newCount}, locked_until = ${lockedUntil}, last_attempt_at = NOW();
  `;
}

async function clearFailedAttempts(attemptKey) {
  await sql`DELETE FROM login_attempts WHERE attempt_key = ${attemptKey};`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
    return;
  }

  const body = req.body || {};
  const { username, password, remember } = body;
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(401).json({ error: { message: 'Incorrect username or password.' } });
    return;
  }

  const signingSecret = process.env.SITE_PASSWORD || '';
  if (!signingSecret) {
    res.status(500).json({ error: { message: 'Server misconfiguration: SITE_PASSWORD is not set.' } });
    return;
  }

  try {
    await ensureSchema();
  } catch (err) {
    console.error('Schema setup failed:', err);
    res.status(500).json({ error: { message: 'Could not verify credentials right now.' } });
    return;
  }

  const clientIp = getClientIp(req);
  const attemptKey = `${username.toLowerCase()}|${clientIp}`;

  /* ---- Admin lockout exemption (owner request) ----
     Admin usernames are NEVER time-locked: the owner must be able to sign in at any
     moment, and the private-gate URL + generic 401s are the protection he has chosen
     for that account. Failed attempts on admin usernames are still RECORDED below, so
     they stay visible in the admin panel's Login Security section — they just never
     block. Regular user accounts keep the full 5-attempt / 15-minute lockout. */
  let isAdminUsername = false;
  const masterUsername = process.env.SITE_USERNAME || '';
  if (masterUsername && username === masterUsername) {
    isAdminUsername = true;
  } else {
    try {
      const roleResult = await sql`SELECT role FROM users WHERE username = ${username};`;
      if (roleResult.rows.length > 0 && roleResult.rows[0].role === 'admin') isAdminUsername = true;
    } catch (err) {
      // Fail toward normal lockout behavior — a DB hiccup shouldn't disable protection.
      console.error('Admin-exemption lookup failed:', err);
    }
  }

  // Checked BEFORE any password comparison — a locked-out attempt should never even reach
  // the (comparatively expensive) scrypt verification, both to genuinely stop the guessing
  // and to avoid giving a timing signal either way.
  try {
    const lockoutMessage = isAdminUsername ? null : await checkLockout(attemptKey);
    if (lockoutMessage) {
      res.status(429).json({ error: { message: lockoutMessage } });
      return;
    }
  } catch (err) {
    console.error('Lockout check failed:', err);
    // Fail open on the rate-limit check itself — an unenforced limit for a few minutes is
    // a smaller problem than login breaking entirely over an unrelated database hiccup.
  }

  let tokenPayload = null;

  /* ---- Admin gate (owner request) ----
     Admin accounts may ONLY sign in through the private admin page (which sends
     gate:'admin'); the public login page never can, and regular users can't use the
     admin gate. Enforced AFTER credential verification below, and the rejection is
     the same generic "Incorrect username or password." either way, so the public
     page never confirms that an admin account exists. The private page's URL is
     unguessable and linked from nowhere — but this server-side check is the real
     enforcement, not the URL secrecy. */
  const gate = body.gate === 'admin' ? 'admin' : 'public';

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

  // Gate/role mismatch: refused with the same generic 401 as a wrong password, but it
  // does NOT feed the lockout counter — the credentials were CORRECT, so this is a
  // legitimate person at the wrong door (owner locked himself out this way on day one),
  // not a guessing attack. An attacker in this branch already has the real password;
  // the lockout adds nothing against them.
  let gateMismatch = false;
  if (tokenPayload && ((tokenPayload.role === 'admin') !== (gate === 'admin'))) {
    tokenPayload = null;
    gateMismatch = true;
  }

  /* ---- Admin IP allowlist (owner request) ----
     When ADMIN_ALLOWED_IPS is set (comma-separated public IPs in Vercel env), admin
     sign-in only succeeds from those addresses — even with the right password AND the
     right gate. Rejection is the same generic 401 (no lockout — credentials were right).
     Fail-safe: with the env var unset, no restriction, so a mistake in Vercel can be
     fixed from the Vercel dashboard rather than bricking admin access forever. */
  if (tokenPayload && tokenPayload.role === 'admin') {
    const allowedIps = (process.env.ADMIN_ALLOWED_IPS || '').split(',').map(v => v.trim()).filter(Boolean);
    if (allowedIps.length > 0 && !allowedIps.includes(clientIp)) {
      console.error('login: admin attempt from non-allowlisted IP', clientIp);
      tokenPayload = null;
      gateMismatch = true; // reuse: generic 401, no lockout feeding
    }
  }

  if (!tokenPayload) {
    if (!gateMismatch) {
      try {
        await recordFailedAttempt(attemptKey);
      } catch (err) {
        console.error('Could not record failed attempt:', err);
      }
    }
    res.status(401).json({ error: { message: 'Incorrect username or password.' } });
    return;
  }

  try {
    await clearFailedAttempts(attemptKey);
  } catch (err) {
    console.error('Could not clear failed attempts:', err);
  }

  const maxAgeSeconds = remember ? 30 * 24 * 3600 : 8 * 3600;
  tokenPayload.expiry = Math.floor(Date.now() / 1000) + maxAgeSeconds;
  const token = signToken(tokenPayload, signingSecret);

  res.setHeader('Set-Cookie', `design_lab_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
  res.status(200).json({ ok: true, role: tokenPayload.role });
}
