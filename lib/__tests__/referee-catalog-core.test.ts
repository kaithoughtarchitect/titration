// Titration MCP — referee-catalog-core unit test (no network, no DB, no model — $0).
// Pins source-controlled membership, curated family uniqueness, live admits + empty-catalog validity,
// and validatePanelPicks refusal codes. Selectable Card.agentic_index is number, never null.
// Mirrors dedupe-core.test.ts (check/total/failures + process.exit).
// Run: npx tsx lib/__tests__/referee-catalog-core.test.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REFEREE_PANEL_SIZE,
  REFEREE_TICKET_TTL_SECONDS,
  REFEREE_CATALOG_FAMILIES,
  REFEREE_CATALOG_CANDIDATE_IDS,
  REFEREE_CATALOG_FAMILY_BY_ID,
  REFEREE_CATALOG_ENTRIES,
  admittedCatalogEntries,
  catalogFamilyForId,
  filterSelectableCards,
  isNumericAgenticIndex,
  isRefereeCatalogCandidateId,
  requireNumericAgenticIndex,
  toSelectableCard,
  validatePanelPicks,
  type RefereeCatalogEntry,
} from "../referee-catalog-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
}

const here = dirname(fileURLToPath(import.meta.url));
const corePath = join(here, "..", "referee-catalog-core.ts");
const coreSource = readFileSync(corePath, "utf8");
const admissionPath = join(here, "fixtures", "openrouter", "admission.json");
const admissionRaw = JSON.parse(readFileSync(admissionPath, "utf8")) as {
  candidates: { id: string; status: string; reason?: string }[];
};

// HISTORICAL FLOOR, not incidental duplication: stored selected-panel locks
// validate against the candidate/family tables forever, so ids may be APPENDED
// here but never removed or re-familied. Do not "fix" a membership failure by
// pruning this list — retire models via admission.json status instead.
const COMMISSION_ORDER = [
  "anthropic/claude-opus-5",
  "openai/gpt-5.6-sol",
  "moonshotai/kimi-k3",
  "qwen/qwen3.8-max",
  "meta/muse-spark-1.2",
  "google/gemini-3.7-flash",
  "deepseek/deepseek-v4-pro-0813",
  "z-ai/glm-5.3",
  "deepseek/deepseek-v4-flash-0731",
  "x-ai/grok-4.6",
  "minimax/minimax-m3",
  "minimax/minimax-m2.7-20260318:nitro",
  "openai/gpt-oss-120b:nitro",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "google/gemini-3.8-flash",
  "z-ai/glm-5.3-flash",
  "meta/muse-spark-1.3",
  "qwen/qwen3.8-max-0902",
  "openai/gpt-6-sol",
  "openai/gpt-6-luna",
  "deepseek/deepseek-v4.1-flash",
  "x-ai/grok-4.7",
] as const;

function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e: unknown) {
    return String(e instanceof Error ? e.message : e);
  }
}

function entry(
  id: RefereeCatalogEntry["id"],
  allowed: RefereeCatalogEntry["allowed_efforts"] = ["low", "medium", "high"],
): RefereeCatalogEntry {
  return { id, family: REFEREE_CATALOG_FAMILY_BY_ID[id], allowed_efforts: allowed };
}

// Synthetic admitted set for the pass/refuse paths. Does NOT claim these ids are actually admitted.
const SYNTHETIC_ADMITTED: RefereeCatalogEntry[] = [
  entry("anthropic/claude-opus-5"),
  entry("openai/gpt-5.6-sol"),
  entry("openai/gpt-5.6-luna"),
  entry("x-ai/grok-4.6"),
  entry("deepseek/deepseek-v4-pro-0813"),
  entry("minimax/minimax-m3"),
];

const VALID_TRIPLE = [
  { id: "anthropic/claude-opus-5", effort: "low" },
  { id: "openai/gpt-5.6-sol", effort: "medium" },
  { id: "x-ai/grok-4.6", effort: "high" },
] as const;

