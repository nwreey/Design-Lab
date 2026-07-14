import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });
import { del } from '@vercel/blob';

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

  if (req.method === 'GET') {
    // project_count is the persistent, increment-only counter (see ensureSchema) — it
    // reflects how many projects actually count against this user's limit, which is not
    // necessarily the same as how many they currently have saved if any were deleted.
    const result = await sql`
      SELECT id, username, role, project_limit, project_count, edit_limit, edit_count, modify_limit, modify_count, created_at
      FROM users
      ORDER BY created_at ASC;
    `;
    res.status(200).json(result.rows);
    return;
  }

  if (req.method === 'POST') {
    const { username, password, role, projectLimit, editLimit, modifyLimit } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: { message: 'Username and password are required.' } });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: { message: 'Password must be at least 6 characters.' } });
      return;
    }
    const finalRole = role === 'admin' ? 'admin' : 'member';
    const id = generateUserId();
    const passwordHash = hashPassword(password);

    try {
      await sql`
        INSERT INTO users (id, username, password_hash, role, project_limit, edit_limit, modify_limit)
        VALUES (${id}, ${username}, ${passwordHash}, ${finalRole},
                ${projectLimit != null ? projectLimit : null}, ${editLimit != null ? editLimit : null}, ${modifyLimit != null ? modifyLimit : null});
      `;
    } catch (err) {
      if (String(err.message || '').includes('duplicate key')) {
        res.status(409).json({ error: { message: 'That username is already taken.' } });
        return;
      }
      console.error('Could not create user:', err);
      res.status(500).json({ error: { message: 'Could not create user.' } });
      return;
    }

    res.status(200).json({ ok: true, id });
    return;
  }

  if (req.method === 'PATCH') {
    const { id, role, projectLimit, editLimit, modifyLimit, resetEditCount, resetModifyCount, newPassword } = req.body || {};
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
