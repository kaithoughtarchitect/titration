// Titration MCP — the baseline store (insert-only).
//
// A baseline is a FROZEN measuring stick: graded baseline rates +
// the frozen rubric hash + per-mode rates + effective-N. `verify` loads it and
// diffs a candidate against it under the SAME rubric. Insert-only by contract —
// there is deliberately NO update path here; a re-grade is a new row, never a
// mutation (capture/grade separation). This is why baselines live in their own
// table and not in the card store's `runs`, whose `runCapture` upsert is mutable.
//
// Reuses the ONE postgres pool + tenant lookup + writable guard from store.ts.

import { sql, tenantId, tenantIdForWrite, assertWritable } from "./store";
import { DEFAULT_PANEL, parseJudgePanelTrace, snapshotPanel, type JudgePanelTrace } from "./judge";
// TYPE-ONLY: verify.ts imports VALUES from this module (insertBaseline/loadBaseline), so a value
// import back would close a runtime cycle. `import type` is erased at compile time.
import type { RowGrade } from "./verify";
import { shouldBindPerRowColumn } from "./baseline-retention-core";

export interface ModeRate { rate: number; n: number }

export interface NewBaseline {
  goal: string;
  system_ref?: string | null;
  corpus_ref?: string | null;
  rubric_text: string;
  rubric_hash: string;
  baseline_rate: number; // aggregate failure (bug-present) rate
  effective_n: number; // scorable rows (consensus reached)
  agreement: number; // mean inter-judge agreement → noise floor = 1 - agreement
  per_mode: Record<string, ModeRate>;
  per_judge: Record<string, ModeRate>; // B5b (006): per-judge baseline rates → verify calibrates direction-split/rate-dissent per judge (gotcha #14)
  judge_panel?: JudgePanelTrace;
  reproduced: boolean; // always true for a stored baseline (establish refuses otherwise)
  /**
   * Opt-in per-row grade retention (db/040). `null`/omitted = not retained, and the INSERT then
   * uses the pre-040 column list VERBATIM — so an unmigrated database is unaffected on the
   * default path, and existing callers' write behavior is byte-identical.
   */
  per_row?: RowGrade[] | null;
}

/**
 * Bounded raw companion for a stored judge_panel that fails its parse
 * (per_row_unparsed pattern): the READ never fails, the malformed value stays
 * diagnosable, and the grading chokepoints refuse explicitly on
 * `judge_panel === null` — an unreadable stored panel is never substituted.
 */
export interface UnreadableJudgePanel {
  error: string;
  raw: string; // JSON of the stored value, truncated to 2KB
}

export interface LoadedJudgePanel {
  panel: JudgePanelTrace | null;
  unreadable?: UnreadableJudgePanel;
}

export interface BaselineRow extends Omit<NewBaseline, "judge_panel" | "per_row"> {
  id: string;
  tenant: string;
  /** `null` = stored panel failed its parse — see judge_panel_unreadable; grading must refuse. */
  judge_panel: JudgePanelTrace | null;
  judge_panel_unreadable?: UnreadableJudgePanel;
  created_at: string;
  // NO per_row. The verdict paths do not fetch it, so the type does not offer it — reading
  // `row.per_row` off a plain load is a COMPILE ERROR rather than a `null` a caller has to know how
  // to interpret. That ambiguity was the whole defect: a "not loaded" null and a "not retained" null
  // are different facts, and no comment can stop a future caller writing `per_row ?? []` on the
  // wrong one and reporting "nothing retained" for a fully-retained baseline.
}

/**
 * The detail shape. The two members together make all three real states distinguishable BY THE
 * CALLER, which is what the constitution's jsonb-READ rule is for:
 *   per_row: [...]  · per_row_unparsed: null   -> retained and healthy
 *   per_row: null   · per_row_unparsed: null   -> never retained
 *   per_row: null   · per_row_unparsed: "..."  -> retained but CORRUPT; here is the raw value
 * A partially-corrupt blob yields both: the usable grades AND the entries that were dropped.
 */