check("REFEREE_PANEL_SIZE is 3", REFEREE_PANEL_SIZE === 3);
check("REFEREE_TICKET_TTL_SECONDS is 720", REFEREE_TICKET_TTL_SECONDS === 720);

check(
  "families are the 10 curated providers",
  JSON.stringify([...REFEREE_CATALOG_FAMILIES])
    === JSON.stringify([
      "anthropic",
      "openai",
      "moonshotai",
      "qwen",
      "meta",
      "google",
      "deepseek",
      "z-ai",
      "x-ai",
      "minimax",
    ]),
);

check(
  "candidate ids match commissioned order",
  REFEREE_CATALOG_CANDIDATE_IDS.length === COMMISSION_ORDER.length
    && REFEREE_CATALOG_CANDIDATE_IDS.length === 23
    && REFEREE_CATALOG_CANDIDATE_IDS.every((id, i) => id === COMMISSION_ORDER[i]),
  REFEREE_CATALOG_CANDIDATE_IDS.join(","),
);
check(
  "candidate ids are unique",
  new Set(REFEREE_CATALOG_CANDIDATE_IDS).size === REFEREE_CATALOG_CANDIDATE_IDS.length,
);
check(
  "admission.json rows match catalog ids in order",
  admissionRaw.candidates.length === REFEREE_CATALOG_CANDIDATE_IDS.length
    && admissionRaw.candidates.every((row, i) => row.id === REFEREE_CATALOG_CANDIDATE_IDS[i]),
);
check(
  "membership entries match catalog ids with empty allowed_efforts",
  REFEREE_CATALOG_ENTRIES.length === REFEREE_CATALOG_CANDIDATE_IDS.length
    && REFEREE_CATALOG_ENTRIES.every(
      (item, i) =>
        item.id === REFEREE_CATALOG_CANDIDATE_IDS[i]
        && item.family === REFEREE_CATALOG_FAMILY_BY_ID[item.id]
        && item.allowed_efforts.length === 0,
    ),
);

const FAMILY_EXPECT: Record<(typeof COMMISSION_ORDER)[number], (typeof REFEREE_CATALOG_FAMILIES)[number]> = {
  "anthropic/claude-opus-5": "anthropic",
  "openai/gpt-5.6-sol": "openai",
  "moonshotai/kimi-k3": "moonshotai",
  "qwen/qwen3.8-max": "qwen",
  "meta/muse-spark-1.2": "meta",
  "google/gemini-3.7-flash": "google",
  "deepseek/deepseek-v4-pro-0813": "deepseek",
  "z-ai/glm-5.3": "z-ai",
  "deepseek/deepseek-v4-flash-0731": "deepseek",
  "x-ai/grok-4.6": "x-ai",
  "minimax/minimax-m3": "minimax",
  "minimax/minimax-m2.7-20260318:nitro": "minimax",
  "openai/gpt-oss-120b:nitro": "openai",
  "openai/gpt-5.6-terra": "openai",
  "openai/gpt-5.6-luna": "openai",
  "google/gemini-3.8-flash": "google",
  "z-ai/glm-5.3-flash": "z-ai",
  "meta/muse-spark-1.3": "meta",
  "qwen/qwen3.8-max-0902": "qwen",
  "openai/gpt-6-sol": "openai",
  "openai/gpt-6-luna": "openai",
  "deepseek/deepseek-v4.1-flash": "deepseek",
  "x-ai/grok-4.7": "x-ai",
};
for (const id of REFEREE_CATALOG_CANDIDATE_IDS) {
  check(
    `curated family for ${id} is ${FAMILY_EXPECT[id]}`,
    catalogFamilyForId(id) === FAMILY_EXPECT[id]
      && REFEREE_CATALOG_FAMILY_BY_ID[id] === FAMILY_EXPECT[id],
  );
}
check(
  "openai's four slugs share curated family openai (not unique-by-slug)",
  catalogFamilyForId("openai/gpt-5.6-sol") === "openai"
    && catalogFamilyForId("openai/gpt-5.6-luna") === "openai"
    && catalogFamilyForId("openai/gpt-5.6-terra") === "openai"
    && catalogFamilyForId("openai/gpt-oss-120b:nitro") === "openai",
);

