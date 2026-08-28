/* ================= Admin: Service Usage & Billing report =================
   One admin-only endpoint that aggregates the live status of every PAID external service
   this platform depends on, so an expiring key, exhausted credit balance, or full storage
   shows up in the admin panel BEFORE it takes the site down (owner requirement: "I don't
   want to be surprised one is expired while I am opening the website").

   Three layers, in order of reliability:
   1. LIVE provider checks — real balances/quotas where the provider actually exposes them:
      - OpenAI: real spend via the official org Costs API (needs OPENAI_ADMIN_KEY, an admin
        key from platform.openai.com — regular sk- keys cannot read billing).
      - Luma: credits endpoint.
      - Mandrill: users/info (hourly quota, reputation, backlog).
      - Vercel Blob: total stored bytes (walked via list()).
      - Neon Postgres: storage used per project (needs NEON_API_KEY).
      - Gemini: NO billing API exists for API keys — a live key-health ping (models list)
        stands in: it distinguishes valid key / invalid key / quota exhausted.
   2. INTERNAL counters — every AI/provider call is logged into ai_usage_log by
      lib/usage-log.js; this reports per-provider calls today / this month, failures, and
      the most recent failure per provider classified as auth/billing/quota/other. This is
      the early-warning layer that works even for providers with no billing API: the first
      failed call flips that service red in the panel.
   3. MANUAL renewal dates — for services with no API at all (Vercel plan, domain, etc.)
      the admin records a renewal date once; the panel counts down and warns at 30/7 days.

   Every provider sub-check is independently try/caught and reports one of:
   ok | warning | error | not_configured — one provider being down or unconfigured never
   breaks the rest of the report. */

import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';
import { list } from '@vercel/blob';

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL, { fullResults: true }) : null;

export const config = { maxDuration: 60 };

/* Same admin re-verification as api/admin-users.js — middleware.js also gates this path,
   but defense in depth (see that file's identical comment). */
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

