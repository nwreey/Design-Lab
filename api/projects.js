import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });
import { put, get, del } from '@vercel/blob';

/* ================= Caller identity ================= */
/* Same token verification as login.js/admin-users.js/me.js, duplicated here rather than
   imported from a shared module — this file runs on Vercel's Node runtime and the token
   format is small enough that keeping each file's own copy avoids any cross-file import
   path fragility, matching the pattern already used elsewhere in this project. */
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

/* ================= Schema ================= */
/* Auto-creates the table on first use — no manual migration step required. Projects are
   stored as a single JSONB document per row, matching the existing client-side project
   shape exactly (this mirrors how the app already worked with IndexedDB — one JSON object
   per project — rather than normalizing into many relational tables, which would need a
   much larger rewrite of the save/load logic for no real benefit at this app's scale). */
async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      saved_at TIMESTAMPTZ NOT NULL,
      data JSONB NOT NULL,
      user_id TEXT
    );
  `;
  // Adds the column if this table already existed from before multi-user support —
  // CREATE TABLE IF NOT EXISTS above won't add columns to an existing table by itself.
  await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id TEXT;`;

  // users.project_count is a permanent, increment-only quota counter (see the matching,
  // more detailed migration comment in api/admin-users.js) — this file needs to read and
  // write it too, and can't assume that file's migration has already run, since each
  // serverless function is independent and either one could be the first hit after a
  // deployment. Whichever file actually adds the column first must also be the one that
  // backfills it — otherwise the other file would see the column already exists and skip
  // its own backfill, permanently stranding existing users at project_count = 0.
  const colCheck = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'project_count';`;
  const columnAlreadyExisted = colCheck.rows.length > 0;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS project_count INTEGER NOT NULL DEFAULT 0;`;
  if (!columnAlreadyExisted) {
    await sql`UPDATE users SET project_count = (SELECT COUNT(*)::int FROM projects WHERE projects.user_id = users.id);`;
  }
}

/* ================= Image extraction (save) / inlining (load) ================= */
/* The client's project object embeds images as base64 data URLs, deeply nested at many
   different positions (gallery entries, per-camera-view edit histories, logo, poster
   files, reference image). Rather than hardcode every one of those paths, this walks the
   ENTIRE object generically: any string value that looks like a data URL gets uploaded to
   Blob and replaced with a "blob:<pathname>" marker; the reverse walk on load replaces
   every "blob:" marker with the real inline data URL, fetched from Blob. This means the
   client's data shape is identical before and after storage — only the persistence layer
   changes, nothing about how the rest of the app renders a project needs to change. */

const DATA_URL_RE = /^data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,/;
const BLOB_REF_RE = /^blob:(.+)$/;