export interface BaselineDetailRow extends BaselineRow {
  per_row: RowGrade[] | null;
  /** The raw stored value, present only when it could not be read as RowGrade[]. Bounded echo. */
  per_row_unparsed: string | null;
}

// Defensive jsonb READ (constitution DB trap): postgres-js returns jsonb parsed, but a legacy or
// double-encoded row can arrive as a string. NEVER throws — a bare JSON.parse in a read path would
// 500 the whole baseline detail surface, which is the failure the rule exists to prevent.
//
// The rule says "fail open to the RAW STRING" so the CALLER can inspect or recover it. That is
// honoured here without polluting the typed array: the parsed grades stay `RowGrade[] | null`, and
// the raw value comes back beside them in `per_row_unparsed`. An earlier version collapsed both to
// `null`, which made "retained but corrupt" indistinguishable from "never retained" at the API —
// a server log does not satisfy the rule, because an API consumer has no database access.
function isRowGrade(value: unknown): value is RowGrade {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<RowGrade>;
  return typeof row.id === "string"
    && typeof row.mode === "string"
    && (row.verdict === null || typeof row.verdict === "string")
    && typeof row.inconclusive === "boolean"
    && typeof row.agreement === "number"
    && Boolean(row.byJudge) && typeof row.byJudge === "object"
    && Array.isArray(row.panelFailed);
}

/** Bounded so a pathological blob cannot be echoed unbounded through an API response. */
const PER_ROW_RAW_ECHO_MAX = 4_000;

function rawEcho(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > PER_ROW_RAW_ECHO_MAX
    ? `${text.slice(0, PER_ROW_RAW_ECHO_MAX)}…[truncated ${text.length - PER_ROW_RAW_ECHO_MAX} chars]`
    : text;
}

export interface ParsedPerRow {
  /** The grades that actually have the RowGrade shape. `null` = nothing usable. */
  rows: RowGrade[] | null;
  /**
   * The RAW stored value, present ONLY when it could not be read as RowGrade[]. This is what makes
   * "retained but corrupt" distinguishable from "never retained" AT THE API — the constitution's
   * jsonb-READ rule exists so the CALLER can inspect or recover the value, and an API consumer has
   * no database access, so a server log alone does not satisfy it.
   */
  unparsed: string | null;
}

function parsePerRow(value: unknown, baselineId: string): ParsedPerRow {
  if (value == null) return { rows: null, unparsed: null };
  let candidate: unknown = value;
  if (typeof value === "string") {
    // A legacy or double-encoded row arrives as a jsonb scalar string. Recover it rather than
    // discard it — but NEVER let a bare JSON.parse escape, or one bad row 500s the whole surface.
    try {
      candidate = JSON.parse(value);
    } catch (error) {
      console.error(
        "[baseline] per_row is an unparseable string — returning it raw for recovery",
        { baselineId, error: error instanceof Error ? error.message : String(error) },
      );
      return { rows: null, unparsed: rawEcho(value) };
    }
  }
  if (!Array.isArray(candidate)) {
    console.error(
      "[baseline] per_row is not an array — returning it raw for recovery",
      { baselineId, type: typeof candidate },
    );
    return { rows: null, unparsed: rawEcho(candidate) };
  }
  // Array.isArray only proves array-ness. Casting straight to RowGrade[] would publish an
  // element-level guarantee nothing checked — and BaselineRow is re-exported to client code, so a
  // hand-edited or legacy row would hand the UI a compile-time promise about `byJudge` that the
  // jsonb never earned. Filter to rows that actually have the shape, and hand back whatever was
  // dropped rather than deleting the evidence.
  const rows = candidate.filter(isRowGrade);
  const dropped = candidate.length - rows.length;
  if (dropped > 0) {
    console.error(
      "[baseline] per_row contained entries that are not RowGrade — returning them raw for recovery",
      { baselineId, kept: rows.length, dropped },
    );
    return {
      rows: rows.length > 0 ? rows : null,
      unparsed: rawEcho(candidate.filter((entry) => !isRowGrade(entry))),
    };
  }
  return { rows: rows.length > 0 ? rows : null, unparsed: null };
}