async function fetchJson(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    const response = await fetch(url, { ...opts, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* leave null */ }
    return { ok: response.ok, status: response.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Layer 1: live provider checks (each fully independent) ---------- */

async function checkOpenAi() {
  // trim(): a key pasted into Vercel env with a stray trailing space/newline is otherwise
  // sent verbatim in the Authorization header and rejected.
  const adminKey = (process.env.OPENAI_ADMIN_KEY || '').trim() || null;
  if (!adminKey) {
    return {
      status: process.env.OPENAI_API_KEY ? 'warning' : 'not_configured',
      note: process.env.OPENAI_API_KEY
        ? 'OPENAI_ADMIN_KEY not set — real spend unavailable. Create an Admin key at platform.openai.com → Settings → API keys → Admin keys and add it to Vercel env to see costs here.'
        : 'OPENAI_API_KEY is not set at all — OpenAI features are down.',
    };
  }
  const now = new Date();
  const monthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
  const dayStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
  const r = await fetchJson(
    `https://api.openai.com/v1/organization/costs?start_time=${monthStart}&bucket_width=1d&limit=31`,
    { headers: { Authorization: `Bearer ${adminKey}` } }
  );
  if (!r.ok) {
    const msg = (r.data && r.data.error && r.data.error.message) || `HTTP ${r.status}`;
    let scopeHint = '';
    if (r.status === 401 || r.status === 403) {
      // Disambiguate the two very different causes of a 401/403 here by probing a second
      // admin-scoped endpoint that needs a DIFFERENT permission (org read, not usage read):
      //  - probe also fails  → the key isn't an Admin key at all (or wrong/stale env value)
      //  - probe succeeds    → the key IS an Admin key, but was created with restricted
      //                        permissions that exclude Usage/Costs read
      try {
        const probe = await fetchJson('https://api.openai.com/v1/organization/projects?limit=1', { headers: { Authorization: `Bearer ${adminKey}` } });
        scopeHint = probe.ok
          ? ' DIAGNOSIS: the key IS a valid Admin key, but it was created with restricted permissions that exclude Usage/Costs read. Create a new Admin key and in the creation dialog set Permissions to ALL (or at least Read access to Usage and Billing), then replace OPENAI_ADMIN_KEY in Vercel env and REDEPLOY — env changes only apply to new deployments.'
          : ' DIAGNOSIS: the key is not being accepted as an Admin key at all. Check: (1) it must start with sk-admin-, created under Settings → Organization → Admin keys (only visible to organization Owners) — a normal sk-/sk-proj- key can never read billing; (2) it was saved to the Production environment in Vercel env; (3) you REDEPLOYED after saving it — env changes only apply to new deployments.';
      } catch (probeErr) { /* leave generic hint below */ }
      if (!scopeHint) scopeHint = ' Create a NEW Admin key with full/read-all permissions (platform.openai.com → Settings → Organization → Admin keys), replace OPENAI_ADMIN_KEY in Vercel env, and redeploy.';
    }
    return { status: 'error', note: 'Costs API rejected the admin key: ' + msg + scopeHint };
  }
  let monthUsd = 0;
  let todayUsd = 0;
  (r.data.data || []).forEach((bucket) => {
    let bucketTotal = 0;
    (bucket.results || []).forEach((item) => {
      const amt = item.amount && typeof item.amount.value === 'number' ? item.amount.value : 0;
      bucketTotal += amt;
    });
    monthUsd += bucketTotal;
    if (bucket.start_time >= dayStart) todayUsd += bucketTotal;
  });
  return { status: 'ok', monthUsd: Math.round(monthUsd * 100) / 100, todayUsd: Math.round(todayUsd * 100) / 100 };
}

async function checkGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { status: 'not_configured', note: 'GEMINI_API_KEY is not set — Gemini generation is down.' };
  const r = await fetchJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (r.ok) return { status: 'ok', note: 'Key valid and responding. Google exposes no billing API for API keys — watch the internal counters and failures below for early warning.' };
  const msg = (r.data && r.data.error && r.data.error.message) || `HTTP ${r.status}`;
  if (r.status === 429) return { status: 'warning', note: 'Key valid but QUOTA EXHAUSTED right now: ' + msg };
  return { status: 'error', note: 'Key check failed: ' + msg };
}

async function checkLuma() {
  const apiKey = process.env.LUMA_AGENTS_API_KEY;
  if (!apiKey) return { status: 'not_configured', note: 'LUMA_AGENTS_API_KEY is not set.' };
  // The app calls agents.lumalabs.ai; credits live on the Dream Machine API surface. Try
  // BOTH hosts before concluding anything — an Agents-scoped key commonly gets a 403 from
  // one surface while the other still answers, so a single 403 must not be treated as an
  // expired key (that false alarm shipped once; the owner's key was working fine for
  // generation the whole time).
  const rejections = [];
  for (const url of ['https://agents.lumalabs.ai/v1/credits', 'https://api.lumalabs.ai/dream-machine/v1/credits']) {
    try {
      const r = await fetchJson(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (r.ok && r.data) {
        const credits = r.data.credit_balance != null ? r.data.credit_balance : (r.data.credits != null ? r.data.credits : null);
        if (credits != null) {
          return { status: credits <= 0 ? 'error' : (credits < 500 ? 'warning' : 'ok'), credits, note: credits <= 0 ? 'NO CREDITS LEFT — video generation is down.' : (credits < 500 ? 'Credits running low.' : '') };
        }
        return { status: 'ok', note: 'Key valid; credits field not present in response.' };
      }
      rejections.push('HTTP ' + r.status);
    } catch (err) { rejections.push(err && err.message ? err.message : 'network error'); }
  }
  // Credits unreadable from both hosts — that is a visibility gap, not proof the key is
  // dead: this key type may simply not be allowed to read the credits endpoint. Video
  // generation calls are logged in the internal counters, which is where an actually-dead
  // key shows up as failures.
  return { status: 'warning', note: 'Could not read Luma credits (' + rejections.join(', ') + ') — this key type may not have access to the credits endpoint. Video generation may still work; a truly dead key will show as failures in the counters below. Check the real balance at lumalabs.ai.' };
}

async function checkMandrill() {
  const apiKey = process.env.MANDRILL_API_KEY;
  if (!apiKey) return { status: 'not_configured', note: 'MANDRILL_API_KEY is not set — no emails are being sent.' };
  const r = await fetchJson('https://mandrillapp.com/api/1.0/users/info.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: apiKey }),
  });
  if (!r.ok) {
    const msg = (r.data && r.data.message) || `HTTP ${r.status}`;
    return { status: 'error', note: 'Mandrill rejected the key: ' + msg };
  }
  const backlog = r.data.backlog || 0;
  return {
    status: backlog > 100 ? 'warning' : 'ok',
    hourlyQuota: r.data.hourly_quota,
    backlog,
    reputation: r.data.reputation,
    sentThisMonth: r.data.stats && r.data.stats.last_30_days ? r.data.stats.last_30_days.sent : null,
    note: backlog > 100 ? 'Email backlog building up — sends are being throttled.' : '',
  };
}

async function checkBlobStorage() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { status: 'not_configured', note: 'BLOB_READ_WRITE_TOKEN is not set (no Vercel Blob store connected).' };
  let totalBytes = 0;
  let count = 0;
  let cursor;
  // Cap the walk at 20 pages (20k blobs) so a huge store can't blow the function timeout —
  // partial totals are flagged as such.
  for (let page = 0; page < 20; page++) {
    const result = await list({ limit: 1000, cursor });
    (result.blobs || []).forEach((b) => { totalBytes += b.size || 0; count++; });
    if (!result.hasMore || !result.cursor) {
      return { status: 'ok', totalBytes, fileCount: count, partial: false };
    }
    cursor = result.cursor;
  }
  return { status: 'warning', totalBytes, fileCount: count, partial: true, note: 'More than 20,000 files — total shown is a partial sum.' };
}

async function checkNeon() {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) {
    return {
      status: process.env.DATABASE_URL ? 'warning' : 'not_configured',
      note: process.env.DATABASE_URL
        ? 'NEON_API_KEY not set — database storage usage unavailable. Create one at console.neon.tech → Account → API keys and add it to Vercel env.'
        : 'DATABASE_URL is not set at all — the database is down.',
    };
  }
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  const mapProjects = (arr) => (arr || []).map((p) => ({
    name: p.name,
    storageBytes: p.synthetic_storage_size != null ? p.synthetic_storage_size : null,
  }));
  const r = await fetchJson('https://console.neon.tech/api/v2/projects', { headers });
  if (r.ok) return { status: 'ok', projects: mapProjects(r.data.projects) };
  const msg = (r.data && r.data.message) || `HTTP ${r.status}`;
  // Org-scoped API keys (the kind Neon issues for Vercel-managed / organization accounts)
  // reject the bare /projects listing with "org_id is required" — resolve the caller's
  // organizations first, then list projects per org. This exact error hit the owner's
  // Vercel-provisioned Neon setup on first connect.
  if (/org_id/i.test(msg)) {
    const orgs = await fetchJson('https://console.neon.tech/api/v2/users/me/organizations', { headers });
    const orgList = (orgs.ok && orgs.data && orgs.data.organizations) || [];
    if (orgList.length) {
      const projects = [];
      for (const org of orgList) {
        const pr = await fetchJson('https://console.neon.tech/api/v2/projects?org_id=' + encodeURIComponent(org.id), { headers });
        if (pr.ok) mapProjects(pr.data.projects).forEach((p) => projects.push(p));
      }
      if (projects.length) return { status: 'ok', projects };
    }
    return { status: 'error', note: 'Neon key is organization-scoped but no readable projects were found under its organizations. Check the key\'s permissions at console.neon.tech.' };
  }
  return { status: 'error', note: 'Neon API rejected the key: ' + msg };
}

