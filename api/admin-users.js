import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });
import { del } from '@vercel/blob';
import { sendTransactionalEmail, buildBrandedEmail } from '../lib/email.js';

// Duplicated from api/projects.js rather than shared — each serverless function here is
// independent, and this small amount of logic is simpler to keep self-contained per file
// than to introduce a cross-file import path, matching the pattern already used elsewhere
// in this project (see that file's own comment on the same tradeoff).
function collectBlobPaths(node, out) {
  if (Array.isArray(node)) {
    node.forEach(item => collectBlobPaths(item, out));
  } else if (node && typeof node === 'object') {
    Object.keys(node).forEach(key => collectBlobPaths(node[key], out));
  } else if (typeof node === 'string') {
    const match = node.match(/^blob:(.+)$/);
    if (match) out.push(match[1]);
  }
}

/* Role protection is already enforced by middleware.js (ADMIN_ONLY_PATHS), but this
   endpoint re-derives the caller's role independently here too — defense in depth, so a
   bug or future change in the middleware's path-matching logic can't accidentally expose
   user management to a non-admin. This mirrors the exact token verification middleware.js
   does, just using Node's crypto module since this file runs on the Node runtime. */
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

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
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
  // CREATE TABLE IF NOT EXISTS is a no-op against an already-existing table, so it never
  // adds new columns on its own — this deployment already has a live users table from
  // earlier, so modify_limit/modify_count need their own explicit, idempotent migration.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS modify_limit INTEGER;`;
  // Optional contact email per user — used by transactional notifications (e.g. the plan
  // purchase confirmation in api/purchase.js). Blank for accounts created before this.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;`;
  // Sign-in activity columns are normally added by api/login.js's own schema pass, but
  // either function can be the first hit after a deployment — the report query below
  // reads them, so they must exist here too (idempotent, same definitions).
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_login_at TIMESTAMPTZ;`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0;`;
  // AI Auto-Fill quota — how many times a user may run the AI form auto-fill (enforced
  // by api/autofill.js). NULL = unlimited, same convention as every other limit here.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS autofill_limit INTEGER;`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS autofill_count INTEGER NOT NULL DEFAULT 0;`;
  // Purchased plan name (Starter/Studio/Pro). NULL = free trial. The studio gates the
  // Approve step (which unlocks the full camera-view set) on this being set; the admin
  // sets it from the Users List when a payment completes.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT;`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS modify_count INTEGER NOT NULL DEFAULT 0;`;

  // project_count is a PERMANENT, increment-only consumption counter — unlike the project
  // quota check this replaces (which used to count currently-existing rows), deleting a
  // project must NOT free up a slot, or a user could bypass their limit indefinitely by
  // creating and deleting projects. Backfill existing users' starting count from their
  // current live project total, but ONLY the first time this column is added — checking
  // information_schema first (rather than just guarding on project_count = 0) avoids ever
  // re-running the backfill and silently overwriting a correctly-tracked count back down
  // to a stale, currently-live number for a user who has since deleted a project.
  const colCheck = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'project_count';`;
  const columnAlreadyExisted = colCheck.rows.length > 0;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS project_count INTEGER NOT NULL DEFAULT 0;`;
  if (!columnAlreadyExisted) {
    try {
      await sql`UPDATE users SET project_count = (SELECT COUNT(*)::int FROM projects WHERE projects.user_id = users.id);`;
    } catch (err) {
      // The projects table (owned by a different serverless function's schema) may not
      // exist yet on a brand-new deployment — in that case everyone genuinely has zero
      // projects, so leaving project_count at its DEFAULT 0 is already correct.
      console.error('Could not backfill project_count (projects table may not exist yet):', err);
    }
  }
}

