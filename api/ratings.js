import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* Same token verification duplicated across the auth-aware endpoints in this project —
   see api/projects.js for the fuller explanation of why this isn't a shared import. */
function getCaller(req) {
  const signingSecret = process.env.SITE_PASSWORD || '';
  if (!signingSecret) return null;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|; )design_lab_auth=([^;]*)/);
  const token = match ? decodeURIComponent(match[1]) : null;
  if (!token) return null;
  const separatorIndex = token.indexOf('.');
  if (separatorIndex === -1) return null;
  const payloadB64 = token.substring(0, separatorIndex);
  const signature = token.substring(separatorIndex + 1);
  const expectedSignature = crypto.createHmac('sha256', signingSecret).update(payloadB64).digest('hex');
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

/* One row per (project, user) — a person can update their rating for a project (e.g. they
   tap 3 stars, then reconsider and tap 5), but not accumulate multiple separate rows for
   the same project, which would double-count them in the admin panel's average. */
async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS ratings (
      id SERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_name TEXT,
      user_id TEXT NOT NULL,
      username TEXT,
      stars INTEGER NOT NULL,
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_id, user_id)
    );
  `;
}

export default async function handler(req, res) {
  const caller = getCaller(req);
  if (!caller) {
    res.status(401).json({ error: { message: 'Not logged in.' } });
    return;
  }

  try {
    await ensureSchema();
  } catch (err) {
    console.error('Schema setup failed:', err);
    res.status(500).json({ error: { message: 'Database is not reachable. Check DATABASE_URL is set.' } });
    return;
  }

  if (req.method === 'POST') {
    const { projectId, projectName, stars, comment } = req.body || {};
    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ error: { message: 'projectId is required.' } });
      return;
    }
    const starsNum = Number(stars);
    if (!Number.isInteger(starsNum) || starsNum < 1 || starsNum > 5) {
      res.status(400).json({ error: { message: 'stars must be a whole number from 1 to 5.' } });
      return;
    }
    const trimmedComment = typeof comment === 'string' ? comment.trim().slice(0, 1000) : null;

    await sql`
      INSERT INTO ratings (project_id, project_name, user_id, username, stars, comment, created_at, updated_at)
      VALUES (${projectId}, ${projectName || null}, ${caller.userId}, ${caller.username || null}, ${starsNum}, ${trimmedComment || null}, NOW(), NOW())
      ON CONFLICT (project_id, user_id) DO UPDATE SET
        stars = EXCLUDED.stars,
        comment = EXCLUDED.comment,
        project_name = EXCLUDED.project_name,
        updated_at = NOW();
    `;
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'GET') {
    // Ratings are only meaningful in aggregate across the whole team, not per-person, so
    // this is admin-only rather than scoped to the caller's own submissions.
    if (caller.role !== 'admin') {
      res.status(403).json({ error: { message: 'Admin access required.' } });
      return;
    }
    const result = await sql`
      SELECT id, project_id, project_name, user_id, username, stars, comment, created_at, updated_at
      FROM ratings
      ORDER BY updated_at DESC;
    `;
    const rows = result.rows.map(r => ({
      id: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      userId: r.user_id,
      username: r.username,
      stars: r.stars,
      comment: r.comment,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    const count = rows.length;
    const average = count > 0 ? rows.reduce((sum, r) => sum + r.stars, 0) / count : null;
    res.status(200).json({ ratings: rows, count, average });
    return;
  }

  res.status(405).json({ error: { message: 'Method not allowed.' } });
}
