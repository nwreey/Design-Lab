/* ================= AI / paid-service usage logging =================
   One shared, fire-safe logger used by every serverless function that calls a PAID
   external provider (OpenAI, Gemini, Luma, Mandrill). Each call writes one small row
   into ai_usage_log; the admin Service Usage & Billing panel (api/admin-service-usage.js)
   aggregates these into per-provider daily/monthly counts and an early-warning feed —
   the whole point is that an expiring key or exhausted quota shows up in the panel the
   moment the FIRST call fails, instead of being discovered when the site breaks.

   logAiCall never throws and is intentionally not awaited by callers on the hot path —
   a logging hiccup must never break or slow a generation. Table creation is lazy and
   idempotent (CREATE TABLE IF NOT EXISTS on every write is a cheap no-op in Postgres).

   Deliberately CommonJS (module.exports): the api/ folder mixes ESM-style and CJS-style
   functions, and ESM files can import a CJS module (esbuild interop) while a CJS file
   can NOT require an ESM one — so CJS here is the only style both kinds can share. */

const { neon } = require('@neondatabase/serverless');

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL, { fullResults: true }) : null;

/* Classifies a provider failure into the buckets the admin panel colors by:
   - 'auth'    → key invalid / expired / revoked (red: fix immediately)
   - 'billing' → payment required / credits exhausted (red: top up)
   - 'quota'   → rate/quota limit hit (yellow: may self-recover)
   - 'other'   → everything else (yellow) */
function classifyFailure(status, message) {
  const msg = String(message || '').toLowerCase();
  if (status === 401 || status === 403 || msg.includes('api key') || msg.includes('invalid key') || msg.includes('unauthorized') || msg.includes('permission')) return 'auth';
  if (status === 402 || msg.includes('billing') || msg.includes('payment') || msg.includes('insufficient credit') || msg.includes('exceeded your current quota') || msg.includes('balance')) return 'billing';
  if (status === 429 || msg.includes('rate limit') || msg.includes('quota') || msg.includes('resource_exhausted') || msg.includes('resource exhausted')) return 'quota';
  return 'other';
}

async function ensureUsageLogSchema() {
  if (!sql) return;
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
  await sql`CREATE INDEX IF NOT EXISTS ai_usage_log_provider_created_idx ON ai_usage_log (provider, created_at);`;
}

/* provider: 'openai' | 'gemini' | 'luma' | 'mandrill'
   endpoint: short label of which feature made the call (e.g. 'generate-image-gemini')
   ok: whether the provider call succeeded
   status: HTTP status from the provider (if any)
   message: provider error message on failure (truncated; never logged on success) */
function logAiCall({ provider, endpoint, ok, status, message }) {
  if (!sql) return Promise.resolve();
  const errorKind = ok ? null : classifyFailure(status, message);
  const errorMessage = ok ? null : String(message || '').slice(0, 500);
  return ensureUsageLogSchema()
    .then(() => sql`
      INSERT INTO ai_usage_log (provider, endpoint, ok, http_status, error_kind, error_message)
      VALUES (${provider}, ${endpoint}, ${ok}, ${status || null}, ${errorKind}, ${errorMessage});
    `)
    .catch((err) => { console.error('usage-log write failed (non-fatal):', err && err.message); });
}

module.exports = { logAiCall, classifyFailure, ensureUsageLogSchema };