async function extractImages(node, projectId, uploadedCountRef) {
  if (Array.isArray(node)) {
    return Promise.all(node.map(item => extractImages(item, projectId, uploadedCountRef)));
  }
  if (node && typeof node === 'object') {
    const keys = Object.keys(node);
    const values = await Promise.all(keys.map(key => extractImages(node[key], projectId, uploadedCountRef)));
    const out = {};
    keys.forEach((key, i) => { out[key] = values[i]; });
    return out;
  }
  if (typeof node === 'string' && DATA_URL_RE.test(node)) {
    const mimeMatch = node.match(/^data:([^;]+);base64,/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const base64 = node.slice(node.indexOf(',') + 1);
    const buffer = Buffer.from(base64, 'base64');
    const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : mime.includes('pdf') ? 'pdf' : mime.includes('svg') ? 'svg' : 'bin';
    const pathname = `projects/${projectId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const blob = await put(pathname, buffer, { access: 'public', contentType: mime, addRandomSuffix: false });
    uploadedCountRef.count++;
    return 'blob:' + blob.url;
  }
  return node;
}

async function inlineImages(node) {
  if (Array.isArray(node)) {
    return Promise.all(node.map(item => inlineImages(item)));
  }
  if (node && typeof node === 'object') {
    const keys = Object.keys(node);
    const values = await Promise.all(keys.map(key => inlineImages(node[key])));
    const out = {};
    keys.forEach((key, i) => { out[key] = values[i]; });
    return out;
  }
  if (typeof node === 'string') {
    const match = node.match(BLOB_REF_RE);
    if (match) {
      const ref = match[1];
      // New format: the full public URL was stored directly — no server-side round trip
      // needed at all, since the browser can fetch a public blob URL itself. This is both
      // faster (the project payload no longer embeds megabytes of base64) and more
      // reliable (removes an entire class of failure around get()'s access-mode matching).
      if (/^https?:\/\//.test(ref)) {
        return ref;
      }
      // Old format (projects saved before this change): ref is a bare pathname, which
      // needs the original fetch-and-inline approach. Left in place for backward
      // compatibility — if the blob store has since been disconnected or replaced, this
      // will still fail the same way it always could, but that's a data-availability
      // issue for that specific old project, not something this code path can fix.
      const pathname = ref;
      try {
        const result = await get(pathname, { access: 'public' });
        if (!result || result.statusCode !== 200 || !result.stream) return node; // leave the marker if not found, don't crash the whole load
        const contentType = result.blob.contentType || 'application/octet-stream';
        const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
        return `data:${contentType};base64,${buffer.toString('base64')}`;
      } catch (err) {
        console.error('Could not inline blob', pathname, err);
        return node;
      }
    }
  }
  return node;
}

/* Collects every "blob:<pathname>" marker still present in a project's stored JSON —
   used when deleting a project, so its image files get cleaned up too instead of being
   left behind as orphaned storage. */
function collectBlobPaths(node, out) {
  if (Array.isArray(node)) {
    node.forEach(item => collectBlobPaths(item, out));
  } else if (node && typeof node === 'object') {
    Object.keys(node).forEach(key => collectBlobPaths(node[key], out));
  } else if (typeof node === 'string') {
    const match = node.match(BLOB_REF_RE);
    if (match) out.push(match[1]);
  }
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
    res.status(500).json({ error: { message: 'Database is not reachable. Check POSTGRES_URL / DATABASE_URL is set.' } });
    return;
  }

  if (req.method === 'GET') {
    const { id } = req.query;

    if (id) {
      const result = await sql`SELECT id, name, saved_at, data, user_id FROM projects WHERE id = ${id};`;
      if (result.rows.length === 0) {
        res.status(404).json({ error: { message: 'Project not found.' } });
        return;
      }
      const row = result.rows[0];
      if (caller.role !== 'admin' && row.user_id && row.user_id !== caller.userId) {
        res.status(403).json({ error: { message: 'You do not have access to this project.' } });
        return;
      }
      const resolvedData = await inlineImages(row.data);
      res.status(200).json({ id: row.id, name: row.name, savedAt: row.saved_at, ...resolvedData });
      return;
    }

    // No id — lightweight list for the sidebar, no image data at all. Admins see every
    // project; everyone else sees only their own.
    const result = caller.role === 'admin'
      ? await sql`SELECT id, name, saved_at, user_id FROM projects ORDER BY saved_at DESC;`
      : await sql`SELECT id, name, saved_at, user_id FROM projects WHERE user_id = ${caller.userId} ORDER BY saved_at DESC;`;
    res.status(200).json(result.rows.map(r => ({ id: r.id, name: r.name, savedAt: r.saved_at })));
    return;
  }

  if (req.method === 'POST') {
    const project = req.body || {};
    if (!project.id || !project.name) {
      res.status(400).json({ error: { message: 'Project must include id and name.' } });
      return;
    }

    const existing = await sql`SELECT user_id FROM projects WHERE id = ${project.id};`;
    const isNewProject = existing.rows.length === 0;

    if (!isNewProject) {
      const ownerId = existing.rows[0].user_id;
      if (caller.role !== 'admin' && ownerId && ownerId !== caller.userId) {
        res.status(403).json({ error: { message: 'You do not have access to this project.' } });
        return;
      }
    } else if (caller.role !== 'admin') {
      // Enforce the project quota only when actually creating a NEW project — editing an
      // existing one you already own should never be blocked by a creation limit.
      // Uses the PERMANENT project_count counter, not a live COUNT(*) of currently-existing
      // rows — deleting a project must not free up a slot, or the limit could be bypassed
      // indefinitely by creating and deleting projects.
      const userResult = await sql`SELECT project_limit, project_count FROM users WHERE id = ${caller.userId};`;
      const limit = userResult.rows.length > 0 ? userResult.rows[0].project_limit : null;
      const currentCount = userResult.rows.length > 0 ? userResult.rows[0].project_count : 0;
      if (limit != null && currentCount >= limit) {
        res.status(403).json({ error: { message: `You've reached your project limit (${limit}). Please contact your administrator to increase this limit.` } });
        return;
      }
    }

    const uploadedCountRef = { count: 0 };
    let storedData;
    try {
      storedData = await extractImages(project, project.id, uploadedCountRef);
    } catch (err) {
      console.error('Image upload to Blob failed:', err);
      res.status(500).json({ error: { message: 'Could not upload one or more images: ' + (err.message || 'unknown error') } });
      return;
    }

    const savedAt = project.savedAt || new Date().toISOString();
    const ownerForInsert = isNewProject ? caller.userId : (existing.rows[0].user_id || caller.userId);
    await sql`
      INSERT INTO projects (id, name, saved_at, data, user_id)
      VALUES (${project.id}, ${project.name}, ${savedAt}, ${JSON.stringify(storedData)}::jsonb, ${ownerForInsert})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, saved_at = EXCLUDED.saved_at, data = EXCLUDED.data;
    `;
    if (isNewProject && caller.role !== 'admin') {
      await sql`UPDATE users SET project_count = project_count + 1 WHERE id = ${caller.userId};`;
    }

    res.status(200).json({ ok: true, id: project.id, uploadedImageCount: uploadedCountRef.count, storedProject: storedData });
    return;
  }

  if (req.method === 'PATCH') {
    // Lightweight rename — touches only the name column, never re-walks or re-uploads images.
    const { id, name } = req.body || {};
    if (!id || !name) {
      res.status(400).json({ error: { message: 'Rename requires id and name.' } });
      return;
    }
    const existing = await sql`SELECT user_id FROM projects WHERE id = ${id};`;
    if (existing.rows.length === 0) {
      res.status(404).json({ error: { message: 'Project not found.' } });
      return;
    }
    if (caller.role !== 'admin' && existing.rows[0].user_id && existing.rows[0].user_id !== caller.userId) {
      res.status(403).json({ error: { message: 'You do not have access to this project.' } });
      return;
    }
    await sql`UPDATE projects SET name = ${name} WHERE id = ${id};`;
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) {
      res.status(400).json({ error: { message: 'Delete requires an id.' } });
      return;
    }
    const result = await sql`SELECT data, user_id FROM projects WHERE id = ${id};`;
    if (result.rows.length === 0) {
      res.status(200).json({ ok: true }); // already gone — deleting a nonexistent project isn't an error
      return;
    }
    if (caller.role !== 'admin' && result.rows[0].user_id && result.rows[0].user_id !== caller.userId) {
      res.status(403).json({ error: { message: 'You do not have access to this project.' } });
      return;
    }

    const blobPaths = [];
    collectBlobPaths(result.rows[0].data, blobPaths);
    if (blobPaths.length > 0) {
      try {
        await Promise.all(blobPaths.map(p => del(p)));
      } catch (err) {
        // Don't block the actual project deletion on cleanup failing — an orphaned
        // blob file is a minor storage cost, a project that won't delete is worse.
        console.error('Could not clean up some blob files for project', id, err);
      }
    }
    await sql`DELETE FROM projects WHERE id = ${id};`;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: { message: 'Method not allowed.' } });
}
