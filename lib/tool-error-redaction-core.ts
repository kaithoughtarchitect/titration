// Titration MCP — tool-error text redaction (pure, import-clean).
//
// Scans a raw tool-error message for secret- and path-shaped substrings and redacts
// them before the message ever reaches a transcript or a model, so an error returned
// to an MCP caller gets the same defense-in-depth as observation text elsewhere in
// the pipeline.
//
// Import-clean: no imports, no Date.now/Math.random — safe for offline tests.

function fail(message: string): never {
  throw new Error(`tool error redaction invalid: ${message}`);
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

// Bounds how many redaction replacements a single scan performs before giving up.
const TOOL_ERROR_REDACTION_MAX_REPLACEMENTS = 16_384;

// The final-truncate bound `redactToolErrorText` applies.
const TOOL_ERROR_REDACTION_MAX_TEXT_LENGTH = 2_048;

const REDACTION_RULES: readonly RegExp[] = Object.freeze([
  /\b(?:authorization\s*:\s*)?basic\s+[A-Za-z0-9+/]+={0,2}(?![A-Za-z0-9+/=])/giu,
  /["']?\b(?:[A-Z][A-Z0-9_]*_)?(?:api[_-]?key|access[_-]?token|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|auth(?:orization)?[_-]?token|authorization|bearer|token|refresh[_-]?token|id[_-]?token|oauth[_-]?(?:token|secret)|password|passwd|passphrase|private[_-]?key|secret|credentials?|cookies?|session[_-]?(?:id|token|key|secret|cookie)|client[_-]?(?:id|secret)|database[_-]?url|db[_-]?url|redis[_-]?url|connection(?:[_-]|\s+)?(?:string|url|uri)|dsn)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/giu,
  /["']?\b(?:[A-Z][A-Z0-9_]*_)?(?:api[_-]?key|access[_-]?token|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|auth(?:orization)?[_-]?token|authorization|bearer|tokens?|refresh[_-]?token|id[_-]?token|oauth[_-]?(?:token|secret)|password|passwd|passphrase|private[_-]?key|secrets?|credentials?|cookies?|session[_-]?(?:id|token|key|secret|cookie)|client[_-]?(?:id|secret)|database[_-]?url|db[_-]?url|redis[_-]?url|connection(?:[_-]|\s+)?(?:string|url|uri)|dsn)\b["']?\s+(?:is|was)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu,
  /--(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|passphrase|secret|credential|cookie|session[_-]?(?:token|key|secret|cookie)|client[_-]?secret)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu,
  /\b(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|ACCESS_TOKEN|ACCESS_KEY(?:_ID)?|SECRET_ACCESS_KEY|AUTH(?:ORIZATION)?_TOKEN|TOKEN|REFRESH_TOKEN|ID_TOKEN|OAUTH_(?:TOKEN|SECRET)|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|SECRET|CREDENTIALS?|COOKIES?|SESSION_(?:ID|TOKEN|KEY|SECRET|COOKIE)|CLIENT_(?:ID|SECRET)|DATABASE_URL|DB_URL|REDIS_URL|CONNECTION_(?:STRING|URL|URI)|DSN)\b\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z0-9._~+/=-]{6,})/gu,
  /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/giu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\s*[:=]\s*[^\s,;]+/giu,
  /\b(?:secret|credential|canary)[-_][A-Za-z0-9_-]{6,}\b/giu,
  /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/gu,
  /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9.-])/giu,
]);

