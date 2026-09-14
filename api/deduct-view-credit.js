import { neon } from '@neondatabase/serverless';
import { requireCaller } from '../lib/require-auth.js';
import { tryConsumeFreeFirstModification } from '../lib/free-mod.js';
const sql = neon(process.env.DATABASE_URL, { fullResults: true });

/* ================= Camera-view credit deduction for Luma-sourced frames =================
   OWNER FEATURE (Sep 2026): exterior camera views are now (when available) extracted as
   still frames from one Luma 360 orbit video instead of each being its own OpenAI/Gemini
   edit call — see requestCameraViewFromLumaFrame's own comment in ai-design-studio.html.
   That is genuinely cheaper and faster for us, but the CLIENT still owes exactly the same
   "1 view = 1 edit credit" the owner's pricing already promises, whether that view's pixels
   came from an OpenAI edit or a Luma frame. Since there is no OpenAI/Gemini call to piggy-
   back the existing isUserInitiatedEdit billing branch on for a Luma-sourced view, this is a
   tiny, standalone endpoint that does ONLY the accounting side — check quota, consume it,
   nothing else — mirroring api/edit-image-openai.js's checkEditQuota/incrementEditCount
   exactly (same table/columns, same admin-exempt and free-first-modification rules) so a
   user's total edit usage is identical regardless of which pipeline actually rendered a
   given view. This endpoint never talks to any image/video provider and never returns image
   data — it only ever answers "was this credit available, and is it now spent."
   Fails CLOSED on a DB error (unlike some other fail-open checks in this app) because this
   is the actual quota ledger — silently granting free views on a database hiccup would be a
   real revenue leak, not a minor missed nicety. */

async function checkEditQuota(caller) {
  if (!caller || caller.role === 'admin') return null;
  try {
    const result = await sql`SELECT edit_limit, edit_count FROM users WHERE id = ${caller.userId};`;
    if (result.rows.length === 0) return null;
    const { edit_limit, edit_count } = result.rows[0];
    if (edit_limit != null && edit_count >= edit_limit) {
      return `You've reached your edit limit (${edit_limit}). Please contact your administrator to increase this limit.`;
    }
  } catch (err) {
    console.error('deduct-view-credit: could not check edit quota:', err);
    return 'Could not verify your usage right now. Please try again.';
  }
  return null;
}

async function incrementEditCount(caller) {
  if (!caller || caller.role === 'admin') return;
  await sql`UPDATE users SET edit_count = edit_count + 1 WHERE id = ${caller.userId};`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
    return;
  }

  const caller = requireCaller(req, res);
  if (!caller) return;

  try {
    const { isFreeFirstModification, projectId } = req.body || {};

    let freeApplied = false;
    if (isFreeFirstModification) {
      freeApplied = await tryConsumeFreeFirstModification(sql, caller.userId, projectId);
    }

    if (!freeApplied) {
      const quotaError = await checkEditQuota(caller);
      if (quotaError) {
        res.status(403).json({ error: { message: quotaError } });
        return;
      }
      await incrementEditCount(caller);
    }

    res.status(200).json({ ok: true, freeApplied });
  } catch (err) {
    console.error('deduct-view-credit failed:', err);
    res.status(500).json({ error: { message: 'Could not record usage for this view. Please try again.' } });
  }
}