const liveAdmitted = admittedCatalogEntries(admissionRaw.candidates);
const LIVE_ADMITTED_IDS = [
  "moonshotai/kimi-k3",
  "deepseek/deepseek-v4-pro-0813",
  "z-ai/glm-5.3",
  "minimax/minimax-m3",
  "google/gemini-3.8-flash",
  "z-ai/glm-5.3-flash",
  "qwen/qwen3.8-max-0902",
  "meta/muse-spark-1.3",
  "openai/gpt-6-sol",
  "openai/gpt-6-luna",
  "deepseek/deepseek-v4.1-flash",
  "x-ai/grok-4.7",
] as const;
check(
  "live admission is the U1/U2-proven ids",
  liveAdmitted.length === LIVE_ADMITTED_IDS.length
    && LIVE_ADMITTED_IDS.every((id) => liveAdmitted.some((item) => item.id === id))
    && liveAdmitted.every((item) => (LIVE_ADMITTED_IDS as readonly string[]).includes(item.id)),
  `admitted=${liveAdmitted.map((item) => item.id).join(",")}`,
);
check(
  "empty admitted catalog remains a valid shape",
  Array.isArray(admittedCatalogEntries([])) && admittedCatalogEntries([]).length === 0,
);
check(
  "halted ids are not admitted",
  !liveAdmitted.some((item) => item.id === "anthropic/claude-opus-5")
    && !liveAdmitted.some((item) => item.id === "qwen/qwen3.8-max")
    && !liveAdmitted.some((item) => item.id === "meta/muse-spark-1.2"),
);
check(
  "admittedCatalogEntries drops pasted and halted rows",
  admittedCatalogEntries([
    { id: "openai/gpt-5.6-sol", status: "halted" },
    { id: "acme/totally-fake", status: "admitted" },
    { id: "x-ai/grok-4.6", status: "admitted" },
  ]).map((item) => item.id).join(",") === "x-ai/grok-4.6",
);

const emptyPicks = validatePanelPicks(
  [
    { id: "qwen/qwen3.8-max", effort: "low" },
    { id: "openai/gpt-5.6-sol", effort: "medium" },
    { id: "x-ai/grok-4.6", effort: "high" },
  ],
  liveAdmitted,
);
check(
  "unadmitted commissioned ids refuse not_admitted (does not throw)",
  emptyPicks.ok === false && emptyPicks.code === "not_admitted",
  JSON.stringify(emptyPicks),
);
check(
  "empty selectable filter is valid",
  filterSelectableCards([]).length === 0,
);

const ok = validatePanelPicks(VALID_TRIPLE, SYNTHETIC_ADMITTED);
check(
  "exactly-3 distinct-family picks pass when admitted and efforts are allowed",
  ok.ok === true
    && ok.ok
    && ok.picks.length === 3
    && ok.picks[0].id === "anthropic/claude-opus-5"
    && ok.picks[0].family === "anthropic"
    && ok.picks[0].effort === "low"
    && ok.picks[1].id === "openai/gpt-5.6-sol"
    && ok.picks[1].family === "openai"
    && ok.picks[2].id === "x-ai/grok-4.6"
    && ok.picks[2].family === "x-ai",
  JSON.stringify(ok),
);