const NON_TOKEN_STRUCTURED_SECRET_LABEL = String.raw`(?:[A-Z][A-Z0-9_]*_)?(?:api(?:[_-]|\s+)?key|access(?:[_-]|\s+)?token|access(?:[_-]|\s+)?key(?:[_-]|\s+)?(?:id)?|secret(?:[_-]|\s+)?access(?:[_-]|\s+)?key|auth(?:orization)?(?:[_-]|\s+)?token|authorization|bearer|refresh(?:[_-]|\s+)?token|id(?:[_-]|\s+)?token|oauth(?:[_-]|\s+)?(?:token|secret)|password|passwd|passphrase|private(?:[_-]|\s+)?key|secrets?|credentials?|cookies?|session(?:[_-]|\s+)?(?:id|token|key|secret|cookie)|client(?:[_-]|\s+)?(?:id|secret)|database(?:[_-]|\s+)?url|db(?:[_-]|\s+)?url|redis(?:[_-]|\s+)?url|connection(?:[_-]|\s+)?(?:string|url|uri)|dsn)`;
const STRUCTURED_SECRET_LABEL = String.raw`(?:${NON_TOKEN_STRUCTURED_SECRET_LABEL}|tokens?)`;
const STRUCTURED_SECRET_STARTS: readonly RegExp[] = Object.freeze([
  /\b(?:Proxy-)?Authorization\s*:\s*/giu,
  /\b(?:api\.key|access\.token|private\.key)\b\s*(?:[:=]\s*|\s+(?:is|was)\s+)/giu,
  new RegExp(
    String.raw`["']?\b${STRUCTURED_SECRET_LABEL}\b["']?(?:\s*[:=]\s*|\s+(?:is|was)\s+|\s*[^\p{L}\p{N}\p{M}_\s]{1,3}\s*)`,
    "giu",
  ),
  new RegExp(
    String.raw`["']?\b(?:${NON_TOKEN_STRUCTURED_SECRET_LABEL}\b["']?\s+|tokens?\b["']?\s+(?!budget\b))`,
    "giu",
  ),
]);
const SAFE_STRUCTURED_CAUSAL_SUFFIX = /^[^\\/"'=;:]*$/u;
const STRUCTURED_CAUSAL_AT = /\s+(?:because|so that|in order to|due to)\b/iy;
const REDACTED = "[REDACTED]";

function appendRedactedSpan(
  parts: string[],
  text: string,
  copiedTo: number,
  start: number,
  end: number,
): number {
  parts.push(text.slice(copiedTo, start), REDACTED);
  return end;
}

function truncateCodePointSafe(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let end = maximum;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
  return value.slice(0, end);
}

function countRedaction(
  replacementCount: number,
  ceiling = TOOL_ERROR_REDACTION_MAX_REPLACEMENTS,
): number {
  const next = replacementCount + 1;
  // ceiling: stop during scanning before adversarial match counts can consume
  // unbounded CPU or memory. Upgrade path: replace this fixed cap only with a
  // streaming redactor that carries a shared, externally budgeted work quota.
  if (next > ceiling) return fail("redaction replacement count exceeds bounds");
  return next;
}

function structuredSecretEnd(text: string, valueStart: number): number {
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  let lineEnd = text.length;
  let causalStart = -1;
  let causalEnd = -1;
  let unsafeCausalSuffix = false;
  for (let index = valueStart; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === "\r" || character === "\n") {
      lineEnd = index;
      break;
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      if (causalStart >= 0) unsafeCausalSuffix = true;
      quote = character;
      continue;
    }
    if (causalStart >= 0 && "\\/=;:".includes(character)) {
      unsafeCausalSuffix = true;
    }
    if (!/\s/u.test(character)) continue;
    STRUCTURED_CAUSAL_AT.lastIndex = index;
    const delimiter = STRUCTURED_CAUSAL_AT.exec(text);
    if (delimiter) {
      causalStart = index;
      causalEnd = STRUCTURED_CAUSAL_AT.lastIndex;
      unsafeCausalSuffix = false;
      index = STRUCTURED_CAUSAL_AT.lastIndex - 1;
    }
  }
  if (quote !== null) return lineEnd;
  if (
    causalStart >= 0
    && !unsafeCausalSuffix
    && SAFE_STRUCTURED_CAUSAL_SUFFIX.test(text.slice(causalEnd, lineEnd))
    && isSafeCausalSuffix(text.slice(causalEnd, lineEnd))
  ) {
    return causalStart;
  }
  return lineEnd;
}

function redactStructuredSecrets(
  value: string,
  ceiling = TOOL_ERROR_REDACTION_MAX_REPLACEMENTS,
): Readonly<{ text: string; replacement_count: number }> {
  let text = value;
  let replacementCount = 0;
  for (const startRule of STRUCTURED_SECRET_STARTS) {
    const parts: string[] = [];
    let copiedTo = 0;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      startRule.lastIndex = searchFrom;
      const match = startRule.exec(text);
      if (!match) break;
      const start = match.index;
      const end = structuredSecretEnd(text, startRule.lastIndex);
      copiedTo = appendRedactedSpan(parts, text, copiedTo, start, end);
      replacementCount = countRedaction(replacementCount, ceiling);
      searchFrom = end;
    }
    if (parts.length > 0) text = `${parts.join("")}${text.slice(copiedTo)}`;
  }
  return freeze({ text, replacement_count: replacementCount });
}

