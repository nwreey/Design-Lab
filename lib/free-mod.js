/* ================= First modification / other option on us =================
   OWNER RULE: the FIRST modification or other-option on each design (project) is free —
   it must not consume the user's modify/edit quota. Applies to all three sections
   (Exhibition, Event, Display Stand).

   The client sends { isFreeFirstModification: true, projectId } when it believes the
   project's free credit is unspent; this module is the server-side source of truth:
   one row per (user, project) in free_first_mods, consumed atomically with INSERT ...
   ON CONFLICT DO NOTHING, so a raced or replayed request can never yield two free uses
   for the same project. A spoofed projectId only ever grants what the feature already
   promises — one free modification per project.

   CommonJS on purpose — same mixed ESM/CJS interop reasoning as lib/usage-log.js. */

async function tryConsumeFreeFirstModification(sql, userId, projectId) {
  if (!userId || !projectId) return false;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS free_first_mods (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, project_id)
      );
    `;
    const result = await sql`
      INSERT INTO free_first_mods (user_id, project_id)
      VALUES (${String(userId)}, ${String(projectId).slice(0, 200)})
      ON CONFLICT (user_id, project_id) DO NOTHING
      RETURNING user_id;
    `;
    return result.rows.length > 0;
  } catch (err) {
    // Fail toward charging normally — a DB hiccup must not turn into unlimited free usage.
    console.error('free-mod: could not consume free first modification:', err && err.message);
    return false;
  }
}

module.exports = { tryConsumeFreeFirstModification };
