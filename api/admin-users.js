import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

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
    // Includes each user's live project count alongside their limit, so the admin panel
    // can show "3 / 10 projects" without a second round trip per user.
    const result = await sql`
      SELECT u.id, u.username, u.role, u.project_limit, u.edit_limit, u.edit_count, u.modify_limit, u.modify_count, u.created_at,
             COUNT(p.id)::int AS project_count
      FROM users u
      LEFT JOIN projects p ON p.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at ASC;
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
    await sql`DELETE FROM users WHERE id = ${id};`;
    // Note: this project intentionally leaves that user's existing projects in place
    // (ownerless) rather than deleting them — removing someone's access shouldn't
    // destroy work they already produced. An admin can still see them via the "all
    // projects" admin view.
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: { message: 'Method not allowed.' } });
}