check(
  "count ≠ 3 (0) refuses count",
  (() => {
    const r = validatePanelPicks([], SYNTHETIC_ADMITTED);
    return r.ok === false && r.code === "count";
  })(),
);
check(
  "count ≠ 3 (2) refuses count",
  (() => {
    const r = validatePanelPicks(VALID_TRIPLE.slice(0, 2), SYNTHETIC_ADMITTED);
    return r.ok === false && r.code === "count";
  })(),
);
check(
  "count ≠ 3 (4) refuses count",
  (() => {
    const r = validatePanelPicks([...VALID_TRIPLE, { id: "minimax/minimax-m3", effort: "low" }], SYNTHETIC_ADMITTED);
    return r.ok === false && r.code === "count";
  })(),
);
check(
  "non-array picks refuse count",
  (() => {
    const r = validatePanelPicks(null, SYNTHETIC_ADMITTED);
    return r.ok === false && r.code === "count";
  })(),
);

const dupFamily = validatePanelPicks(
  [
    { id: "openai/gpt-5.6-sol", effort: "low" },
    { id: "openai/gpt-5.6-luna", effort: "medium" },
    { id: "x-ai/grok-4.6", effort: "high" },
  ],
  SYNTHETIC_ADMITTED,
);
check(
  "openai/gpt-5.6-sol + openai/gpt-5.6-luna is duplicate_family",
  dupFamily.ok === false && dupFamily.code === "duplicate_family",
  JSON.stringify(dupFamily),
);

const unknown = validatePanelPicks(
  [
    { id: "", effort: "low" },
    { id: "openai/gpt-5.6-sol", effort: "medium" },
    { id: "x-ai/grok-4.6", effort: "high" },
  ],
  SYNTHETIC_ADMITTED,
);
check(
  "empty id refuses unknown_id",
  unknown.ok === false && unknown.code === "unknown_id",
  JSON.stringify(unknown),
);
check(
  "non-object pick refuses unknown_id",
  (() => {
    const r = validatePanelPicks(["openai/gpt-5.6-sol", VALID_TRIPLE[1], VALID_TRIPLE[2]], SYNTHETIC_ADMITTED);
    return r.ok === false && r.code === "unknown_id";
  })(),
);

const pasted = validatePanelPicks(
  [
    { id: "acme/totally-fake-model", effort: "low" },
    { id: "openai/gpt-5.6-sol", effort: "medium" },
    { id: "x-ai/grok-4.6", effort: "high" },
  ],
  SYNTHETIC_ADMITTED,
);
check(
  "pasted slug not in the 15 refuses pasted_slug",
  pasted.ok === false && pasted.code === "pasted_slug",
  JSON.stringify(pasted),
);

const legacyModels = validatePanelPicks(
  [
    { id: "x-ai/grok-4.3", effort: "high" },
    { id: "openai/gpt-5.5", effort: "high" },
    { id: "deepseek/deepseek-v4-pro", effort: "high" },
  ],
  SYNTHETIC_ADMITTED,
);
check(
  "DEFAULT_PANEL model slugs are not catalog membership (pasted_slug)",
  legacyModels.ok === false && legacyModels.code === "pasted_slug",
  JSON.stringify(legacyModels),
);
check(
  "legacy short ids grok/gpt/deepseek are pasted_slug",
  (() => {
    const r = validatePanelPicks(
      [
        { id: "grok", effort: "high" },
        { id: "gpt", effort: "high" },
        { id: "deepseek", effort: "high" },
      ],
      SYNTHETIC_ADMITTED,
    );
    return r.ok === false && r.code === "pasted_slug";
  })(),
);
check(
  "catalog candidate ids are not the legacy short ids",
  !isRefereeCatalogCandidateId("grok")
    && !isRefereeCatalogCandidateId("gpt")
    && !isRefereeCatalogCandidateId("deepseek")
    && !isRefereeCatalogCandidateId("x-ai/grok-4.3"),
);

const notAdmitted = validatePanelPicks(
  [
    { id: "qwen/qwen3.8-max", effort: "low" },
    { id: "openai/gpt-5.6-sol", effort: "medium" },
    { id: "x-ai/grok-4.6", effort: "high" },
  ],
  SYNTHETIC_ADMITTED,
);
check(
  "commissioned but non-admitted id refuses not_admitted",
  notAdmitted.ok === false && notAdmitted.code === "not_admitted",
  JSON.stringify(notAdmitted),
);

