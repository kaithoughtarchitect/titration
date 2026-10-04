// Titration MCP (OSS) — public-surface scrub check.
//
// Walks the repo (excluding node_modules/, .git/, and .env — the same set a
// `git ls-files` listing would already leave out, since node_modules and .env
// are gitignored and .git is not tracked content) and greps every remaining
// text file for three families of pattern:
//
//   - HARD-FAIL: never allowed, no exceptions (private-client name, personal
//     name/email, Neon project ids, workstation paths, retired auth
//     provider, the retired hosted domain, real-looking secrets). The one
//     built-in exception is real-looking OpenRouter secrets inside a
//     recorded/synthetic test-fixture file, which is itself an allowlist-table
//     entry, not a carve-out in the pattern logic.
//   - FAIL-UNLESS-ALLOWLISTED: internal systems/vocabulary that must not leak
//     into the public repo UNLESS the specific (pattern, file) pair is listed
//     in ALLOWLIST below with a reason. This includes the private product's
//     internal planning vocabulary (decision codes like `(C1/F4)` or `FR2.1`,
//     the internal build-record system, tier/spec-doc naming, hosted-vs-local
//     mode language) — a public contributor must be able to read every
//     comment without knowing any of that history.
//   - DEAD-PATH-REFERENCE: every repo-relative path named in a comment or a
//     .md doc (under lib/, server/, scripts/, db/, docs/, skills/, ingest/,
//     query/, retrieval-eval/) must resolve to a real file or directory in
//     this repo — a stale pointer to a file that only ever existed in the
//     private source is exactly the kind of dead reference a public reader
//     cannot follow.
//
// Prints every hit as `path:line: pattern-name` and exits 1 if any hit is not
// covered by an allowlist entry. Run: `node scripts/scrub-check.mjs`.
//
// This check is EXPECTED to fail on a tree that has not yet been scrubbed —
// it is the detector, not the fix.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Directories/files never scanned ────────────────────────────────────────
// Exactly the exclusion set this check is specified to use: node_modules/ and
// .git/ (neither is tracked public-surface content) and any file literally
// named `.env` (the one gitignored local-secrets file this repo has today).
// `.env.example` is NOT excluded — it is exactly the kind of file this check
// exists to catch a leaked real host/secret in.
// .journeys/ holds internal build records that are never published; scanning
// it would just re-report the same internal vocabulary this check exists to
// catch elsewhere, over content that never ships.
const SKIP_DIRS = new Set(["node_modules", ".git", ".journeys"]);
const SKIP_FILE_BASENAMES = new Set([".env"]);
// Binary files match patterns by coincidence inside compressed bytes. Their text lives in a
// scanned source instead (the deck PDF and README images are built from
// docs/deck/titration-deck.html, which this check reads).
const SKIP_BINARY_EXTENSIONS = /\.(pdf|png|jpe?g|gif|ico|webp|woff2?|mp4|webm|mov)$/i;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // unreadable (broken symlink, permission) — skip, not fatal
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile()) {
      if (SKIP_FILE_BASENAMES.has(entry)) continue;
      if (SKIP_BINARY_EXTENSIONS.test(entry)) continue;
      out.push(full);
    }
  }
  return out;
}

function relPath(absPath) {
  return relative(root, absPath).replace(/\\/g, "/");
}

// ── HARD-FAIL patterns — no exceptions ─────────────────────────────────────
const HARD_FAIL = [
  { name: "huspace", re: /huspace/i },
  { name: "parratt", re: /parratt/i },
  { name: "alexaaronxavier", re: /alexaaronxavier/i },
  { name: "alex-word", re: /\balex\b/i },
  { name: "late-king", re: /late-king/i },
  { name: "holy-sea", re: /holy-sea/i },
  { name: "ep-sparkling", re: /ep-sparkling/i },
  { name: "neon.tech", re: /neon\.tech/i },
  { name: "windows-path-backslash", re: /C:\\Users/i },
  { name: "windows-path-forwardslash", re: /C:\/Users/i },
  { name: "unix-home-path", re: /\/Users\/[A-Za-z]/i },
  { name: "ondigitalocean", re: /ondigitalocean/i },
  { name: "clerk", re: /clerk/i },
  { name: "app.titration.dev", re: /app\.titration\.dev/i },
  { name: "support-email", re: /support@titration\.dev/i },
  // Real-looking OpenRouter secret: sk-or-v1- followed by 40+ hex chars.
  // The one hard-fail pattern with a named allowlist exception (below) for
  // recorded/synthetic test-fixture files.
  { name: "openrouter-secret", re: /sk-or-v1-[0-9a-f]{40,}/i },
];

