# Spatial Planning Engine Redesign — Architecture Proposal

Status: **proposal only — no code has been changed.** This document is for review. Implementation does not begin until you approve the direction (and each phase below can be approved/rejected independently).

## 1. Why the current engine is wrong

Today's flow is bottom-up: pick a booth size, immediately generate furniture footprints from a fixed constant table, run everything through a reduction/merge loop when it doesn't fit, then drop the survivors onto a 3×3 grid. Size is decided before space is understood. Position is decided before relationships are understood. Nothing in the current pipeline knows *why* a zone is where it is or *why* it's the size it is — it just knows a constant.

The redesign inverts this into the order a human exhibition architect actually works in: understand the client and the story first, define spaces before objects, define relationships before coordinates, and only pick furniture once a zone's role and size envelope are already settled.

## 2. The new pipeline

```
Client Brief
   │
   ▼
DIE-001  Design Intent Engine
   │
   ▼
FPE-001  Functional Program Engine        (Stage 1 — spaces, not furniture)
   │
   ▼
ADJ-001  Adjacency & Relationship Engine  (Stage 2 — relative positioning rules)
   │
   ▼
VJE-001  Visitor Journey Engine           (Stage 3 — the sequence a visitor moves through)
   │
   ▼
ZAE-001  Zone Allocation Engine           (Stage 4 — % of floor per zone, conflict-checked)
   │
   ▼
HSE-001  Hero Strategy Engine             (Stage 8 — architectural concept, not a %)
   │
   ▼
FUR-001  Furniture Selection Engine       (Stages 5–7 — type first, dimension second)
   │
   ▼
LSE-001  Layout Solver Engine             (Stage 9 — coordinates, always last)
   │
   ▼
BSE-001  Structural Shell Engine          (walls, ceiling systems — kept, now concept-aware)
   │
   ▼
GPE-001  Gemini Prompt Engine             (final assembly + governance rules)
   │
   ▼
Gemini Rendering (visual only)
```

Every arrow is a hard boundary: a later engine may only *read* an earlier engine's output, never override it. If a later engine hits something it can't satisfy (not enough room, a contradiction), it doesn't silently fix it — it raises a conflict and the existing approval screen (✅ Accept / ✏️ Modify / ❌ Keep original) is reused, just re-targeted at whichever stage produced the conflict instead of only at furniture sizing.

## 3. Engine-by-engine spec

### DIE-001 — Design Intent Engine
**Input:** the client brief fields (industry, booth type, goals, priorities, budget signals, brand personality, open sides, booth size/height).
**Output:** a structured `designIntent` object — not prose. This is new: today "industry" and "priorities" exist as form fields but nothing downstream actually reads them as *weights*. DIE-001 turns them into numbers every later engine consults.
**Responsibility:** interpret the brief. Never decide a zone size or position itself.

### FPE-001 — Functional Program Engine (Stage 1)
**Input:** `designIntent` + the checked Requirements.
**Output:** a flat list of *zones* — name, category, priority tier, required/optional, which client requirement it came from. **No dimensions, no mm, no sqm.** This directly replaces the current habit of generating a footprint the moment a checkbox is read.

### ADJ-001 — Adjacency & Relationship Engine (Stage 2)
**Input:** the zone list from FPE-001.
**Output:** a relationship graph — `{ zoneId, relation, target?, weight }` — e.g. Reception→near-entrance, Meeting→near-rear-wall, Storage→behind:Meeting, Display→facing-open-side, Hero→primary-sightline. These are rules, not coordinates. This is the piece that doesn't exist at all today (the current 3×3 grid has hard-coded region preferences per tier, but no actual relationship reasoning between named zones).

### VJE-001 — Visitor Journey Engine (Stage 3)
**Input:** zone list + relationship graph + entry side(s)/open sides.
**Output:** an ordered visitor sequence (Enter → Sees Hero → Reception → Display → Meeting → Exit). This sequence becomes a *scoring input* for the Layout Solver later (Stage 9) — sightline and circulation scoring both check against it.

