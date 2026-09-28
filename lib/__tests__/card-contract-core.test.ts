import {
  CARD_CONTRACT_VERSION,
  canonicalizeCard,
  isCanonicalSectionSet,
  normalizeCardType,
  requiredSectionsFor,
} from "../card-contract-core";

let failures = 0;
let total = 0;
function check(name: string, condition: boolean, detail = "") {
  total++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  ${detail}`}`);
  if (!condition) failures++;
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

check("type aliases normalize", normalizeCardType("prompt-behavior") === "PROMPT_BEHAVIOR");
check("invalid type throws", throws(() => normalizeCardType("memo")));
check("empty title throws", throws(() => canonicalizeCard({ type: "METHOD", title: " ", body: "x" })));
check("empty body throws", throws(() => canonicalizeCard({ type: "METHOD", title: "x", body: " " })));

const plain = canonicalizeCard({
  type: "method",
  title: "  Keep one contract  ",
  body: "A plain legacy paragraph.",
  tags: ["contract", "contract", "  evidence  ", ""],
  confidence: "HIGH",
});
check("contract version pinned", plain.contract_version === CARD_CONTRACT_VERSION);
check("title trimmed", plain.title === "Keep one contract");
check("tags trimmed and deduped", plain.tags.join(",") === "contract,evidence");
check("confidence normalized", plain.confidence === "high");
check("methodology draft status maps safely to candidate", canonicalizeCard({ type: "METHOD", title: "Draft", body: "Unapproved method", status: "draft" }).status === "candidate");
check("invalid explicit status throws instead of publishing active", throws(() => canonicalizeCard({ type: "METHOD", title: "Typo", body: "x", status: "canddiate" })));
check("strict matching card ref accepted", canonicalizeCard({ type: "METHOD", title: "Ref", body: "x", card_ref: "T-MET-001" }).card_ref === "T-MET-001");
check("mismatched card ref type throws", throws(() => canonicalizeCard({ type: "METHOD", title: "Ref", body: "x", card_ref: "T-FND-001" })));
check("malformed card ref suffix throws", throws(() => canonicalizeCard({ type: "METHOD", title: "Ref", body: "x", card_ref: "T-MET-001-extra" })));
check("plain card title becomes the concise Summary", plain.sections[0].label === "Summary" && plain.sections[0].content === "Keep one contract");
check("plain METHOD prose becomes Method content", plain.sections[1].label === "Method" && plain.sections[1].content === "A plain legacy paragraph.");
check("METHOD receives every required section", isCanonicalSectionSet("METHOD", plain.sections));
check("missing evidence is explicit", plain.sections.find((section) => section.label === "Evidence")?.content === "Not recorded.");
check("canonical markdown rendered", plain.body.startsWith("## Summary\n\nKeep one contract\n\n## Method\n\nA plain legacy paragraph."));

for (const [type, primary] of [
  ["FINDING", "Evidence"],
  ["REGRESSION", "Reproduction"],
  ["MODEL_PROFILE", "Operational traits"],
  ["PROMPT_BEHAVIOR", "Mechanism"],
  ["DATASET_NOTE", "Detail"],
] as const) {
  const card = canonicalizeCard({ type, title: `${type} title`, body: `${type} legacy prose` });
  check(`${type} plain prose maps to ${primary}`, card.sections.find((section) => section.label === primary)?.content === `${type} legacy prose`);
}

const headed = canonicalizeCard({
  type: "FINDING",
  title: "Measured result",
  body: "Intro context.\n\n## Evidence\n\nn=20, two vendors.\n\n## Implication\n\nKeep the gate.",
  sample_size: " n=20 ",
  reproducibility: "high",
  origin_ref: " RUN-123 ",
});
check("preamble becomes Summary", headed.sections[0].content === "Intro context.");
check("existing Evidence preserved", headed.sections[1].content === "n=20, two vendors.");
check("evidence metadata trimmed", headed.sample_size === "n=20" && headed.origin_ref === "RUN-123");

const curated = canonicalizeCard({
  type: "METHOD",
  title: "Curated method",
  body: "**Principle.** Apply the stable rule.\n\n**Why it matters.** It prevents drift.\n\n**Illustrative (one domain).** A neutral example.",
});
check("bold Principle maps to Summary", curated.sections[0].content === "Apply the stable rule.");
check("bold Why it matters maps to an explicit semantic section", curated.sections.some((section) => section.content === "It prevents drift."));
check("unrecognized bold block is preserved", curated.sections.some((section) => /Illustrative/.test(section.label)));

const supplied = canonicalizeCard({
  type: "DATASET_NOTE",
  title: "Corpus note",
  body: "legacy body",
  sections: [
    { label: "Summary", content: "Structured summary" },
    { label: "Detail", content: "Structured detail" },
    { label: "Implication", content: "Structured implication" },
  ],
});
check("supplied structured sections are authoritative", supplied.sections[0].content === "Structured summary");
check("required-section order is deterministic", supplied.sections.map((section) => section.label).join("|") === requiredSectionsFor("DATASET_NOTE").join("|"));

console.log(`\n${total - failures}/${total} card-contract-core asserts passed`);
process.exit(failures ? 1 : 0);