// ── FAIL-UNLESS-ALLOWLISTED patterns ───────────────────────────────────────
// \bT\d+[a-z]?\b intentionally does NOT match card refs like `T-MET-041` —
// those have a hyphen right after `T`, so `\d+` never gets a digit adjacent
// to the `T`, and the pattern simply does not fire on them.
const FAIL_UNLESS_ALLOWLISTED = [
  { name: "rawai", re: /rawai/i },
  { name: "kaithoughtarchitect", re: /kaithoughtarchitect/i },
  { name: "operator-word", re: /\boperator\b/i },
  { name: "cockpit", re: /cockpit/i },
  { name: "bridge", re: /bridge/i },
  { name: "journeyman", re: /journeyman/i },
  { name: "referee-kit", re: /referee[\s-]kit/i },
  { name: "j-loop", re: /j-loop/i },
  { name: "plan-read", re: /plan-read/i },
  { name: "internal-id-T", re: /\bT\d+[a-z]?\b/i },
  { name: "internal-id-VP", re: /\bVP-\d+/i },
  { name: "internal-id-FW", re: /\bFW-\d+/i },
  { name: "internal-id-ADR", re: /\bADR-\d+/i },
  { name: "law-a", re: /Law A/ },
  { name: "scratch-tenant", re: /\bscratch\b/i },

  // ── private planning vocabulary: decision/requirement codes ────────────────
  // Parenthesised decision codes, e.g. `(C1/F4)`, `(P3)`, `(Q15)`.
  { name: "decision-code-paren", re: /\((?:[CFPQ]\d+[a-z]?)(?:\s*[/,]\s*[CFPQ]\d+[a-z]?)*\)/ },
  // Bare `FR2.1`, `FR1.5`, etc.
  { name: "decision-code-fr", re: /\bFR\d+(?:\.\d+)*\b/ },
  // Bare `NFR4`, `NFR11`, etc.
  { name: "decision-code-nfr", re: /\bNFR\d+\b/ },
  // Bare `VP-N7`, `VP-N1`, etc. (distinct from the existing internal-id-VP,
  // which requires a digit immediately after `VP-` and so never fires on the
  // `VP-N<digit>` shape this task adds).
  { name: "decision-code-vpn", re: /\bVP-N?\d+\b/ },
  // Bare `C1`, `F14`, `P5`, `Q9` — only when followed by a delimiter that
  // marks it as a citation rather than an ordinary alphanumeric token (tuned
  // to avoid firing on unrelated code/prose; a genuine non-decision use is an
  // ALLOWLIST entry, not a carve-out in the pattern).
  { name: "decision-code-bare", re: /\b[CFPQ]\d{1,2}\b(?= —|:|,|\))/ },

  // ── private build/planning system references ───────────────────────────────
  { name: "oss-port", re: /OSS[ -]port/i },
  { name: "journey-word", re: /[Jj]ourney/ },
  { name: "journey-id", re: /\bJ[1-8]\b/ },
  { name: "impl-plan", re: /IMPL-PLAN/ },

  // ── dead private-spec-doc naming ────────────────────────────────────────────
  { name: "spec-tier", re: /SPEC-tier/ },
  { name: "product-spec", re: /PRODUCT-SPEC/ },
  { name: "private-repo-phrase", re: /private repo/i },

  // ── hosted-vs-local product history (this build has exactly one mode) ──────
  { name: "tier-abc", re: /\bTier [ABC]\b/ },
  // Negative lookbehind keeps `self-hosted` (a real, current description of
  // this build) out of this pattern entirely.
  { name: "hosted", re: /(?<!self-)\bhosted\b/i },
  { name: "trusted-local", re: /trusted-local/i },
  { name: "dogfood", re: /dogfood/i },
  // `pack` only when it is NOT the allowed "starter pack" / "base starter
  // pack" phrasing (docs/README's public vocabulary for the base).
  { name: "pack-word", re: /(?<!starter )\bpack\b/i },
];