function generateUserId() {
  return 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
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

  if (req.method === 'GET' && req.query && req.query.report) {
    /* Full per-user report (owner request): everything known about one user in one call.
       Each side-table query is individually best-effort — a table that doesn't exist yet
       (e.g. no ratings ever submitted) contributes an empty list, never a failed report. */
    const userId = String(req.query.report);
    const userRows = await sql`
      SELECT id, username, email, full_name, role, plan, project_limit, project_count, edit_limit, edit_count,
             modify_limit, modify_count, autofill_limit, autofill_count, created_at,
             first_login_at, last_login_at, login_count
      FROM users WHERE id = ${userId};`;
    if (userRows.rows.length === 0) {
      res.status(404).json({ error: { message: 'User not found.' } });
      return;
    }
    const report = { user: userRows.rows[0], projects: [], purchases: [], ratings: [], feedback: [] };
    try {
      const p = await sql`SELECT id, name, saved_at, kind, status FROM projects WHERE user_id = ${userId} ORDER BY saved_at DESC;`;
      report.projects = p.rows;
    } catch (e) { /* table/columns may not exist yet */ }
    try {
      const pr = await sql`SELECT plan, status, created_at FROM plan_requests WHERE user_id = ${userId} ORDER BY created_at DESC;`;
      report.purchases = pr.rows;
    } catch (e) { /* none yet */ }
    try {
      const r = await sql`SELECT project_name, stars, comment, updated_at FROM ratings WHERE user_id = ${userId} ORDER BY updated_at DESC;`;
      report.ratings = r.rows;
    } catch (e) { /* none yet */ }
    try {
      const f = await sql`SELECT message, status, created_at FROM user_feedback WHERE user_id = ${userId} ORDER BY created_at DESC;`;
      report.feedback = f.rows;
    } catch (e) { /* none yet */ }
    res.status(200).json(report);
    return;
  }

  if (req.method === 'GET') {
    // project_count is the persistent, increment-only counter (see ensureSchema) — it
    // reflects how many projects actually count against this user's limit, which is not
    // necessarily the same as how many they currently have saved if any were deleted.
    const result = await sql`
      SELECT id, username, email, full_name, role, plan, project_limit, project_count, edit_limit, edit_count, modify_limit, modify_count, autofill_limit, autofill_count, created_at
      FROM users
      ORDER BY created_at ASC;
    `;
    res.status(200).json(result.rows);
    return;
  }

  if (req.method === 'POST') {
    /* Owner flow (latest revision): the admin fills ONLY the email + limits.
       - The username IS the email (lowercased) — no separate username field.
       - No admin-set password: the account gets an unusable random placeholder, and the
         welcome email carries a single-use Set Your Password link (7 days, same
         password_setup_tokens machinery as the signup-approval flow) — the user sets
         their own password and is signed in directly.
       - The welcome email congratulates them on their Free Plan and states exactly the
         limits the admin filled (projects / modifications / edits).
       If the email cannot be sent, the just-created account is rolled back and the admin
       gets an honest error — an account nobody can ever reach must not linger. */
    const { email, role, plan, fullName } = req.body || {};
    const cleanFullName = (typeof fullName === 'string' && fullName.trim()) ? fullName.trim().slice(0, 120) : null;
    const cleanEmail = (typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) ? email.trim().toLowerCase().slice(0, 200) : null;
    if (!cleanEmail) {
      res.status(400).json({ error: { message: 'A valid email address is required — it becomes the username.' } });
      return;
    }
    /* Owner flow (latest revision): the admin picks a PLAN, not raw numbers — the limits
       derive server-side from the pricing page's own feature table, one source of truth:
         Starter $49  ->  2 projects /  8 modifications /  30 image edits
         Studio $110  ->  5 projects / 20 modifications /  80 image edits
         Pro    $200  -> 10 projects / 50 modifications / 130 image edits
         Free Trial   ->  1 project  /  2 modifications /   3 image edits / 1 AI fill
       Fine-tuning later still works through Edit limits & plan in the Users List. */
    const PLAN_QUOTAS = {
      'Free Trial': { projectLimit: 1, modifyLimit: 2, editLimit: 3, autofillLimit: 1, planName: null },
      'Starter':    { projectLimit: 2, modifyLimit: 8, editLimit: 30, autofillLimit: null, planName: 'Starter' },
      'Studio':     { projectLimit: 5, modifyLimit: 20, editLimit: 80, autofillLimit: null, planName: 'Studio' },
      'Pro':        { projectLimit: 10, modifyLimit: 50, editLimit: 130, autofillLimit: null, planName: 'Pro' },
    };
    const quotas = PLAN_QUOTAS[plan];
    if (!quotas) {
      res.status(400).json({ error: { message: 'Please choose a plan (Free Trial, Starter, Studio, or Pro).' } });
      return;
    }
    const { projectLimit, editLimit, modifyLimit, autofillLimit } = quotas;
    const username = cleanEmail;
    const finalRole = role === 'admin' ? 'admin' : 'member';
    const id = generateUserId();
    const placeholderSalt = crypto.randomBytes(16).toString('hex');
    const placeholderHash = crypto.scryptSync(crypto.randomBytes(32).toString('hex'), placeholderSalt, 64).toString('hex');

    try {
      await sql`
        INSERT INTO users (id, username, password_hash, email, full_name, role, plan, project_limit, edit_limit, modify_limit, autofill_limit)
        VALUES (${id}, ${username}, ${placeholderSalt + ':' + placeholderHash}, ${cleanEmail}, ${cleanFullName}, ${finalRole}, ${quotas.planName},
                ${projectLimit != null ? projectLimit : null}, ${editLimit != null ? editLimit : null}, ${modifyLimit != null ? modifyLimit : null}, ${autofillLimit != null ? autofillLimit : null});
      `;
    } catch (err) {
      if (String(err.message || '').includes('duplicate key')) {
        res.status(409).json({ error: { message: 'An account with that email already exists.' } });
        return;
      }
      console.error('Could not create user:', err);
      res.status(500).json({ error: { message: 'Could not create user.' } });
      return;
    }

    try {
      // Single-use set-password token — same table + hashing as the signup approval flow.
      await sql`
        CREATE TABLE IF NOT EXISTS password_setup_tokens (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ
        );
      `;
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      await sql`INSERT INTO password_setup_tokens (token_hash, user_id, expires_at) VALUES (${tokenHash}, ${id}, NOW() + INTERVAL '7 days');`;
      const setupUrl = 'https://designslab.ai/set-password.html?token=' + rawToken;

      const fmtLimit = (v, singular, plural) => v != null ? (v + ' ' + (v === 1 ? singular : plural)) : ('unlimited ' + plural);
      const welcomeHtml = buildBrandedEmail({
        previewText: 'Congratulations — your DesignsLab AI account is ready, on the ' + (quotas.planName || 'Free Trial') + ' plan.',
        greeting: cleanEmail,
        paragraphs: [
          'Congratulations! Your DesignsLab AI account has been created and your <strong>' + (quotas.planName || 'Free Trial') + ' plan</strong> is active.',
          'Your plan includes:'
            + '<br>\u2022 <strong>' + fmtLimit(projectLimit != null ? projectLimit : null, 'project', 'projects') + '</strong>'
            + '<br>\u2022 <strong>' + fmtLimit(modifyLimit != null ? modifyLimit : null, 'design modification', 'design modifications') + '</strong>'
            + '<br>\u2022 <strong>' + fmtLimit(editLimit != null ? editLimit : null, 'image edit', 'image edits') + '</strong>',
          'Your username is your email address: <strong>' + cleanEmail + '</strong>. Click below to set your password — the link is personal to you and valid for 7 days, and setting your password signs you straight in.',
        ],
        ctaLabel: 'Set Your Password',
        ctaUrl: setupUrl,
        footnote: 'You are receiving this because a DesignsLab AI account was created for this address. If this was unexpected, you can ignore this email.',
      });
      const sendResult = await sendTransactionalEmail({
        toEmail: cleanEmail,
        toName: cleanEmail,
        subject: 'Welcome to DesignsLab AI \u2014 your ' + (quotas.planName || 'Free Trial') + ' plan is active',
        html: welcomeHtml,
      });
      if (!sendResult.sent) throw new Error(sendResult.error || 'email send failed');
    } catch (err) {
      // Roll back: an account whose owner never received the set-password email is
      // unreachable — remove it so the admin can simply retry cleanly.
      console.error('admin-users: welcome/set-password email failed, rolling back user:', err);
      try {
        await sql`DELETE FROM password_setup_tokens WHERE user_id = ${id};`;
        await sql`DELETE FROM users WHERE id = ${id};`;
      } catch (rollbackErr) { console.error('admin-users: rollback failed:', rollbackErr); }
      res.status(502).json({ error: { message: 'The account could not be emailed its Set Password link (check Mandrill in Usage & Billing) \u2014 nothing was created. Please try again.' } });
      return;
    }

    res.status(200).json({ ok: true, id, emailSent: true });
    return;
  }

  if (req.method === 'PATCH') {
    const { id, role, plan, projectLimit, editLimit, modifyLimit, autofillLimit, resetEditCount, resetModifyCount, resetAutofillCount, newPassword } = req.body || {};
    if (!id) {
      res.status(400).json({ error: { message: 'User id is required.' } });
      return;
    }

    if (newPassword) {
      if (newPassword.length < 6) {
        res.status(400).json({ error: { message: 'Password must be at least 6 characters.' } });
        return;
      }
      await sql`UPDATE users SET password_hash = ${hashPassword(newPassword)} WHERE id = ${id};`;
    }
    if (role === 'admin' || role === 'member') {
      await sql`UPDATE users SET role = ${role} WHERE id = ${id};`;
    }
    if (projectLimit !== undefined) {
      await sql`UPDATE users SET project_limit = ${projectLimit} WHERE id = ${id};`;
    }
    if (editLimit !== undefined) {
      await sql`UPDATE users SET edit_limit = ${editLimit} WHERE id = ${id};`;
    }
    if (modifyLimit !== undefined) {
      await sql`UPDATE users SET modify_limit = ${modifyLimit} WHERE id = ${id};`;
    }
    if (resetEditCount) {
      await sql`UPDATE users SET edit_count = 0 WHERE id = ${id};`;
    }
    if (resetModifyCount) {
      await sql`UPDATE users SET modify_count = 0 WHERE id = ${id};`;
    }
    if (autofillLimit !== undefined) {
      await sql`UPDATE users SET autofill_limit = ${autofillLimit} WHERE id = ${id};`;
    }
    if (resetAutofillCount) {
      await sql`UPDATE users SET autofill_count = 0 WHERE id = ${id};`;
    }
    if (plan !== undefined) {
      // '' / null clears the plan (back to free trial); otherwise only the three real plans.
      const cleanPlan = ['Starter', 'Studio', 'Pro'].includes(plan) ? plan : null;
      await sql`UPDATE users SET plan = ${cleanPlan} WHERE id = ${id};`;
    }

    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) {
      res.status(400).json({ error: { message: 'User id is required.' } });
      return;
    }
    if (id === 'master-admin') {
      res.status(400).json({ error: { message: 'The master admin account cannot be deleted.' } });
      return;
    }

    // Deleting a user now also removes all of their projects, and every image/video-frame
    // asset those projects reference in Blob storage — a deliberate reversal of this
    // project's earlier "leave projects ownerless" behavior (see prior comment history),
    // per an explicit request that a deleted user's projects should not linger at all.
    const userProjects = await sql`SELECT data FROM projects WHERE user_id = ${id};`;
    const blobPaths = [];
    userProjects.rows.forEach(row => collectBlobPaths(row.data, blobPaths));
    if (blobPaths.length > 0) {
      try {
        await Promise.all(blobPaths.map(p => del(p)));
      } catch (err) {
        // Don't block the user deletion itself on cleanup failing — an orphaned blob
        // file is a minor storage cost, a user that won't delete is worse.
        console.error('Could not clean up some blob files for user', id, err);
      }
    }
    await sql`DELETE FROM projects WHERE user_id = ${id};`;
    await sql`DELETE FROM users WHERE id = ${id};`;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: { message: 'Method not allowed.' } });
}