const spoofedFamily = validatePanelPicks(VALID_TRIPLE, [
  { id: "anthropic/claude-opus-5", family: "openai", allowed_efforts: ["low", "medium", "high"] },
  entry("openai/gpt-5.6-sol"),
  entry("x-ai/grok-4.6"),
]);
check(
  "family field mismatch vs curated map refuses (not slug-prefix family)",
  spoofedFamily.ok === false && spoofedFamily.code === "not_admitted",
  JSON.stringify(spoofedFamily),
);

const emptyAllow = validatePanelPicks(VALID_TRIPLE, [
  entry("anthropic/claude-opus-5", []),
  entry("openai/gpt-5.6-sol", []),
  entry("x-ai/grok-4.6", []),
]);
check(
  "empty allowed_efforts (U1 unproven) refuses illegal_effort even if admitted",
  emptyAllow.ok === false && emptyAllow.code === "illegal_effort",
  JSON.stringify(emptyAllow),
);

const illegal = validatePanelPicks(
  [
    { id: "anthropic/claude-opus-5", effort: "high" },
    { id: "openai/gpt-5.6-sol", effort: "medium" },
    { id: "x-ai/grok-4.6", effort: "high" },
  ],
  [
    entry("anthropic/claude-opus-5", ["low"]),
    entry("openai/gpt-5.6-sol"),
    entry("x-ai/grok-4.6"),
  ],
);
check(
  "effort outside the card allowlist refuses illegal_effort",
  illegal.ok === false && illegal.code === "illegal_effort",
  JSON.stringify(illegal),
);

const bogusEffort = validatePanelPicks(
  [
    { id: "anthropic/claude-opus-5", effort: "extreme" },
    { id: "openai/gpt-5.6-sol", effort: "medium" },
    { id: "x-ai/grok-4.6", effort: "high" },
  ],
  SYNTHETIC_ADMITTED,
);
check(
  "unknown effort token refuses illegal_effort",
  bogusEffort.ok === false && bogusEffort.code === "illegal_effort",
  JSON.stringify(bogusEffort),
);

const missingEffort = validatePanelPicks(
  [
    { id: "anthropic/claude-opus-5" },
    { id: "openai/gpt-5.6-sol", effort: "medium" },
    { id: "x-ai/grok-4.6", effort: "high" },
  ],
  SYNTHETIC_ADMITTED,
);
check(
  "missing effort refuses illegal_effort",
  missingEffort.ok === false && missingEffort.code === "illegal_effort",
  JSON.stringify(missingEffort),
);

const selectableOk = toSelectableCard(entry("x-ai/grok-4.6"), 72.5);
check(
  "selectable card keeps a numeric agentic_index",
  selectableOk.ok === true
    && selectableOk.ok
    && selectableOk.card.agentic_index === 72.5
    && typeof selectableOk.card.agentic_index === "number",
);
check(
  "null agentic_index is selectable as unpublished",
  (() => {
    const r = toSelectableCard(entry("x-ai/grok-4.6"), null);
    return r.ok === true && r.ok && r.card.agentic_index === null;
  })(),
);
check(
  "undefined agentic_index is unpublished; non-finite is not selectable",
  (() => {
    const missing = toSelectableCard(entry("x-ai/grok-4.6"), undefined);
    return missing.ok === true && missing.ok && missing.card.agentic_index === null
      && toSelectableCard(entry("x-ai/grok-4.6"), Number.NaN).ok === false
      && toSelectableCard(entry("x-ai/grok-4.6"), Number.POSITIVE_INFINITY).ok === false
      && !isNumericAgenticIndex(null)
      && !isNumericAgenticIndex("72.5");
  })(),
);
check(
  "filterSelectableCards keeps unpublished index and omits garbage",
  filterSelectableCards([
    { id: "x-ai/grok-4.6", family: "x-ai", allowed_efforts: ["low"], agentic_index: 10 },
    { id: "openai/gpt-5.6-sol", family: "openai", allowed_efforts: ["low"], agentic_index: null },
    { id: "anthropic/claude-opus-5", family: "anthropic", allowed_efforts: ["low"], agentic_index: "12" },
  ]).map((card) => card.id).join(",") === "x-ai/grok-4.6,openai/gpt-5.6-sol",
);
check(
  "requireNumericAgenticIndex returns the number",
  requireNumericAgenticIndex(12) === 12,
);
check(
  "requireNumericAgenticIndex throws on null (corrupt jsonb does not become null)",
  throws(() => requireNumericAgenticIndex(null)) !== null,
);
check(
  "requireNumericAgenticIndex throws on a string",
  (throws(() => requireNumericAgenticIndex("12")) ?? "").includes("agentic_index"),
);