### ZAE-001 — Zone Allocation Engine (Stage 4)
**Input:** zone list + `designIntent` (booth size, booth type, industry, priority weights).
**Output:** percent-of-floor and derived sqm per zone, plus circulation reserve %. This is where today's fixed constants (13% hero, 45/40/35/30% circulation by size bracket, `RATIO_CAP_BY_TIER`) get demoted from *the answer* to *the default prior* — they remain in the code as sensible starting weights, but `designIntent.priorityWeights` (industry, client priorities, budget tier) can now shift them per project instead of every project of the same booth size getting an identical split.
**Conflict handling:** this is where the existing `detectSpatialConflicts` / `applySpatialResolutions` / conflict-approval screen moves to. Today it fires against raw footprint sqm from furniture; in the new pipeline it fires against zone-% budgets, one level more abstract and closer to how a client actually experiences "your meeting room doesn't fit" — as a space problem, not a furniture problem.

### HSE-001 — Hero Strategy Engine (Stage 8)
**Input:** brand importance, booth visibility, open-side count, budget tier, industry, architectural style preference (all from `designIntent`).
**Output:** one archetype from a fixed vocabulary — Portal / Tower / Floating Frame / Feature Wall / Sculptural Element / LED Gateway — plus a rationale string and a footprint/height that *falls out of* the chosen archetype's own rules in the Architectural Library, not a flat 13%-of-area formula.
**Responsibility:** this fully deletes `getHeroStructureScaleTier`/`getHeroHeightMm` as they exist today. Kept as a rule-based deterministic engine (see §6 for why), not an AI call — auditable, no latency/cost, always reproducible.

### FUR-001 — Furniture Selection Engine (Stages 5–7)
**Input:** each zone's category, allocated sqm, and (for product-display zones) product category.
**Output:** furniture type + variant + a dimension chosen from a *range*, not a single hard-coded figure. E.g. Meeting Zone, capacity 4 → Round Table 1200mm *or* Rectangular 1600×800 — FUR-001 picks based on the zone's shape/aspect ratio once ZAE-001 has already fixed its area. Product-display zones run through a strategy lookup first (Medical→Cabinet, Food→Counter, Machinery→Platform, Jewelry→Glass Showcase, Electronics→Interactive Table) before a dimension is ever touched.
**Responsibility:** never invent a zone, never resize a zone's total area — it fills an area ZAE-001 already committed to.

### LSE-001 — Layout Solver Engine (Stage 9)
**Input:** zones (with area from ZAE-001, furniture from FUR-001), relationship graph (ADJ-001), visitor journey (VJE-001), open sides, structural walls.
**Output:** final `{x, y, w, d, rotation}` per zone. Coordinates are the *last* thing computed, never the first. Full solver design in §5.

### BSE-001 — Structural Shell Engine (kept, extended)
Unchanged in its core wall-thickness/height math, but now also reads HSE-001's archetype to pick a matching ceiling/wall system from the new Architectural Library (a Portal hero implies different structural framing than a Feature Wall hero) instead of being architecture-agnostic.

### GPE-001 — Gemini Prompt Engine (new, formalizes what's scattered today)
Assembles every stage's output into the final structured brief + the governance rules (extends the existing EPS-021 block), then hands off to the existing Stage-1/Stage-2 OpenAI writers or Direct-to-Gemini path, unchanged.

## 4. The DesignState object

Today the pipeline passes around a handful of loose variables (`spatialPlan`, `spatialPlanText`, `structuralShellText`) that get restringified at each step. The redesign threads one growing object through every engine — this *is* the "debug JSON per stage" capability from the earlier conflict-approval work, just formalized as the actual internal data model rather than an export-only artifact:

```js
DesignState = {
  designIntent: {
    boothType, industry, brandImportance,      // 1-5 or low/med/high
    budgetTier,                                 // economy/standard/premium/flagship
    priorityWeights: {                          // 0-1, sum not required to be 1
      reception, meeting, display, hospitality, brandExperience, storage
    },
    architecturalStylePreference,                // optional, from brief or client pick
    openSides: [...],                            // e.g. ['front','left']
    totalAreaSqm, boothWidthM, boothDepthM, boothHeightM
  },

  functionalProgram: {
    zones: [
      { id, name, category, priorityTier, required, sourceRequirement }
      // NO dims, NO sqm, NO mm — intentionally absent at this stage
    ]
  },

  spatialRelationships: {
    adjacencies: [
      { zoneId, relation: 'near-entrance'|'near-rear-wall'|'behind'|'facing-open-side'|'primary-sightline',
        targetZoneId, weight }
    ]
  },

  visitorJourney: {
    entryPoints: [...], sequence: [zoneId, zoneId, ...], exitPoints: [...]
  },

  zoneAllocation: {
    totalAllocatableSqm, circulationReserveSqm, circulationReservePercent,
    zones: [
      { zoneId, percentOfTotal, areaSqm, basis: 'intent-weighted'|'default-table',
        conflictStatus: 'none'|'level1'|'level2'|'level3', resolutionNote }
    ]
  },

  heroStrategy: {
    archetype, rationale, footprintSqm, heightMm,
    materialsRef, source: 'HSE-001 rule-based (deterministic)'
  },

  furnitureSelection: {
    // keyed by zoneId
    'zone-meeting-1': [
      { furnitureType: 'meetingTable', libraryRef: 'FURNITURE_LIBRARY.meetingTable.round',
        dims: { widthMm: 1200 }, capacity: 4 }
    ]
  },

  layoutPlan: {
    zones: { 'zone-meeting-1': { x, y, w, d, rotation, region } },
    walkwaysMm: [...],
    sightlineChecks: [ { fromZoneId, toZoneId, clear: true } ]
  },

  structuralShell: { /* unchanged shape */ },

  geminiPrompt: { text, governanceRules }
}
```

Every stage writes one key and reads only the keys already written above it. That single rule is what makes "never invent architecture in the planning engine" and "never invent furniture in the architecture engine" enforceable in practice, not just in a comment.

## 5. Layout Solver design (Stage 9 detail)

The current `assignZonePositions` is a hard-coded 3×3 grid with tier-based region preference — no overlap detection beyond "don't reuse a cell," no sightline awareness, no real circulation-width check. The proposal:

**Recommended approach — greedy scored placement** (not a full constraint-satisfaction/optimization solver — appropriate for a client-side single-file app with no build step or heavy compute budget):

1. Order zones by priority tier (Hero → Brand Experience → Primary Products → Reception → Meeting → Hospitality → Storage → Decorative — same ordering already used elsewhere).
2. For each zone in order, generate candidate positions on a finer scan grid (e.g. 250mm steps, up from the current fixed 3×3) within the footprint minus circulation reserve minus already-placed zones.
3. Score every valid (non-overlapping) candidate by weighted sum of: adjacency fit against ADJ-001's relations (e.g. Storage actually adjacent to Meeting scores higher), open-side facing bonus, wall-adjacency bonus for tiers that prefer it, sightline score against VJE-001's sequence (is Hero visible from the entry point; is the current zone visible from wherever the journey says it should be seen), and a hard walking-width check pulled from the new Human Factors Library.
4. Place at the highest-scoring valid candidate. If no valid candidate exists for a zone, don't silently overlap or shrink it — raise a **placement conflict** and route it through the existing approval screen (this becomes a new conflict source alongside the existing area conflicts).

This keeps the solver deterministic, debuggable, and fast, while actually reasoning about relationships and sightlines instead of a fixed region table. If in practice greedy placement produces too many conflicts, a true backtracking/simulated-annealing solver is a valid future upgrade — flagged here as an explicit escalation path, not built now.

## 6. The five libraries

Splitting `EXHIBITION_STANDARDS_LIBRARY` as requested. Given the app is a single HTML file with no build step, the recommended approach is five separate top-level `const` objects in the same file (not five separate `.js` files requiring external hosting/CORS handling) — same pattern as today, just decomposed instead of one monolith. Can be externalized later if you ever move to a build pipeline.

