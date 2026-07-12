import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

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

export default async function handler(req, res) {
  const signingSecret = process.env.SITE_PASSWORD || '';
  const cookieHeader = req.headers.cookie || '';
  const token = parseCookie(cookieHeader, 'design_lab_auth');
  const payload = signingSecret ? verifyTokenNode(token, signingSecret) : null;

  if (!payload) {
    res.status(401).json({ error: { message: 'Not logged in.' } });
    return;
  }

  // Admins have no project, edit, or modify limit — skip the lookup entirely, matching
  // how the quota enforcement in /api/projects, /api/edit-image-openai, and
  // /api/generate-image-gemini already exempts admin accounts.
  let projectLimit = null;
  let projectCount = 0;
  let editLimit = null;
  let editCount = 0;
  let modifyLimit = null;
  let modifyCount = 0;
  if (payload.role !== 'admin') {
    try {
      const [userResult, countResult] = await Promise.all([
        sql`SELECT project_limit, edit_limit, edit_count, modify_limit, modify_count FROM users WHERE id = ${payload.userId};`,
        sql`SELECT COUNT(*)::int AS count FROM projects WHERE user_id = ${payload.userId};`,
      ]);
      if (userResult.rows.length > 0) {
        projectLimit = userResult.rows[0].project_limit;
        editLimit = userResult.rows[0].edit_limit;
        editCount = userResult.rows[0].edit_count || 0;
        modifyLimit = userResult.rows[0].modify_limit;
        modifyCount = userResult.rows[0].modify_count || 0;
      }
      projectCount = countResult.rows[0].count;
    } catch (err) {
      // Don't fail the whole /api/me call over this — the sidebar simply won't show a
      // usage count if it can't be looked up, which is a safe, minor degradation.
      console.error('Could not look up project/edit/modify limit and count:', err);
    }
  }

  res.status(200).json({ userId: payload.userId, username: payload.username, role: payload.role, projectLimit, projectCount, editLimit, editCount, modifyLimit, modifyCount });
}