/* ---------- Layer 2: internal counters from ai_usage_log ---------- */

async function internalCounters() {
  if (!sql) return { status: 'not_configured', note: 'DATABASE_URL not set.' };
  await sql`
    CREATE TABLE IF NOT EXISTS ai_usage_log (
      id BIGSERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      ok BOOLEAN NOT NULL,
      http_status INTEGER,
      error_kind TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  const perProvider = await sql`
    SELECT provider,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW())) AS calls_today,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()) AND NOT ok) AS failures_today,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW())) AS calls_month,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()) AND NOT ok) AS failures_month
    FROM ai_usage_log
    GROUP BY provider
    ORDER BY provider;
  `;
  const recentFailures = await sql`
    SELECT provider, endpoint, http_status, error_kind, error_message, created_at
    FROM ai_usage_log
    WHERE NOT ok
    ORDER BY created_at DESC
    LIMIT 10;
  `;
  return { status: 'ok', perProvider: perProvider.rows, recentFailures: recentFailures.rows };
}

/* ---------- Layer 3: manual renewal dates ---------- */

async function ensureRenewalsSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS service_renewals (
      service TEXT PRIMARY KEY,
      renew_at DATE NOT NULL,
      note TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
}

async function listRenewals() {
  if (!sql) return { status: 'not_configured', renewals: [] };
  await ensureRenewalsSchema();
  const result = await sql`SELECT service, renew_at, note FROM service_renewals ORDER BY renew_at ASC;`;
  return { status: 'ok', renewals: result.rows };
}

/* Admin-set monthly limits per provider — the denominator for each row's usage bar. Most
   providers don't expose their own plan limit via API, so the admin states it once ("my
   OpenAI monthly budget is $200", "Blob plan includes 100 GB") and the bar measures live
   usage against that. amount unit depends on the provider (USD, calls, credits, sends, GB)
   and the client knows which is which. */
async function ensureBudgetsSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS service_budgets (
      service TEXT PRIMARY KEY,
      amount NUMERIC NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
}

async function listBudgets() {
  if (!sql) return { status: 'not_configured', budgets: [] };
  await ensureBudgetsSchema();
  const result = await sql`SELECT service, amount FROM service_budgets;`;
  return { status: 'ok', budgets: result.rows };
}

export default async function handler(req, res) {
  const caller = getCaller(req);
  if (!caller || caller.role !== 'admin') {
    res.status(403).json({ error: { message: 'Admin only.' } });
    return;
  }

  if (req.method === 'POST') {
    // Two admin write actions share this method:
    //  - budget upsert/delete: { kind:'budget', service, amount (number | null to delete) }
    //  - renewal upsert/delete: { service, renewAt (YYYY-MM-DD | null), note }
    try {
      if (req.body && req.body.kind === 'budget') {
        const { service, amount } = req.body;
        if (!service || typeof service !== 'string' || service.length > 100) {
          res.status(400).json({ error: { message: 'Body must include a service name.' } });
          return;
        }
        if (!sql) { res.status(500).json({ error: { message: 'DATABASE_URL not set.' } }); return; }
        await ensureBudgetsSchema();
        if (amount == null || amount === '') {
          await sql`DELETE FROM service_budgets WHERE service = ${service};`;
          res.status(200).json({ ok: true, deleted: true });
          return;
        }
        const num = Number(amount);
        if (!isFinite(num) || num <= 0) {
          res.status(400).json({ error: { message: 'amount must be a positive number.' } });
          return;
        }
        await sql`
          INSERT INTO service_budgets (service, amount, updated_at)
          VALUES (${service}, ${num}, NOW())
          ON CONFLICT (service) DO UPDATE SET amount = ${num}, updated_at = NOW();
        `;
        res.status(200).json({ ok: true });
        return;
      }
      const { service, renewAt, note } = req.body || {};
      if (!service || typeof service !== 'string' || service.length > 100) {
        res.status(400).json({ error: { message: 'Body must include a service name.' } });
        return;
      }
      if (!sql) { res.status(500).json({ error: { message: 'DATABASE_URL not set.' } }); return; }
      await ensureRenewalsSchema();
      if (!renewAt) {
        await sql`DELETE FROM service_renewals WHERE service = ${service};`;
        res.status(200).json({ ok: true, deleted: true });
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(renewAt)) {
        res.status(400).json({ error: { message: 'renewAt must be YYYY-MM-DD.' } });
        return;
      }
      await sql`
        INSERT INTO service_renewals (service, renew_at, note, updated_at)
        VALUES (${service}, ${renewAt}, ${note || null}, NOW())
        ON CONFLICT (service) DO UPDATE SET renew_at = ${renewAt}, note = ${note || null}, updated_at = NOW();
      `;
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: { message: err && err.message ? err.message : 'Unexpected server error.' } });
    }
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: { message: 'Method not allowed.' } });
    return;
  }

  // Every check runs in parallel and is individually guarded — a slow or broken provider
  // degrades to an 'error' entry for that one card, never the whole report.
  const guard = (promise) => promise.catch((err) => ({ status: 'error', note: err && err.message ? err.message : 'check failed' }));
  const [openai, gemini, luma, mandrill, blob, neonInfo, internal, renewals, budgets] = await Promise.all([
    guard(checkOpenAi()),
    guard(checkGemini()),
    guard(checkLuma()),
    guard(checkMandrill()),
    guard(checkBlobStorage()),
    guard(checkNeon()),
    guard(internalCounters()),
    guard(listRenewals()),
    guard(listBudgets()),
  ]);

  res.status(200).json({
    generatedAt: new Date().toISOString(),
    services: { openai, gemini, luma, mandrill, blob, neon: neonInfo },
    internal,
    renewals: renewals.renewals || [],
    budgets: budgets.budgets || [],
  });
}