// Local/source databases can lag repo tip: db/040 added `per_row` on baselines, and the production
// apply is separately gated by the user. READS must still load. WRITES stay LOUD — the
// retain-INSERT does NOT catch this; a caller who asked for retention against an unmigrated DB gets
// a real error rather than a silent no-op.
// Cache the probe so a lagged process pays one failed SELECT, then degrades.
let baselinePerRowColumn: boolean | null = null;
let baselinePerRowProbedAt = 0;
// A migration can be applied to a LIVE database mid-process (prod schema apply is gated by the user
// and separate from the deploy), and nothing in the tree requires a restart afterwards. A permanently
// latched `false` would therefore keep reporting "no rows retained" for the life of the process even
// after db/040 landed — a success-shaped 200 making a FALSE claim about paid evidence. Re-probe.
const PER_ROW_REPROBE_MS = 60_000;

function isUndefinedColumn(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "42703",
  );
}

// SQLSTATE alone is not enough: the withRows SELECT names 15 columns, so ANY missing one raises
// 42703 and would be misreported as "db/040 lags" — sending the next on-call reader after the wrong
// migration and latching retention off for an unrelated fault. Postgres puts the column name in the
// message, so confirm it really is per_row before claiming so.
function isMissingPerRowColumn(error: unknown): boolean {
  return isUndefinedColumn(error)
    && /per_row/.test(String((error as { message?: unknown })?.message ?? ""));
}

/**
 * Is the db/040 `per_row` column present? Cached with a TTL so a mid-process migration is picked up.
 * Used by BOTH the detail read (to degrade) and `establishBaseline` (to refuse BEFORE paying judges).
 */
export async function hasPerRowColumn(): Promise<boolean> {
  const now = Date.now();
  if (baselinePerRowColumn !== null && now - baselinePerRowProbedAt < PER_ROW_REPROBE_MS) {
    return baselinePerRowColumn;
  }
  const found = await sql`
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'baselines' and column_name = 'per_row'
    limit 1`;
  baselinePerRowColumn = found.length > 0;
  baselinePerRowProbedAt = now;
  return baselinePerRowColumn;
}