// ── Allowlist table: { pattern, glob, reason } ─────────────────────────────
// `glob` supports plain relative paths, `*` (any run of non-slash chars) and
// a `**` path segment (any depth). Matched against the repo-relative,
// forward-slash-normalized path.
const ALLOWLIST = [
  { pattern: "scratch-tenant", glob: "scripts/smoke-mcp-project-isolation.ts", reason: "fixed disposable-test project used to restrict isolation-proof writes; not a private deployment reference" },
  { pattern: "kaithoughtarchitect", glob: "README.md", reason: "public repo pointer / author attribution" },
  { pattern: "kaithoughtarchitect", glob: "LICENSE", reason: "license boilerplate may name the repo owner" },
  { pattern: "kaithoughtarchitect", glob: "NOTICE", reason: "project NOTICE copyright line" },
  { pattern: "kaithoughtarchitect", glob: "package.json", reason: "repository URL field" },
  { pattern: "kaithoughtarchitect", glob: "lib/public-repo-url.ts", reason: "the single constant lib/judge.ts's HTTP-Referer imports" },
  { pattern: "kaithoughtarchitect", glob: "CONTRIBUTING.md", reason: "clone URL in dev setup" },
  { pattern: "kaithoughtarchitect", glob: "SECURITY.md", reason: "allowed location per SCRUB-LIST.md even if currently unused" },
  { pattern: "kaithoughtarchitect", glob: ".github/**", reason: "issue/PR templates and CI may reference the repo" },
  { pattern: "kaithoughtarchitect", glob: "docs/deck/titration-deck.html", reason: "clone command and repo URL on the overview deck" },
  { pattern: "openrouter-secret", glob: "lib/__tests__/fixtures/**", reason: "recorded/synthetic OpenRouter door fixtures may contain placeholder key-shaped strings, never real credentials" },
  { pattern: "openrouter-secret", glob: "lib/__tests__/tool-error-redaction-core.test.ts", reason: "synthetic key-shaped fixture asserting the redaction pipeline actually redacts it, never a real credential" },
  { pattern: "internal-id-T", glob: "examples/ticket-triage/**", reason: "the example's sample tickets are numbered t01-t30; a ticket id, not an internal card ref" },
  { pattern: "internal-id-T", glob: "lib/__tests__/fixtures/openrouter/recorded/**", reason: "real recorded OpenRouter transport receipts contain opaque base64/encrypted payloads; a card-ref-shaped substring here is coincidental noise, not an internal reference" },
  { pattern: "cockpit", glob: "scripts/import-graph-check.mjs", reason: "denylist regex guarding against an accidental import from a removed hosted-only directory; the check must name the directory to deny it" },
  { pattern: "bridge", glob: "scripts/import-graph-check.mjs", reason: "denylist regex guarding against an accidental import from a removed hosted-only directory; the check must name the directory to deny it" },
  { pattern: "hosted", glob: "scripts/import-graph-check.mjs", reason: "denylist regex naming a removed hosted-only module (hosted-context-core.ts) that must never be importable; the check must name it to deny it" },
  // `trusted-local` is the single-mode discriminant literal threaded through
  // McpMode / McpPresentationPolicy<TMode> / JobExecutionContextFor<TMode> /
  // McpEvolutionAdapter<TPrepared, TMode> across these four files. Collapsing
  // that generic (there is only ever one TMode now) would be a mechanical but
  // wide-reaching refactor of the server's type layer for a literal that is
  // not prose and needs no explanation for a reader; it names the one mode
  // this build runs.
  { pattern: "trusted-local", glob: "lib/job-queue.ts", reason: "code identifier: the single-mode discriminant literal (see server/mcp-server.ts for the full rationale)" },
  { pattern: "trusted-local", glob: "server/evolution-local.ts", reason: "code identifier: the single-mode discriminant literal (see server/mcp-server.ts for the full rationale)" },
  { pattern: "trusted-local", glob: "server/mcp-server.ts", reason: "code identifier: the single-mode discriminant literal threaded through McpMode/McpPresentationPolicy<TMode>/JobExecutionContextFor<TMode>; collapsing the TMode generic across the server would be a wide-reaching refactor for a literal that is not prose" },
  { pattern: "trusted-local", glob: "server/server.ts", reason: "code identifier: the single-mode discriminant literal (see server/mcp-server.ts for the full rationale)" },
];

function globToRegExp(glob) {
  const escapeSegment = (seg) =>
    seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  const pattern = glob
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => (seg === "**" ? ".*" : escapeSegment(seg)))
    .join("/");
  return new RegExp(`^${pattern}$`);
}

function isAllowlisted(patternName, rel) {
  return ALLOWLIST.some(
    (entry) => entry.pattern === patternName && globToRegExp(entry.glob).test(rel),
  );
}

// ── Dead-path-reference check ───────────────────────────────────────────────
// Every repo-relative path named in a comment or a .md doc, under one of
// these top-level directories, must resolve to a real file/directory — a
// public contributor cannot follow a pointer to a file that only existed in
// the private source. Scoped to comments (not arbitrary code/string
// literals) so a denylist regex like import-graph-check.mjs's DENIED array —
// which deliberately NAMES removed modules so it can refuse them — is never
// mistaken for a live reference.
const PATH_CHECK_DIRS = ["lib", "server", "scripts", "db", "docs", "skills", "ingest", "query", "retrieval-eval"];
const PATH_TOKEN_RE = new RegExp(
  `\\b(?:${PATH_CHECK_DIRS.join("|")})/[A-Za-z0-9_./*-]*[A-Za-z0-9_/*-]`,
  "g",
);
// Only a token ending in a recognized extension or a trailing `/` (a
// directory reference) is unambiguous enough to check — an extension-free
// mention like "lib/store" (common, informal, all over this codebase's
// comments) cannot be resolved to one specific file and is left alone.
const PATH_CHECKABLE_SUFFIX = /\.(?:ts|mjs|js|json|sql|md)$|\/$/;
// Exact, documented placeholder paths — real conventions this repo's own
// docs describe, never files that are supposed to exist on disk.
const PATH_PLACEHOLDERS = new Set([
  "lib/X-core.ts",
  "lib/X.ts",
  "db/NNN_description.sql",
  "docs/core-learnings/CORE-LEARNINGS-v0.N.md",
]);
const commentLineRe = /^\s*(?:\/\/|\/\*|\*)/;

