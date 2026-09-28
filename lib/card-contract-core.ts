// Titration card contract v1.
//
// Pure, import-clean normalization shared by every card writer. The database keeps `body` for
// semantic retrieval and backwards compatibility, while `sections` gives any consuming UI a stable,
// type-aware presentation contract. Missing evidence is made explicit; it is never invented.

export const CARD_CONTRACT_VERSION = 1 as const;

export const CARD_TYPES = [
  "METHOD",
  "FINDING",
  "REGRESSION",
  "MODEL_PROFILE",
  "PROMPT_BEHAVIOR",
  "DATASET_NOTE",
] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const CARD_STATUSES = ["active", "candidate", "superseded", "archived"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_CONFIDENCES = ["low", "medium", "high", "critical"] as const;
export type CardConfidence = (typeof CARD_CONFIDENCES)[number];

export interface CardSection {
  key: string;
  label: string;
  content: string;
}

export interface CardContractInput {
  type: unknown;
  title: unknown;
  body: unknown;
  tags?: unknown;
  confidence?: unknown;
  sample_size?: unknown;
  reproducibility?: unknown;
  status?: unknown;
  origin_ref?: unknown;
  card_ref?: unknown;
  sections?: unknown;
}

export interface CanonicalCardDraft {
  type: CardType;
  title: string;
  body: string;
  sections: CardSection[];
  tags: string[];
  confidence: CardConfidence | null;
  sample_size: string | null;
  reproducibility: string | null;
  status: CardStatus;
  origin_ref: string | null;
  card_ref?: string;
  contract_version: typeof CARD_CONTRACT_VERSION;
}

const TYPE_SECTIONS: Record<CardType, readonly string[]> = {
  METHOD: ["Summary", "Method", "Evidence", "Application"],
  FINDING: ["Summary", "Evidence", "Implication"],
  REGRESSION: ["Summary", "Reproduction", "Workaround", "Fixed-in"],
  MODEL_PROFILE: ["Summary", "Operational traits", "Known failure modes", "When to use / when to override"],
  PROMPT_BEHAVIOR: ["Summary", "Mechanism", "When to apply / when NOT to apply"],
  DATASET_NOTE: ["Summary", "Detail", "Implication"],
};

export const CARD_REF_PREFIXES: Record<CardType, string> = {
  METHOD: "T-MET",
  FINDING: "T-FND",
  REGRESSION: "T-REG",
  MODEL_PROFILE: "T-MOD",
  PROMPT_BEHAVIOR: "T-PRM",
  DATASET_NOTE: "T-DAT",
};

const TYPE_PRIMARY_SECTION: Record<CardType, string> = {
  METHOD: "Method",
  FINDING: "Evidence",
  REGRESSION: "Reproduction",
  MODEL_PROFILE: "Operational traits",
  PROMPT_BEHAVIOR: "Mechanism",
  DATASET_NOTE: "Detail",
};

const HEADING_ALIASES: Record<string, string> = {
  summary: "Summary",
  principle: "Summary",
  finding: "Summary",
  overview: "Summary",
  method: "Method",
  steps: "Method",
  procedure: "Method",
  evidence: "Evidence",
  metrics: "Evidence",
  application: "Application",
  "when to apply": "Application",
  implication: "Implication",
  "why it matters": "Implication",
  reproduction: "Reproduction",
  "how to reproduce": "Reproduction",
  workaround: "Workaround",
  mitigation: "Workaround",
  "fixed-in": "Fixed-in",
  "fixed in": "Fixed-in",
  "operational traits": "Operational traits",
  "known failure modes": "Known failure modes",
  "when to use / when to override": "When to use / when to override",
  "when to apply / when not to apply": "When to apply / when NOT to apply",
  mechanism: "Mechanism",
  detail: "Detail",
  "cross-references": "Cross-references",
  origin: "Origin",
};

function optionalText(value: unknown): string | null {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return text || null;
}

function sectionKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

function canonicalLabel(label: string): string {
  const trimmed = label.trim().replace(/\s+/g, " ");
  return HEADING_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function parseSectionArray(value: unknown): CardSection[] {
  if (!Array.isArray(value)) return [];
  const out: CardSection[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const label = canonicalLabel(String((raw as any).label ?? ""));
    const content = String((raw as any).content ?? "").trim();
    if (!label || !content) continue;
    out.push({ key: sectionKey(label), label, content });
  }
  return out;
}

function parseMarkdownSections(body: string): CardSection[] {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const heading = /^##\s+(.+?)\s*$/gm;
  const matches = [...text.matchAll(heading)];
  if (matches.length === 0) {
    // The curated base uses compact bold labels rather than H2 headings. Preserve those blocks while
    // mapping their labels into the same section vocabulary. Truly free-form prose becomes Summary.
    const boldBlocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
    const parsed: CardSection[] = [];
    let free = "";
    for (const block of boldBlocks) {
      const match = block.match(/^\*\*([^*]+?)\.?\*\*\s*([\s\S]*)$/);
      if (!match) {
        free += `${free ? "\n\n" : ""}${block}`;
        continue;
      }
      const label = canonicalLabel(match[1].replace(/\.$/, ""));
      const content = match[2].trim();
      if (content) parsed.push({ key: sectionKey(label), label, content });
    }
    if (free) parsed.unshift({ key: "summary", label: "Summary", content: free });
    return parsed.length ? parsed : [{ key: "summary", label: "Summary", content: text }];
  }

  const out: CardSection[] = [];
  const preamble = text.slice(0, matches[0].index).trim();
  if (preamble) out.push({ key: "summary", label: "Summary", content: preamble });
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const label = canonicalLabel(match[1]);
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const content = text.slice(start, end).trim();
    if (content) out.push({ key: sectionKey(label), label, content });
  }
  return out;
}

function mergeSections(sections: CardSection[]): CardSection[] {
  const order: string[] = [];
  const byLabel = new Map<string, CardSection>();
  for (const section of sections) {
    const label = canonicalLabel(section.label);
    const lookup = label.toLowerCase();
    const existing = byLabel.get(lookup);
    if (existing) {
      existing.content = `${existing.content}\n\n${section.content}`.trim();
    } else {
      order.push(lookup);
      byLabel.set(lookup, { key: sectionKey(label), label, content: section.content.trim() });
    }
  }
  return order.map((key) => byLabel.get(key)!).filter((section) => section.content);
}

export function normalizeCardType(value: unknown): CardType {
  const type = String(value ?? "").trim().toUpperCase().replace(/-/g, "_");
  if (!(CARD_TYPES as readonly string[]).includes(type)) {
    throw new Error(`invalid card type '${String(value ?? "")}' (one of ${CARD_TYPES.join(", ")})`);
  }
  return type as CardType;
}

export function requiredSectionsFor(type: CardType): readonly string[] {
  return TYPE_SECTIONS[type];
}

export function validateCardRef(type: CardType, value: unknown): string | undefined {
  const ref = optionalText(value) ?? undefined;
  if (!ref) return undefined;
  const prefix = CARD_REF_PREFIXES[type];
  if (!new RegExp(`^${prefix}-\\d{3,}$`).test(ref)) {
    throw new Error(`card_ref '${ref}' does not match type '${type}' (expected ${prefix}-NNN)`);
  }
  return ref;
}

export function normalizeCardSections(type: CardType, body: string, supplied?: unknown, title?: string): CardSection[] {
  const parsed = parseSectionArray(supplied);
  const parsedBody = parseMarkdownSections(body);
  const isFreeformBody = parsed.length === 0
    && !/^##\s+/m.test(body)
    && !/^\s*\*\*[^*]+?\.?\*\*/m.test(body);
  const source = mergeSections(isFreeformBody && title
    ? [
        { key: "summary", label: "Summary", content: title },
        { key: sectionKey(TYPE_PRIMARY_SECTION[type]), label: TYPE_PRIMARY_SECTION[type], content: body.trim() },
      ]
    : parsed.length ? parsed : parsedBody);
  const byLabel = new Map(source.map((section) => [section.label.toLowerCase(), section]));
  const required = TYPE_SECTIONS[type].map((label) => {
    const existing = byLabel.get(label.toLowerCase());
    if (existing) {
      byLabel.delete(label.toLowerCase());
      return { ...existing, key: sectionKey(label), label };
    }
    return { key: sectionKey(label), label, content: "Not recorded." };
  });
  const extras = source.filter((section) => byLabel.has(section.label.toLowerCase()));
  return [...required, ...extras];
}

export function renderCardBody(sections: readonly CardSection[]): string {
  return sections.map((section) => `## ${section.label}\n\n${section.content.trim()}`).join("\n\n").trim();
}

export function canonicalizeCard(input: CardContractInput): CanonicalCardDraft {
  const type = normalizeCardType(input.type);
  const title = optionalText(input.title);
  const rawBody = optionalText(input.body);
  if (!title || !rawBody) throw new Error("card title and body are required");

  const sections = normalizeCardSections(type, rawBody, input.sections, title);
  const confidenceText = optionalText(input.confidence)?.toLowerCase() ?? null;
  const confidence = confidenceText && (CARD_CONFIDENCES as readonly string[]).includes(confidenceText)
    ? confidenceText as CardConfidence
    : null;
  const statusWasSupplied = input.status !== undefined;
  const explicitStatus = optionalText(input.status)?.toLowerCase() ?? null;
  if (statusWasSupplied && !explicitStatus) {
    throw new Error(`invalid card status '${String(input.status)}' (one of ${CARD_STATUSES.join(", ")}; draft maps to candidate)`);
  }
  const normalizedStatus = explicitStatus === "draft" ? "candidate" : explicitStatus;
  if (normalizedStatus && !(CARD_STATUSES as readonly string[]).includes(normalizedStatus)) {
    throw new Error(`invalid card status '${explicitStatus}' (one of ${CARD_STATUSES.join(", ")}; draft maps to candidate)`);
  }
  const status = (normalizedStatus ?? "active") as CardStatus;
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((tag) => String(tag ?? "").trim()).filter(Boolean))]
    : [];
  const cardRef = validateCardRef(type, input.card_ref);

  return {
    type,
    title,
    body: renderCardBody(sections),
    sections,
    tags,
    confidence,
    sample_size: optionalText(input.sample_size),
    reproducibility: optionalText(input.reproducibility),
    status,
    origin_ref: optionalText(input.origin_ref),
    ...(cardRef ? { card_ref: cardRef } : {}),
    contract_version: CARD_CONTRACT_VERSION,
  };
}

export function isCanonicalSectionSet(type: CardType, sections: unknown): boolean {
  const parsed = parseSectionArray(sections);
  if (parsed.length === 0) return false;
  const labels = parsed.map((section) => section.label.toLowerCase());
  return TYPE_SECTIONS[type].every((label) => labels.includes(label.toLowerCase()));
}