// Insert a frozen baseline; returns its id. Tenant-scoped + writable-guarded
// (`__base__` is rejected — a baseline is per-tenant verdict-engine state).
export async function insertBaseline(tenant: string, b: NewBaseline): Promise<{ baseline_id: string }> {
  assertWritable(tenant);
  const tid = await tenantIdForWrite(tenant);
  const panelJson = sql.json((b.judge_panel ?? reconstructedPanel(Object.keys(b.per_judge))) as any);
  // TWO ARMS. The default arm is the pre-040 statement — same column list, same order, same bound
  // values (the judge_panel expression is hoisted to `panelJson`, and indentation differs, so it is
  // semantically identical rather than textually so). It is what keeps
  // establish_baseline working against a database where db/040 has not been applied yet, and what
  // makes "existing callers' write behavior is identical" literally true at the SQL level.
  // The retain arm is the same statement plus one column, and it stays LOUD: no 42703 catch here,
  // because per_row is part of the PRIMARY insert and a failed write must fail the insert.
  const rows = !shouldBindPerRowColumn(b.per_row)
    ? await sql`
        insert into baselines
          (tenant_id, goal, system_ref, corpus_ref, rubric_text, rubric_hash,
           baseline_rate, effective_n, agreement, per_mode, per_judge, judge_panel, reproduced)
        values
          (${tid}, ${b.goal}, ${b.system_ref ?? null}, ${b.corpus_ref ?? null},
           ${b.rubric_text}, ${b.rubric_hash}, ${b.baseline_rate}, ${b.effective_n},
           ${b.agreement}, ${sql.json(b.per_mode as any)}, ${sql.json(b.per_judge as any)},
           ${panelJson}, ${b.reproduced})
        returning id`
    : await sql`
        insert into baselines
          (tenant_id, goal, system_ref, corpus_ref, rubric_text, rubric_hash,
           baseline_rate, effective_n, agreement, per_mode, per_judge, judge_panel, reproduced, per_row)
        values
          (${tid}, ${b.goal}, ${b.system_ref ?? null}, ${b.corpus_ref ?? null},
           ${b.rubric_text}, ${b.rubric_hash}, ${b.baseline_rate}, ${b.effective_n},
           ${b.agreement}, ${sql.json(b.per_mode as any)}, ${sql.json(b.per_judge as any)},
           ${panelJson}, ${b.reproduced}, ${sql.json(b.per_row as any)})
        returning id`;
  const [row] = rows;
  // ^ per_mode + per_judge are plain JSON by construction; cast through `any` only to
  // satisfy postgres-js's awkward JSONValue union (it folds index-signature objects
  // into its Date branch). sql.json single-encodes — do NOT JSON.stringify + ::jsonb
  // (that double-encodes into a jsonb scalar string; gotcha #3a, verified 2026-06-16).
  return { baseline_id: row.id };
}

// Load a frozen baseline by id, scoped to its tenant (isolation). Throws if it
// does not exist in that tenant — `verify` surfaces that as a clear error rather
// than grading a candidate against nothing.
export async function loadBaseline(tenant: string, baselineId: string): Promise<BaselineRow> {
  return loadBaselineWith(tenant, baselineId, false);
}

/**
 * The ONLY read that fetches per_row (db/040). Used by GET /api/baselines/:id and nothing else, so
 * the paid verdict paths carry no read amplification.
 */
export async function loadBaselineDetail(
  tenant: string,
  baselineId: string,
): Promise<BaselineDetailRow> {
  return await loadBaselineWith(tenant, baselineId, true) as BaselineDetailRow;
}