function findDeadPathReferences(rel, line) {
  const isMd = rel.endsWith(".md");
  if (!isMd && !commentLineRe.test(line)) return [];
  const found = [];
  for (const m of line.matchAll(PATH_TOKEN_RE)) {
    // Strip trailing sentence punctuation a real path would never carry.
    const token = m[0].replace(/[.,:;)]+$/, "");
    if (!token || token.includes("*")) continue; // a glob, not a literal path
    if (PATH_PLACEHOLDERS.has(token)) continue;
    if (!PATH_CHECKABLE_SUFFIX.test(token)) continue;
    // A hyphen right at end-of-line with nothing after it is a word wrapped
    // across the line break (e.g. "lib/harness-\n// design-core.ts"), not a
    // path fragment.
    if (token.endsWith("-") && line.trimEnd().endsWith(token)) continue;
    if (!existsSync(join(root, token))) found.push(token);
  }
  return found;
}

// ── Scan ────────────────────────────────────────────────────────────────────
// This file (scrub-check.mjs) and skills/check-skills.mjs are excluded from
// this scan. Both are regex-based detectors that necessarily contain the
// literal words their own patterns match against (that is how a detector is
// written) — scanning either against itself would produce permanent,
// unfixable self-referential hits (their own vocabulary, not a content leak)
// and the check could never reach a clean state even after every real hit
// elsewhere is scrubbed. skills/check-skills.mjs is still run as its own,
// separate gate (`node skills/check-skills.mjs`) — this exclusion only keeps
// THIS script from re-flagging that script's own detection literals. These
// are the only exclusions beyond node_modules/.git/.env — every other file
// under scripts/ and skills/ is still scanned.
const SELF_PATH = fileURLToPath(import.meta.url);
const OTHER_SELF_EXCLUDED_PATHS = new Set([join(root, "skills", "check-skills.mjs")]);
const files = walk(root)
  .filter((abs) => abs !== SELF_PATH && !OTHER_SELF_EXCLUDED_PATHS.has(abs))
  .map(relPath)
  .sort();

let totalHits = 0;
let failingHits = 0;
const byPattern = new Map();
const byTopDir = new Map();

function record(rel, lineNo, patternName, allowed, detail = "") {
  totalHits++;
  if (!allowed) failingHits++;
  console.log(`${rel}:${lineNo}: ${patternName}${detail ? ` [${detail}]` : ""}${allowed ? " (allowlisted)" : ""}`);
  byPattern.set(patternName, (byPattern.get(patternName) ?? 0) + 1);
  const topDir = rel.includes("/") ? rel.split("/")[0] : ".";
  byTopDir.set(topDir, (byTopDir.get(topDir) ?? 0) + 1);
}

for (const rel of files) {
  const abs = join(root, rel);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue; // unreadable/binary — not scannable as text, skip
  }
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    for (const { name, re } of HARD_FAIL) {
      if (!re.test(line)) continue;
      // Hard-fail patterns have no exceptions EXCEPT one named allowlist
      // entry for real-looking secrets in recorded/synthetic fixtures.
      const allowed = name === "openrouter-secret" && isAllowlisted(name, rel);
      record(rel, lineNo, name, allowed);
    }
    for (const { name, re } of FAIL_UNLESS_ALLOWLISTED) {
      if (!re.test(line)) continue;
      const allowed = isAllowlisted(name, rel);
      record(rel, lineNo, name, allowed);
    }
    for (const token of findDeadPathReferences(rel, line)) {
      const allowed = isAllowlisted("dead-path-reference", rel);
      record(rel, lineNo, "dead-path-reference", allowed, token);
    }
  }
}

console.log("");
console.log(`Scanned ${files.length} files.`);
console.log(`${totalHits} total hit(s), ${failingHits} unallowlisted (failing).`);

console.log("\nHits by pattern:");
for (const [name, count] of [...byPattern.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name}: ${count}`);
}

console.log("\nHits by top-level directory:");
for (const [dir, count] of [...byTopDir.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${dir}: ${count}`);
}

if (failingHits > 0) {
  console.error(`\nscrub-check: ${failingHits} unallowlisted hit(s) — see above.`);
  process.exit(1);
}
console.log("\nscrub-check: clean.");