check(
  "core has no Date.now()",
  !/\bDate\.now\s*\(/.test(coreSource),
);
check(
  "core has no Math.random()",
  !/\bMath\.random\s*\(/.test(coreSource),
);
check(
  "core does not import judge.ts / DEFAULT_PANEL",
  !/from\s+["'][^"']*judge["']/.test(coreSource)
    && !/\bDEFAULT_PANEL\b/.test(coreSource)
    && !/from\s+["']\.\/judge["']/.test(coreSource),
);
check(
  "core has no fs / fetch / network imports",
  !/from\s+["']node:(fs|http|https|net|dgram|dns)["']/.test(coreSource)
    && !/\bfetch\s*\(/.test(coreSource)
    && !/from\s+["']undici["']/.test(coreSource),
);
// familyForOpenRouterSlug is a deliberate, narrow exception — a
// bare-slug family derivation for the SINGLE-model HELPER callers (propose_cards,
// edge_propose, harness_validate, harness_design), which are advisory, non-panel
// calls and never touch REFEREE_CATALOG_CANDIDATE_IDS / REFEREE_CATALOG_FAMILY_BY_ID.
// The invariant this file exists to protect — the CURATED CATALOG never derives a
// candidate's family from its slug prefix — must still hold everywhere else in the
// file; slice the one documented helper out before scanning for it.
const familyForSlugStart = coreSource.indexOf("export function familyForOpenRouterSlug");
// CRLF-tolerant close-brace search (this file is checked out with CRLF line endings).
const closingBraceMatch = familyForSlugStart >= 0
  ? /\r?\n\}\r?\n/.exec(coreSource.slice(familyForSlugStart))
  : null;
const familyForSlugEnd = closingBraceMatch
  ? familyForSlugStart + closingBraceMatch.index + closingBraceMatch[0].length
  : -1;
const coreSourceWithoutSlugHelper = familyForSlugStart >= 0 && familyForSlugEnd > familyForSlugStart
  ? coreSource.slice(0, familyForSlugStart) + coreSource.slice(familyForSlugEnd)
  : coreSource;
check(
  "core does not derive CATALOG family from slug prefix outside the documented familyForOpenRouterSlug helper",
  !/\.split\(\s*["']\/["']\s*\)/.test(coreSourceWithoutSlugHelper)
    && !/id\.split\(/.test(coreSourceWithoutSlugHelper)
    && coreSource.includes("REFEREE_CATALOG_FAMILY_BY_ID"),
);
check(
  "familyForOpenRouterSlug is exported and is the only slug-prefix deriver (non-panel helper callers only)",
  familyForSlugStart >= 0
    && /export function familyForOpenRouterSlug\(/.test(coreSource)
    && /\.split\(\s*["']\/["']\s*\)/.test(coreSource),
);

console.log(`${failures === 0 ? "PASS" : "FAIL"} ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
