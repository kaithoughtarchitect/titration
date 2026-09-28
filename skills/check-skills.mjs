#!/usr/bin/env node
// Guards the public agent skills against two regressions:
//
//   (a) hosted-product mechanics that don't exist in this self-hosted build
//       leaking back into the docs — see FORBIDDEN_PATTERN below for the exact
//       list; and
//   (b) a tool name that doesn't exist on the local 18-tool MCP surface being
//       mentioned as if it were callable.
//
// This file necessarily contains the strings in FORBIDDEN_PATTERN as literal
// detection text (the same way any scrub/allow-list script must); it excludes
// itself from the scan below rather than pretending those literals are absent.
//
// Run: node skills/check-skills.mjs
// Exit 0 and one confirmation line on success; exit 1 and every offending line
// (file:line: match) on failure — never partial output, so a caller can trust a
// clean exit without re-reading the log.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const skillsDir = resolve(here, "..");
const selfPath = resolve(here);

// ---------------------------------------------------------------------------
// (a) Forbidden strings — hosted mechanics / internal names that must never
// appear in a self-hosted, public skill doc. `panel_receipt_id` is NOT on this
// list: it is the legitimate local argument establish_baseline takes once a
// picker ticket is confirmed (see titration-improve/SKILL.md).
// ---------------------------------------------------------------------------
const FORBIDDEN_PATTERN = new RegExp(
  [
    "cockpit",
    "bridge",
    "agent_setup_receipt",
    "push receipt",
    "bridge\\.mjs",
    "oauth",
    "workspace",
    "client\\.json",
    "harness_declare",
    "corpus_cases_push",
    "system_link_baseline",
    "\\btenant\\b",
    "huspace",
    "rawai",
  ].join("|"),
  "i",
);

// ---------------------------------------------------------------------------
// (b) Every tool name the skills may call — the local server's exact 18-tool
// surface (server/mcp-server.ts TRUSTED_LOCAL_TOOL_NAMES + the two picker
// tools it adds: referee_panel_mint, referee_panel_status).
// ---------------------------------------------------------------------------
const KNOWN_TOOLS = new Set([
  "card_search",
  "card_get",
  "card_create",
  "card_relate",
  "run_capture",
  "card_distill",
  "classify_failure",
  "establish_baseline",
  "verify",
  "job_status",
  "goal_titrate",
  "goal_titrate_step",
  "harness_design",
  "harness_validate",
  "propose_cards",
  "edge_propose",
  "referee_panel_mint",
  "referee_panel_status",
]);

// A backticked identifier is checked against KNOWN_TOOLS only when it starts
// with one of these prefixes — the shape every real tool name takes. Anything
// else backticked (goal, rubric, project, player_model, ...) is untouched.
const TOOL_PREFIXES = [
  "card_",
  "run_",
  "classify_",
  "establish_",
  "verify",
  "job_",
  "goal_titrate",
  "harness_",
  "propose_",
  "edge_",
  "referee_panel_",
];

// Real INPUT FIELD names on the 18 tools' own schemas that happen to share a
// tool prefix (e.g. card_get's `card_ref` argument starts with "card_", same
// as the tool card_search). These are not tool calls and are allowed.
const ALLOWED_NON_TOOL_IDENTIFIERS = new Set([
  "card_ref",
  "card_type",
  "card_status",
  "run_ref",
  "run_summary",
  "job_id",
  "propose_model",
]);

// The Agent Skills spec caps a description at 1024 characters; counting UTF-8 bytes
// is the stricter reading, so a description that passes here passes every loader.
const MAX_DESCRIPTION_BYTES = 1024;

function looksLikeToolPrefixed(identifier) {
  return TOOL_PREFIXES.some((prefix) => identifier.startsWith(prefix));
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFiles(full));
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const files = listFiles(skillsDir)
    .filter((f) => resolve(f) !== selfPath)
    // Text/doc files only — skip anything binary-shaped a future skill folder might add.
    .filter((f) => [".md", ".mjs", ".js", ".ts", ".json", ".txt", ""].includes(extname(f)));

  const violations = [];

  for (const file of files) {
    const relPath = relative(skillsDir, file).split("\\").join("/");
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");

    lines.forEach((line, idx) => {
      const lineNo = idx + 1;

      // (a) forbidden hosted-mechanics / internal-name strings.
      const forbiddenMatch = line.match(FORBIDDEN_PATTERN);
      if (forbiddenMatch) {
        violations.push(
          `${relPath}:${lineNo}: forbidden pattern '${forbiddenMatch[0]}' -- ${line.trim()}`,
        );
      }

      // (b) backticked, tool-prefixed identifiers not in the 18-tool list.
      const backtickRe = /`([A-Za-z][A-Za-z0-9_]*)`/g;
      let m;
      while ((m = backtickRe.exec(line)) !== null) {
        const identifier = m[1];
        if (!looksLikeToolPrefixed(identifier)) continue;
        if (KNOWN_TOOLS.has(identifier)) continue;
        if (ALLOWED_NON_TOOL_IDENTIFIERS.has(identifier)) continue;
        violations.push(
          `${relPath}:${lineNo}: '${identifier}' looks like a tool call but is not one of the 18 local tools -- ${line.trim()}`,
        );
      }
    });

    // (c) the Agent Skills spec caps a SKILL.md frontmatter description at 1024
    // characters, and some loaders count bytes. Measure the folded (">-") text in
    // UTF-8 bytes, the stricter of the two, and stay well under the cap.
    if (relPath.endsWith("SKILL.md")) {
      const start = lines.findIndex((l) => l.startsWith("description:"));
      if (start >= 0) {
        const inline = lines[start].slice("description:".length).trim();
        const body = [];
        if (inline && inline !== ">-" && inline !== ">" && inline !== "|") body.push(inline);
        for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) body.push(lines[i].trim());
        const bytes = Buffer.byteLength(body.join(" "), "utf8");
        if (bytes > MAX_DESCRIPTION_BYTES) {
          violations.push(`${relPath}: description is ${bytes} bytes; the Agent Skills cap is ${MAX_DESCRIPTION_BYTES}`);
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(`skills/check-skills.mjs: ${violations.length} problem(s) found:\n`);
    for (const v of violations) console.error(v);
    process.exit(1);
  }

  console.log(
    `skills/check-skills.mjs: clean -- ${files.length} file(s) scanned, no forbidden patterns, every tool-prefixed identifier is one of the 18 local tools.`,
  );
}

main();