function redactDelimitedSecrets(
  value: string,
  ceiling: number,
): Readonly<{ text: string; replacement_count: number }> {
  let text = value;
  let replacementCount = 0;
  const parts: string[] = [];
  let copiedTo = 0;
  let searchFrom = 0;
  const beginMarker = "-----BEGIN ";
  while (searchFrom < text.length) {
    const begin = text.indexOf(beginMarker, searchFrom);
    if (begin < 0) break;
    const headerLineEnd = text.indexOf("-----", begin + beginMarker.length);
    if (headerLineEnd < 0) break;
    const label = text.slice(begin + beginMarker.length, headerLineEnd);
    if (!/PRIVATE KEY(?: BLOCK)?$/u.test(label)) {
      searchFrom = headerLineEnd + 5;
      continue;
    }
    const footerMarker = `-----END ${label}-----`;
    const footer = text.indexOf(footerMarker, headerLineEnd + 5);
    if (footer < 0) break;
    const end = footer + footerMarker.length;
    copiedTo = appendRedactedSpan(parts, text, copiedTo, begin, end);
    replacementCount = countRedaction(replacementCount, ceiling);
    searchFrom = end;
  }
  if (parts.length > 0) text = `${parts.join("")}${text.slice(copiedTo)}`;
  const uriParts: string[] = [];
  copiedTo = 0;
  searchFrom = 0;
  while (searchFrom < text.length) {
    const marker = text.indexOf("://", searchFrom);
    if (marker < 0) break;
    let start = marker - 1;
    while (start >= 0 && /[A-Za-z0-9+.-]/u.test(text[start] as string)) start -= 1;
    start += 1;
    if (start === marker || !/[A-Za-z]/u.test(text[start] as string)) {
      searchFrom = marker + 3;
      continue;
    }
    let end = marker + 3;
    while (end < text.length && !/[\s<>"']/u.test(text[end] as string)) end += 1;
    if (end === marker + 3) {
      searchFrom = end;
      continue;
    }
    copiedTo = appendRedactedSpan(uriParts, text, copiedTo, start, end);
    replacementCount = countRedaction(replacementCount, ceiling);
    searchFrom = end;
  }
  if (uriParts.length > 0) text = `${uriParts.join("")}${text.slice(copiedTo)}`;
  const mailboxParts: string[] = [];
  copiedTo = 0;
  searchFrom = 0;
  let nextDomainLiteralEnd = -1;
  let domainLiteralsExhausted = false;
  const mailboxLocal = /[\p{L}\p{N}\p{M}._%+!#$&'*\/=?^`{|}~-]/u;
  const mailboxDomain = /[\p{L}\p{N}\p{M}.-]/u;
  while (searchFrom < text.length) {
    const marker = text.indexOf("@", searchFrom);
    if (marker < 0) break;
    let start = marker;
    if (text[marker - 1] === "\"") {
      start = marker - 2;
      while (start >= copiedTo && text[start] !== "\"" && text[start] !== "\n" && text[start] !== "\r") {
        start -= 1;
      }
      if (text[start] !== "\"") start = marker;
    } else {
      while (start > copiedTo && mailboxLocal.test(text[start - 1] as string)) start -= 1;
    }
    let end = marker + 1;
    if (text[end] === "[") {
      if (nextDomainLiteralEnd < end && !domainLiteralsExhausted) {
        nextDomainLiteralEnd = text.indexOf("]", end + 1);
        domainLiteralsExhausted = nextDomainLiteralEnd < 0;
      }
      const literalEnd = nextDomainLiteralEnd;
      end = literalEnd < 0 ? end : literalEnd + 1;
    } else {
      while (end < text.length && mailboxDomain.test(text[end] as string)) end += 1;
      while (end > marker + 1 && text[end - 1] === ".") end -= 1;
    }
    const domain = text.slice(marker + 1, end);
    if (start === marker || !domain || domain.startsWith(".") || domain.endsWith("-")) {
      searchFrom = marker + 1;
      continue;
    }
    copiedTo = appendRedactedSpan(mailboxParts, text, copiedTo, start, end);
    replacementCount = countRedaction(replacementCount, ceiling);
    searchFrom = end;
  }
  if (mailboxParts.length > 0) text = `${mailboxParts.join("")}${text.slice(copiedTo)}`;
  const identifierParts: string[] = [];
  copiedTo = 0;
  searchFrom = 0;
  const identifierCharacter = /[\p{L}\p{N}\p{M}.:%_-]/u;
  while (searchFrom < text.length) {
    if (!identifierCharacter.test(text[searchFrom] as string)) {
      searchFrom += 1;
      continue;
    }
    const start = searchFrom;
    while (searchFrom < text.length && identifierCharacter.test(text[searchFrom] as string)) {
      searchFrom += 1;
    }
    let end = searchFrom;
    while (end > start && text[end - 1] === ".") end -= 1;
    const token = text.slice(start, end);
    const validIpv4 = (value: string): boolean => {
      const parts = value.split(".");
      return parts.length === 4
        && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
    };
    const ipv4Port = token.match(/^(.+):(\d{1,5})$/u);
    const ipv4 = validIpv4(token)
      || Boolean(ipv4Port && validIpv4(ipv4Port[1] as string) && Number(ipv4Port[2]) <= 65_535);
    const zoneAt = token.indexOf("%");
    const address = zoneAt < 0 ? token : token.slice(0, zoneAt);
    const zoneValid = zoneAt < 0 || /^[\p{L}\p{N}_.-]+$/u.test(token.slice(zoneAt + 1));
    const mappedIpv4 = address.match(/^::ffff:(.+)$/iu);
    const colonCount = (address.match(/:/gu) ?? []).length;
    const colonIdentifier = token.length <= 128 && zoneValid && (
      (colonCount >= 2 && address.length >= 4 && (address.includes("::") || colonCount >= 5)
        && /^(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}$/iu.test(address))
      || Boolean(mappedIpv4 && validIpv4(mappedIpv4[1] as string))
    );
    const mac = /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/iu.test(token)
      || /^(?:[0-9a-f]{4}\.){2}[0-9a-f]{4}$/iu.test(token);
    const localHostPort = token.match(/^(.+\.local):(\d{1,5})$/iu);
    const localHost = token.length <= 259 && (
      /^[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}.-]*[\p{L}\p{N}\p{M}])?\.local$/iu.test(token)
      || Boolean(localHostPort
        && /^[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}.-]*[\p{L}\p{N}\p{M}])?\.local$/iu.test(localHostPort[1] as string)
        && Number(localHostPort[2]) <= 65_535)
    );
    if (!ipv4 && !colonIdentifier && !mac && !localHost) continue;
    copiedTo = appendRedactedSpan(identifierParts, text, copiedTo, start, end);
    replacementCount = countRedaction(replacementCount, ceiling);
  }
  if (identifierParts.length > 0) text = `${identifierParts.join("")}${text.slice(copiedTo)}`;
  return freeze({ text, replacement_count: replacementCount });
}