async function loadBaselineWith(
  tenant: string,
  baselineId: string,
  withRowsRequested: boolean,
): Promise<BaselineRow> {
  const tid = await tenantId(tenant);
  // DEFAULT arm: column list textually unchanged from pre-040. Every verdict-path consumer
  // (verify, goal-titrate start, the MCP advisory pre-read, the durable postSuccess capture) takes
  // this arm and never fetches per_row — no read amplification on the paid paths.
  const withoutRows = () => sql`
    select id, goal, system_ref, corpus_ref, rubric_text, rubric_hash,
           baseline_rate, effective_n, agreement, per_mode, per_judge, judge_panel, reproduced, created_at
    from baselines
    where id = ${baselineId} and tenant_id = ${tid}`;
  const withRows = () => sql`
    select id, goal, system_ref, corpus_ref, rubric_text, rubric_hash,
           baseline_rate, effective_n, agreement, per_mode, per_judge, judge_panel, reproduced, created_at,
           per_row
    from baselines
    where id = ${baselineId} and tenant_id = ${tid}`;

  let rows: any[];
  if (!withRowsRequested) {
    rows = await withoutRows();
  } else {
    try {
      rows = await withRows();
      baselinePerRowColumn = true;
      baselinePerRowProbedAt = Date.now();
    } catch (error) {
      // Confirmed per_row, not merely SQLSTATE 42703 — any other missing column re-throws with its
      // own message rather than being misreported as a db/040 lag.
      if (!isMissingPerRowColumn(error)) throw error;
      baselinePerRowColumn = false;
      baselinePerRowProbedAt = Date.now();
      // Logged on EVERY degraded read, not once per process: a caller is being told `per_row: null`
      // for a baseline that may genuinely hold rows, and that claim should be visible each time.
      console.error(
        "[baseline] per_row column absent — returning per_row:null for a read that requested rows (schema lags db/040)",
        { tenant, baselineId },
      );
      rows = await withoutRows();
    }
  }
  const [r] = rows;
  if (!r) throw new Error(`baseline '${baselineId}' not found in tenant '${tenant}'`);
  const perJudge = (typeof r.per_judge === "string" ? JSON.parse(r.per_judge) : (r.per_judge ?? {})) as Record<string, ModeRate>;
  return {
    id: r.id,
    tenant,
    goal: r.goal,
    system_ref: r.system_ref,
    corpus_ref: r.corpus_ref,
    rubric_text: r.rubric_text,
    rubric_hash: r.rubric_hash,
    baseline_rate: Number(r.baseline_rate),
    effective_n: Number(r.effective_n),
    agreement: Number(r.agreement),
    // postgres-js returns jsonb as a parsed object; defensively parse any legacy
    // row that was stored double-encoded (a jsonb scalar string) so per-mode/per-judge
    // lookups never silently operate on a string. A baseline frozen before 006 has no
    // per_judge column value → postgres returns the column default '{}' (an object).
    per_mode: (typeof r.per_mode === "string" ? JSON.parse(r.per_mode) : r.per_mode) as Record<string, ModeRate>,
    per_judge: perJudge,
    ...(() => {
      const loaded = parseLoadedJudgePanel(r.judge_panel, Object.keys(perJudge));
      return {
        judge_panel: loaded.panel,
        ...(loaded.unreadable ? { judge_panel_unreadable: loaded.unreadable } : {}),
      };
    })(),
    reproduced: r.reproduced,
    created_at: r.created_at,
    // `null` here means NOT LOADED on the default arm, and NOT RETAINED on the withRows arm.
    // Present only on the detail arm; the plain arm's BaselineRow has no such members.
    ...(withRowsRequested ? (() => {
      const parsed = parsePerRow(r.per_row, baselineId);
      return { per_row: parsed.rows, per_row_unparsed: parsed.unparsed };
    })() : {}),
  };
}

function isEmptyJudgePanel(value: unknown): boolean {
  return value == null
    || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

// jsonb READ chokepoint for baselines.judge_panel. Missing/`{}` (legacy column default)
// reconstructs from today's DEFAULT_PANEL. That source is not a picker lock.
// Present panels go through parseJudgePanelTrace; a panel that fails the parse
// is NEVER coerced to another source — it comes back as `panel: null` with a
// bounded raw companion (per_row_unparsed pattern), so the read survives while
// verify/goal_titrate refuse explicitly rather than substituting.
export function parseLoadedJudgePanel(value: unknown, fallbackRan: string[]): LoadedJudgePanel {
  let candidate: unknown = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      // jsonb-read trap: fail-open to the raw string so the parser below names
      // the fault instead of a bare SyntaxError escaping a row read.
      candidate = value;
    }
  }
  if (isEmptyJudgePanel(candidate)) {
    return { panel: reconstructedPanel(fallbackRan) };
  }
  try {
    return { panel: parseJudgePanelTrace(candidate) };
  } catch (error) {
    let raw: string;
    try {
      raw = JSON.stringify(candidate) ?? String(candidate);
    } catch {
      raw = String(candidate);
    }
    return {
      panel: null,
      unreadable: {
        error: error instanceof Error ? error.message : String(error),
        raw: raw.slice(0, 2048),
      },
    };
  }
}

function reconstructedPanel(ran: string[]): JudgePanelTrace {
  const ids = new Set(ran);
  return {
    source: "reconstructed-from-engine-config",
    resolved: snapshotPanel(DEFAULT_PANEL.filter((judge) => ids.has(judge.id))),
    ran,
    failed: [],
  };
}