- **`HUMAN_FACTORS_LIBRARY`** — walking width, wheelchair clearance, standing space, viewing distance, reach distance, door clearance. Consumed by the Layout Solver's hard constraints and by FUR-001 when sizing circulation-adjacent furniture.
- **`FURNITURE_LIBRARY`** — every furniture family as a *range*, not a point value, e.g.:
  ```js
  receptionCounter: {
    variants: [
      { size: 'small',  widthRangeMm: [1200,1600], depthMm: 400, heightMm: 1050 },
      { size: 'medium', widthRangeMm: [1800,2400], depthMm: 400, heightMm: 1050 },
      { size: 'large',  widthRangeMm: [2500,3500], depthMm: 450, heightMm: 1100 }
    ],
    shapes: ['straight','curved','island','corner']
  }
  ```
- **`PRODUCT_DISPLAY_LIBRARY`** — product category → display strategy → furniture type (Medical→Cabinet, Food→Counter, Machinery→Platform, Jewelry→Glass Showcase, Electronics→Interactive Table), each with its own dimension ranges.
- **`ARCHITECTURAL_LIBRARY`** — portal styles, ceiling systems, materials, facade patterns, lighting concepts, structural forms. Consumed by HSE-001 (archetype selection) and BSE-001 (matching wall/ceiling system).
- **`EXHIBITION_RULES_LIBRARY`** — venue regulations: max heights, rigging rules, double-deck eligibility, fire exit clearances, open-side rules, structural rules (this absorbs today's scattered `STRUCTURAL_WALL_THICKNESS_MM` and the EPS-XXX prose rules currently only living in comments/prompt text).

`ADDREQ_ZONE_META`'s ~50 generic zones get split across `FUNCTIONAL_PROGRAM` (which zone exists) and `PRODUCT_DISPLAY_LIBRARY`/`FURNITURE_LIBRARY` (what furniture fills it) — the flat `{tier, areaSqm}` guess is replaced by a category + strategy lookup, with the actual sqm now coming from ZAE-001's intent-weighted allocation instead of a hard-coded number.

## 7. AI responsibility boundaries (Stage 11)

Three engines, three contracts — this extends the EPS-021 rule block already added to the prompt, now enforced structurally by the DesignState append-only rule (§4), not just by prompt instruction:

| Engine | Allowed | Forbidden |
|---|---|---|
| **Planning Engine** (DIE→LSE, all deterministic JS, zero AI calls) | Decide what zones exist, their size, their relationships, their coordinates | Invent architecture (hero form), invent furniture styling |
| **Architectural Engine** (HSE-001 + BSE-001, deterministic rule-based — see below) | Pick hero archetype and structural system *from the fixed library vocabulary* | Invent furniture, resize/move zones, invent a new archetype not in the library |
| **Rendering Engine** (Gemini) | Visualize exactly what DesignState specifies | Reposition, resize, remove, or add any zone/furniture/hero element |

On whether the Architectural Engine should be AI-assisted: recommended default is **fully deterministic/rule-based** (a scoring table over `designIntent` inputs → archetype), same reasoning as Hero Strategy in §3 — auditable, reproducible, free, and it satisfies "never invent architecture" literally since it can only pick from a closed list. OpenAI can still *optionally* feed `architecturalStylePreference` into DIE-001 by interpreting free-text brief language ("modern, minimal" etc.), but the actual archetype decision stays inside HSE-001's deterministic table. This is a design choice you may want to weigh in on before implementation — see open decisions below.

## 8. Debug artifacts (extends the earlier Debug Mode idea)

One JSON per stage, matching DesignState's keys exactly, so a broken run can be diagnosed stage-by-stage:
`design_intent.json`, `functional_program.json`, `spatial_relationships.json`, `visitor_journey.json`, `zone_allocation.json`, `hero_strategy.json`, `furniture_selection.json`, `layout_plan.json`, `structural_shell.json`, `gemini_prompt.txt`.

## 9. Migration plan

Existing code doesn't get thrown away — most of it becomes the *deterministic default* inside a new engine, re-scoped to run later/higher-level than it does today.

| Today | Becomes |
|---|---|
| `EXHIBITION_STANDARDS_LIBRARY` | Split across `HUMAN_FACTORS_LIBRARY`, `FURNITURE_LIBRARY`, `EXHIBITION_RULES_LIBRARY` |
| `ADDREQ_ZONE_META` | Split across `FPE-001` zone catalog + `PRODUCT_DISPLAY_LIBRARY`/`FURNITURE_LIBRARY` |
| `getHeroStructureScaleTier` / `getHeroHeightMm` | Deleted, replaced entirely by `HSE-001` + `ARCHITECTURAL_LIBRARY` |
| `getCirculationReservePercent` | Becomes `ZAE-001`'s default prior, now adjustable by `designIntent.priorityWeights` |
| `getBoothSizeClass` | Kept as-is, feeds `DIE-001` |
| `computeKnownAddreqFootprints` | Split: "which item, how many" → `FPE-001`; mm dimensions → `FUR-001` reading `FURNITURE_LIBRARY` ranges |
| `computeOtherRequestedZoneNames` | Folds into `FPE-001`'s zone catalog build |
| `RATIO_CAP_BY_TIER` | Becomes a `ZAE-001` constraint input, reframed as max % per priority tier |
| `buildLayoutRegions` / `assignZonePositions` | Replaced by `LSE-001` (§5) |
| `detectSpatialConflicts` / `applySpatialResolutions` / `computeSpatialPlan` + the conflict-approval screen | Kept, re-targeted to fire at `ZAE-001` (area conflicts) and `LSE-001` (placement conflicts) instead of only at furniture sizing |
| `buildStructuralShell` | Kept, extended to read `HSE-001`'s archetype for matching wall/ceiling systems |
| EPS-021 governance block | Extended into `GPE-001`, now referencing the full DesignState instead of a single spatial-plan string |

**Phased rollout** (each phase independently testable/approvable, current sizing formulas untouched until explicitly noted):

1. **Data structures + libraries** — split the constants into the five libraries and stand up the `DesignState` object shape, with every stage initially just a thin pass-through wrapper around today's existing logic (no behavior change yet, purely a refactor to the new shape). Verifies nothing regresses before any real logic changes.
2. **Functional Program + Zone Allocation** — introduce `DIE-001`/`FPE-001`/`ZAE-001`; zone existence and % budgets now separate from furniture. Old fixed footprint tables temporarily get wired in as `FUR-001`'s only source (Stage 6/7 libraries not built yet). This is the first phase where `designIntent.priorityWeights` can actually shift outcomes.
3. **Relationships + Visitor Journey** — introduce `ADJ-001`/`VJE-001`; still rendered through the old 3×3 grid for now (positions not upgraded yet), but the relationship graph exists and is logged for verification.
4. **Hero Strategy + Architectural Library** — introduce `HSE-001`, delete the 13% formula. First phase with a real, user-visible behavior change to hero sizing.
5. **Furniture Selection + Furniture/Product Display Libraries** — introduce `FUR-001`, replace fixed footprint constants with range-based selection. First phase where individual furniture dimensions actually change from today's numbers.
6. **Layout Solver** — introduce `LSE-001`, retire `assignZonePositions`. Full cutover to relationship/sightline-aware placement.
7. **Cleanup** — remove now-dead old functions, extend the conflict-approval screen to cover the new conflict sources, finalize `GPE-001` and the per-stage debug JSON exports.

## 10. Open decisions for your review

- **Architectural Engine (Hero Strategy) — deterministic rule table vs. AI-assisted.** Recommended: deterministic (§7). If you'd rather let OpenAI recommend the archetype directly from the brief, that's a different (simpler to build, less auditable) design — worth confirming before Phase 4.
- **Layout Solver complexity — greedy scored placement vs. a true constraint solver.** Recommended: greedy (§5), with escalation to a real solver only if conflict rates in practice justify it.
- **Priority weights source.** `designIntent.priorityWeights` needs to come from *somewhere* — either new client-facing form fields (a "what matters most" priority picker) or inferred from existing fields (industry + goal text) via the Stage-1 OpenAI analysis. Worth deciding whether this needs new UI before Phase 2.

Let me know which phases to proceed with, and whether the three decisions above should go with the recommended defaults or a different direction — then I'll start on Phase 1.