// Start at the first character of every supported locator form. In particular, the
// absolute-POSIX arm must consume the leading slash so a WSL path can never be
// reduced to a still-identifying prefix such as `/mnt/c`.
const PATH_WORD = /[\p{L}\p{N}\p{M}._~+-]/u;
const PATH_BOUNDARY = /[\s,;!?"'`)\]\r\n]/u;
const PATH_INTRODUCER = /(?:^|[^\p{L}\p{N}\p{M}])(?:use|open|inspect|read|remove|write|edit|check|load|save|at|in|on|from|under|inside|within|because|so\s+that|in\s+order\s+to|due\s+to|the\s+(?:file|folder|directory|path)|(?:i|we|you|they)\s+(?:found|saw|located))\s+$/iu;
const PATH_LABEL_INTRODUCER = /(?:^|[^\p{L}\p{N}\p{M}_])(?:path|cwd|file|folder|directory|location)\s*(?:(?:is|was)\s+|(?:[:=]|[^\p{L}\p{N}\p{M}_\s]{1,3})\s*)$/iu;
const STRUCTURAL_TITLE_START = /[\p{Lu}\p{Lt}\p{Lo}\p{N}\p{M}\p{So}\p{Sk}\[('&#@+]/u;
const PATH_WRAPPER_PAIRS: Readonly<Record<string, string>> = Object.freeze({
  "\"": "\"",
  "'": "'",
  "`": "`",
  "<": ">",
  "{": "}",
  "[": "]",
  "(": ")",
  "*": "*",
  "_": "_",
  "“": "”",
  "‘": "’",
  "«": "»",
});
const BENIGN_SLASH_TOKEN = /^(?:\d{1,4}\/\d{1,4}(?:\/\d{1,4})?|CI\/CD|HTTP\/\d(?:\.\d)?|yes\/no|read\/write|TCP\/IP)$/iu;

function hasBenignSlashContext(text: string, start: number, end: number): boolean {
  const prefix = text.slice(Math.max(0, start - 48), start);
  const suffix = text.slice(end, Math.min(text.length, end + 48));
  return !/(?:\b(?:use|open|inspect|read|remove|write|edit|load|save|path|cwd|file|folder|directory|location)\s+|[:=]\s*)$/iu.test(prefix)
    && /^(?:\s+(?:requests?|fail|fails|failed|crash|crashes|crashed|break|breaks|broke|access|work|works|worked|matter|matters|remain|remains|is|are|was|were|and)\b|[.,;!?](?:\s|$))/iu.test(suffix);
}
const CAUSAL_DELIMITER = /\s+(?:because|so that|in order to|due to)\b/giu;
const SENSITIVE_CAUSAL_SUFFIX = /[\\/]|\b[A-Za-z][A-Za-z0-9+.-]*:\/\/|\b(?:api[_-]?key|token|password|passwd|passphrase|secret|credential|authorization)\b\s*(?::|=|\bis\b)/iu;
const SAFE_CAUSAL_REASON_SIGNAL = /\b(?:am|are|is|was|were|be|been|being|can|could|do|does|did|has|have|had|may|might|must|need|needs|needed|should|will|would|fail|fails|failed|matter|matters|belong|belongs|resume|resumes|preserve|survive|disappear|start|change|changed|stale|missing|remain|remains|work|works|worked|require|requires|required|keep|keeps|kept|allow|allows|allowed|prevent|prevents|prevented|ensure|ensures|ensured|verified|timed|crashed|expired|stay|stays|avoid)\b/iu;

function isSafeCausalSuffix(value: string): boolean {
  const candidate = value.trim();
  if (!candidate || SENSITIVE_CAUSAL_SUFFIX.test(candidate)) return false;
  // A filename-like tail is ambiguous with a space-bearing path component.
  if (/(?:^|\s)[^\s]+\.[\p{L}\p{N}]{1,12}(?:[.!?])?$/u.test(candidate)) return false;
  const normalized = candidate.replace(/[.!?]+$/u, "").trim();
  return /^(?:retry|retries)$/iu.test(normalized)
    || SAFE_CAUSAL_REASON_SIGNAL.test(normalized)
    || /^(?:it|this|that|these|those|i|we|you|they|he|she|the\s+[\p{L}\p{N}\p{M}_-]+)\s+[\p{L}\p{M}_-]+(?:ed|ing|s)(?:\s+|$)/iu.test(normalized)
    || /^to\s+[\p{L}\p{M}_-]+(?:\s+|$)/iu.test(normalized);
}

function sentenceBoundary(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\r" || character === "\n") return index;
    if (
      (character === "."
        || character === "!"
        || character === "?"
        || character === ","
        || character === ";")
      && (index + 1 === text.length || /\s/u.test(text[index + 1] as string))
    ) {
      return index;
    }
  }
  return text.length;
}

function indexOfBefore(text: string, needle: string, start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if (text.startsWith(needle, index)) return index;
  }
  return -1;
}

function pathEnd(
  text: string,
  start: number,
  preserveCausalRationale: boolean,
): number {
  const forwardSlash = text.indexOf("/", start);
  const backslash = text.indexOf("\\", start);
  const firstSeparator = forwardSlash < 0
    ? backslash
    : backslash < 0 ? forwardSlash : Math.min(forwardSlash, backslash);
  const boundary = sentenceBoundary(
    text,
    firstSeparator >= 0 ? firstSeparator + 1 : start,
  );
  const opener = start > 0 ? text[start - 1] as string : "";
  const closer = PATH_WRAPPER_PAIRS[opener];
  if (closer) {
    const closingWrapper = indexOfBefore(text, closer, start, boundary);
    if (
      closingWrapper > firstSeparator
      && closingWrapper < boundary
    ) return closingWrapper;
  }
  if (!preserveCausalRationale) return boundary;

  const boundedCandidate = text.slice(start, boundary);
  CAUSAL_DELIMITER.lastIndex = 0;
  const delimiter = CAUSAL_DELIMITER.exec(boundedCandidate);
  if (!delimiter) return boundary;
  const delimiterIndex = start + delimiter.index;

  const rationaleCandidate = text.slice(
    delimiterIndex + delimiter[0].length,
    boundary,
  );
  if (isSafeCausalSuffix(rationaleCandidate)) {
    return delimiterIndex;
  }
  return boundary;
}

function structuralSpacedPath(
  text: string,
  from: number,
): RegExpExecArray | null {
  if (!text.includes("/", from) && !text.includes("\\", from)) return null;
  let introducedStart = -1;
  let generalStart = -1;
  let lineStart = from;
  let tokenStart = -1;
  let tokenTitle = false;
  let previousTokenTitle = false;
  for (let index = from; index < text.length; index += 1) {
    const character = String.fromCodePoint(text.codePointAt(index) as number);
    if (character === "\r" || character === "\n") {
      introducedStart = -1;
      generalStart = -1;
      lineStart = index + 1;
      tokenStart = -1;
      tokenTitle = false;
      previousTokenTitle = false;
      continue;
    }
    if (character === "/" || character === "\\") {
      let tokenEnd = index + 1;
      while (tokenEnd < text.length && /[\p{L}\p{N}.\/]/u.test(text[tokenEnd] as string)) {
        tokenEnd += 1;
      }
      let tokenBegin = index;
      while (tokenBegin > lineStart && /[\p{L}\p{N}.\/]/u.test(text[tokenBegin - 1] as string)) {
        tokenBegin -= 1;
      }
      if (BENIGN_SLASH_TOKEN.test(text.slice(tokenBegin, tokenEnd))
        && hasBenignSlashContext(text, tokenBegin, tokenEnd)) {
        tokenStart = -1;
        tokenTitle = false;
        previousTokenTitle = false;
        index = tokenEnd - 1;
        continue;
      }
      const generalHasSpace = generalStart >= 0
        && /[ \t]/u.test(text.slice(generalStart, index));
      let start = Math.max(
        introducedStart,
        generalHasSpace ? generalStart : -1,
      );
      const opener = start > 0 ? text[start - 1] as string : "";
      const closer = PATH_WRAPPER_PAIRS[opener];
      if (closer) {
        const wrapperBoundary = sentenceBoundary(text, index + 1);
        const closingWrapper = indexOfBefore(text, closer, start, wrapperBoundary);
        if (closingWrapper < index) start -= opener.length;
      }
      if (start < 0) {
        const root = text.slice(tokenStart >= 0 ? tokenStart : index, index).toLowerCase();
        if (root === "and" || root === "input") {
          introducedStart = -1;
          generalStart = -1;
          tokenStart = -1;
          tokenTitle = false;
          previousTokenTitle = false;
          continue;
        }
        const clauseStart = Math.max(
          lineStart,
          text.lastIndexOf(".", index - 1) + 1,
          text.lastIndexOf("!", index - 1) + 1,
          text.lastIndexOf("?", index - 1) + 1,
          text.lastIndexOf(";", index - 1) + 1,
        );
        const candidateStart = text.slice(clauseStart, index).search(/[\p{L}\p{N}\p{M}]/u);
        if (candidateStart >= 0) start = clauseStart + candidateStart;
      }
      if (start >= 0 && start < index) {
        const candidate = text.slice(start, index).trimEnd();
        if (candidate && candidate !== "and" && candidate !== "input") {
          const match = [candidate, candidate] as unknown as RegExpExecArray;
          match.index = start;
          match.input = text;
          return match;
        }
      }
      introducedStart = -1;
      generalStart = -1;
      tokenStart = -1;
      tokenTitle = false;
      previousTokenTitle = false;
      continue;
    }
    if (/\s/u.test(character)) {
      if (tokenStart >= 0) {
        previousTokenTitle = tokenTitle;
        tokenStart = -1;
      }
      const boundedPrefix = text.slice(Math.max(lineStart, index - 96), index + 1);
      if (PATH_INTRODUCER.test(boundedPrefix) || PATH_LABEL_INTRODUCER.test(boundedPrefix)) {
        introducedStart = index + 1;
      }
      continue;
    }
    if (character === ":" || character === "=" || character === "→") {
      const labelStart = text.slice(Math.max(lineStart, index - 96), index).search(
        /(?:^|[^\p{L}\p{N}\p{M}_])(?:path|cwd|file|folder|directory|location)\s*$/iu,
      );
      if (labelStart >= 0) {
        introducedStart = index + 1;
        tokenStart = -1;
        tokenTitle = false;
        previousTokenTitle = false;
        continue;
      }
    }
    if (tokenStart >= 0) continue;
    const boundedPrefix = text.slice(Math.max(lineStart, index - 96), index + 1);
    if (PATH_LABEL_INTRODUCER.test(boundedPrefix)) {
      introducedStart = index + 1;
      continue;
    }
    if (
      (index === lineStart || /\s/u.test(text[index - 1] as string))
      && !/[\p{L}\p{N}\p{M}]/u.test(character)
      && character !== "/"
      && character !== "\\"
    ) {
      if (introducedStart < 0 || introducedStart === index) {
        const closer = PATH_WRAPPER_PAIRS[character];
        introducedStart = closer ? index + character.length : index;
      }
      continue;
    }
    tokenStart = index;
    tokenTitle = STRUCTURAL_TITLE_START.test(character);
    if (tokenTitle) {
      if (!previousTokenTitle) generalStart = index;
    } else {
      generalStart = -1;
    }
  }
  return null;
}

function structuralRegularPath(text: string, from: number): RegExpExecArray | null {
  if (!text.includes("/", from) && !text.includes("\\", from)) return null;
  let benignUntil = from;
  for (let index = from; index < text.length; index += 1) {
    if (index < benignUntil) continue;
    const character = text[index] as string;
    const previous = index === 0 ? "" : text[index - 1] as string;
    const boundary = index === 0 || !/[\p{L}\p{N}\p{M}._~+:/-]/u.test(previous);
    if (!boundary) continue;
    let end = index;
    if (text.startsWith("\\\\", index) || text.startsWith("//", index)) end = index + 2;
    else if (character === "/" || character === "\\") end = index + 1;
    else if (text.startsWith("../", index) || text.startsWith("..\\", index)) end = index + 3;
    else if ((character === "." || character === "~")
      && (text[index + 1] === "/" || text[index + 1] === "\\")) end = index + 2;
    else if (/[A-Za-z]/u.test(character) && text[index + 1] === ":") {
      end = index + 2;
      if (text[end] === "/" || text[end] === "\\") end += 1;
    } else {
      while (end < text.length && PATH_WORD.test(text[end] as string)) end += 1;
      if (end === index || (text[end] !== "/" && text[end] !== "\\")) continue;
      let tokenEnd = end + 1;
      while (tokenEnd < text.length && /[\p{L}\p{N}.\/]/u.test(text[tokenEnd] as string)) {
        tokenEnd += 1;
      }
      if (BENIGN_SLASH_TOKEN.test(text.slice(index, tokenEnd))
        && hasBenignSlashContext(text, index, tokenEnd)) {
        benignUntil = tokenEnd;
        continue;
      }
      const root = text.slice(index, end).toLowerCase();
      if (root === "and" || root === "input") continue;
      end += 1;
    }
    let scan = end;
    while (scan < text.length && !PATH_BOUNDARY.test(text[scan] as string)) scan += 1;
    if (scan <= end && !text.startsWith(REDACTED, end)) continue;
    const match = [text.slice(index, end)] as unknown as RegExpExecArray;
    match.index = index;
    match.input = text;
    return match;
  }
  return null;
}

function structuralRemotePath(text: string, from: number): RegExpExecArray | null {
  if (!text.includes("/", from) && !text.includes("\\", from)) return null;
  let nextClosingBracket = -1;
  let bracketsExhausted = false;
  for (let index = from; index < text.length; index += 1) {
    if (index > 0 && /[\p{L}\p{N}\p{M}._~-]/u.test(text[index - 1] as string)) continue;
    let cursor = index;
    if (text[cursor] === "[") {
      if (nextClosingBracket < cursor && !bracketsExhausted) {
        nextClosingBracket = text.indexOf("]", cursor + 1);
        bracketsExhausted = nextClosingBracket < 0;
      }
      if (nextClosingBracket < 0) continue;
      cursor = nextClosingBracket + 1;
    }
    while (cursor < text.length && /[\p{L}\p{N}\p{M}._~-]/u.test(text[cursor] as string)) cursor += 1;
    if (text[cursor] === "@") {
      cursor += 1;
      if (text[cursor] === "[") {
        if (nextClosingBracket < cursor && !bracketsExhausted) {
          nextClosingBracket = text.indexOf("]", cursor + 1);
          bracketsExhausted = nextClosingBracket < 0;
        }
        const bracketEnd = nextClosingBracket;
        if (bracketEnd < 0) continue;
        cursor = bracketEnd + 1;
      } else {
        while (cursor < text.length && /[\p{L}\p{N}\p{M}._~-]/u.test(text[cursor] as string)) cursor += 1;
      }
    }
    if (cursor === index || text[cursor] !== ":") continue;
    let scan = cursor + 1;
    if (scan >= text.length || /\s/u.test(text[scan] as string)) continue;
    while (scan < text.length && !/[\s,;!?"')\]]/u.test(text[scan] as string)) {
      if (text[scan] === "/" || text[scan] === "\\") {
        const match = [text.slice(index, scan + 1)] as unknown as RegExpExecArray;
        match.index = index;
        match.input = text;
        return match;
      }
      scan += 1;
    }
  }
  return null;
}

function redactPaths(
  value: string,
  preserveCausalRationale: boolean,
  ceiling = TOOL_ERROR_REDACTION_MAX_REPLACEMENTS,
): Readonly<{ text: string; replacement_count: number }> {
  const text = value;
  const parts: string[] = [];
  let copiedTo = 0;
  let replacementCount = 0;
  let searchFrom = 0;
  let regularMatch: RegExpExecArray | null = null;
  let spacedMatch: RegExpExecArray | null = null;
  let scpMatch: RegExpExecArray | null = null;
  let regularExhausted = false;
  let spacedExhausted = false;
  let scpExhausted = false;
  while (searchFrom < text.length) {
    if (regularMatch === null && !regularExhausted) {
      regularMatch = structuralRegularPath(text, searchFrom);
      regularExhausted = regularMatch === null;
    }
    if (spacedMatch === null && !spacedExhausted) {
      spacedMatch = structuralSpacedPath(text, searchFrom);
      spacedExhausted = spacedMatch === null;
    }
    if (scpMatch === null && !scpExhausted) {
      scpMatch = structuralRemotePath(text, searchFrom);
      scpExhausted = scpMatch === null;
    }
    if (!regularMatch && !spacedMatch && !scpMatch) break;
    const spacedPath = spacedMatch?.slice(1).find((capture) => capture !== undefined) ?? null;
    const spacedStart = spacedMatch && spacedPath !== null
      ? spacedMatch.index + spacedMatch[0].lastIndexOf(spacedPath)
      : Number.POSITIVE_INFINITY;
    const regularStart = regularMatch?.index ?? Number.POSITIVE_INFINITY;
    const scpStart = scpMatch?.index ?? Number.POSITIVE_INFINITY;
    const start = Math.min(regularStart, spacedStart, scpStart);
    const end = pathEnd(text, start, preserveCausalRationale);
    copiedTo = appendRedactedSpan(parts, text, copiedTo, start, end);
    replacementCount = countRedaction(replacementCount, ceiling);
    if (regularMatch !== null && regularStart < end) regularMatch = null;
    if (spacedMatch !== null && spacedStart < end) spacedMatch = null;
    if (scpMatch !== null && scpStart < end) scpMatch = null;
    searchFrom = end;
  }
  return freeze({
    text: parts.length === 0 ? text : `${parts.join("")}${text.slice(copiedTo)}`,
    replacement_count: replacementCount,
  });
}

// Judge model ids such as `google/gemini-3.8-flash` are vendor/model slugs, not
// filesystem paths, but their slash makes the path passes treat them (and the
// clause around them) as a locator — which blanks the very judge a panel error
// is about. A slug with a known vendor prefix is swapped for an inert placeholder
// before redaction and restored after; one whose model part looks like a secret
// is left to the normal passes. A placeholder that ends up inside a redacted span
// disappears with it.
const MODEL_VENDOR_PREFIXES = "openai|google|deepseek|z-ai|x-ai|moonshotai|qwen|meta|meta-llama|minimax|anthropic|mistralai|cohere|nvidia|amazon|microsoft";
const MODEL_SLUG = new RegExp(
  String.raw`(?<![\p{L}\p{N}\p{M}._~+:/\\-])(?:${MODEL_VENDOR_PREFIXES})/[a-z0-9][a-z0-9._:-]*(?![\p{L}\p{N}\p{M}/\\])`,
  "gu",
);
const SLUG_OPEN = "";
const SLUG_CLOSE = "";

function looksSecret(value: string): boolean {
  return REDACTION_RULES.some((rule) => {
    rule.lastIndex = 0;
    const hit = rule.test(value);
    rule.lastIndex = 0;
    return hit;
  });
}

function protectModelSlugs(value: string): { text: string; slugs: string[] } {
  const slugs: string[] = [];
  const text = value.replace(MODEL_SLUG, (slug) => {
    if (looksSecret(slug.slice(slug.indexOf("/") + 1))) return slug;
    slugs.push(slug);
    return `${SLUG_OPEN}${slugs.length - 1}${SLUG_CLOSE}`;
  });
  return { text, slugs };
}

function restoreModelSlugs(value: string, slugs: readonly string[]): string {
  return value
    .replace(new RegExp(`${SLUG_OPEN}(\\d+)${SLUG_CLOSE}`, "gu"), (_, index: string) => slugs[Number(index)] ?? "")
    .replace(new RegExp(`[${SLUG_OPEN}${SLUG_CLOSE}]\\d*`, "gu"), "");
}

// Pass order: model-slug protection → delimited secrets → structured secrets →
// REDACTION_RULES → paths (causal-rationale-preserving pass, then a default-deny
// residual pass) → whitespace-normalize → truncate → slug restore. Returns text
// only — no rationale array — because a tool-error string has no rationale-clause
// contract to preserve.
export function redactToolErrorText(value: string): string {
  if (typeof value !== "string") return fail("tool error text must be text");
  const protectedSlugs = protectModelSlugs(value);
  let text = protectedSlugs.text;
  let replacementCount = 0;
  const delimitedRedaction = redactDelimitedSecrets(
    text,
    TOOL_ERROR_REDACTION_MAX_REPLACEMENTS,
  );
  text = delimitedRedaction.text;
  replacementCount += delimitedRedaction.replacement_count;
  const structuredRedaction = redactStructuredSecrets(
    text,
    TOOL_ERROR_REDACTION_MAX_REPLACEMENTS - replacementCount,
  );
  text = structuredRedaction.text;
  replacementCount += structuredRedaction.replacement_count;
  for (const rule of REDACTION_RULES) {
    text = text.replace(rule, (match) => {
      replacementCount = countRedaction(replacementCount);
      const leadingSpace = match.startsWith(" ") ? " " : "";
      return `${leadingSpace}[REDACTED]`;
    });
  }
  const pathRedaction = redactPaths(
    text,
    true,
    TOOL_ERROR_REDACTION_MAX_REPLACEMENTS - replacementCount,
  );
  text = pathRedaction.text;
  replacementCount += pathRedaction.replacement_count;

  // Default-deny guard: if a path-shaped locator survived the first pass,
  // discard its whole sentence remainder rather than risk leaking a partial
  // drive, UNC, or private POSIX path.
  const residualPathRedaction = redactPaths(
    text,
    false,
    TOOL_ERROR_REDACTION_MAX_REPLACEMENTS - replacementCount,
  );
  text = residualPathRedaction.text;
  replacementCount += residualPathRedaction.replacement_count;
  const normalized = text.replace(/\s+/gu, " ").trim();
  const restored = restoreModelSlugs(normalized, protectedSlugs.slugs);
  return truncateCodePointSafe(restored, TOOL_ERROR_REDACTION_MAX_TEXT_LENGTH);
}
