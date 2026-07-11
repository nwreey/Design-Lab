import { sql } from '@vercel/postgres';
import { put, get, del } from '@vercel/blob';

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
      data JSONB NOT NULL
    );
  `;
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
    const out = [];
    for (const item of node) out.push(await extractImages(item, projectId, uploadedCountRef));
    return out;
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) {
      out[key] = await extractImages(node[key], projectId, uploadedCountRef);
    }
    return out;
  }
  if (typeof node === 'string' && DATA_URL_RE.test(node)) {
    const mimeMatch = node.match(/^data:([^;]+);base64,/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const base64 = node.slice(node.indexOf(',') + 1);
    const buffer = Buffer.from(base64, 'base64');
    const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : mime.includes('pdf') ? 'pdf' : mime.includes('svg') ? 'svg' : 'bin';
    const pathname = `projects/${projectId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const blob = await put(pathname, buffer, { access: 'private', contentType: mime, addRandomSuffix: false });
    uploadedCountRef.count++;
    return 'blob:' + blob.pathname;
  }
  return node;
}

async function inlineImages(node) {
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) out.push(await inlineImages(item));
    return out;
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) {
      out[key] = await inlineImages(node[key]);
    }
    return out;
  }
  if (typeof node === 'string') {
    const match = node.match(BLOB_REF_RE);
    if (match) {
      const pathname = match[1];
      try {
        const result = await get(pathname, { access: 'private' });
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
      const result = await sql`SELECT id, name, saved_at, data FROM projects WHERE id = ${id};`;
      if (result.rows.length === 0) {
        res.status(404).json({ error: { message: 'Project not found.' } });
        return;
      }
      const row = result.rows[0];
      const resolvedData = await inlineImages(row.data);
      res.status(200).json({ id: row.id, name: row.name, savedAt: row.saved_at, ...resolvedData });
      return;
    }

    // No id — lightweight list for the sidebar, no image data at all.
    const result = await sql`SELECT id, name, saved_at FROM projects ORDER BY saved_at DESC;`;
    res.status(200).json(result.rows.map(r => ({ id: r.id, name: r.name, savedAt: r.saved_at })));
    return;
  }

  if (req.method === 'POST') {
    const project = req.body || {};
    if (!project.id || !project.name) {
      res.status(400).json({ error: { message: 'Project must include id and name.' } });
      return;
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
    await sql`
      INSERT INTO projects (id, name, saved_at, data)
      VALUES (${project.id}, ${project.name}, ${savedAt}, ${JSON.stringify(storedData)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, saved_at = EXCLUDED.saved_at, data = EXCLUDED.data;
    `;

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
    const result = await sql`UPDATE projects SET name = ${name} WHERE id = ${id} RETURNING id;`;
    if (result.rows.length === 0) {
      res.status(404).json({ error: { message: 'Project not found.' } });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) {
      res.status(400).json({ error: { message: 'Delete requires an id.' } });
      return;
    }
    const result = await sql`SELECT data FROM projects WHERE id = ${id};`;
    if (result.rows.length > 0) {
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
    }
    await sql`DELETE FROM projects WHERE id = ${id};`;
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: { message: 'Method not allowed.' } });
}
