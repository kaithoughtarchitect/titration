// Titration MCP — CLI "door" resolution (PURE, import-clean).
//
// Resolves any CLI subscription
// door judges can call: an npm-distributed CLI (codex, claude) or a
// native-only CLI with no npm package to verify against (grok). The shared
// rule across doors: a PATH entry is never trusted by name alone — an npm
// door is only selected once its declared package metadata (name + bin
// entry) is found and matches, so a same-named shadow executable earlier on
// PATH can never be picked up as if it were the real door (PATH-shadowing
// defence). All filesystem access lives in lib/cli-resolve.ts; this module
// only computes candidate paths and validates recorded metadata shapes.

import { dirname, isAbsolute, join, delimiter as pathDelimiter } from "node:path";

export type CliDoor = "codex" | "claude" | "grok";
export type CliOwner = "npm-verified" | "native-unverified";

export interface NpmDoorSpec {
  readonly kind: "npm";
  readonly packageName: string; // e.g. "@openai/codex" — must match package.json#name exactly
  readonly binKey: string;      // key into package.json#bin, e.g. "codex"
}

export interface NativeDoorSpec {
  readonly kind: "native";
  readonly baseName: string;    // e.g. "grok" — no npm package exists to verify ownership against
  readonly owner: "native-unverified";
}

export type DoorSpec = NpmDoorSpec | NativeDoorSpec;

// codex and claude ship as npm packages we can verify by name; grok is a
// native-only CLI (no npm metadata exists to check), so it is trusted only
// as "native-unverified" — callers that need stronger provenance for grok
// must add their own check; this resolver cannot manufacture one.
export const DOOR_TABLE: Readonly<Record<CliDoor, DoorSpec>> = Object.freeze({
  codex: Object.freeze({ kind: "npm", packageName: "@openai/codex", binKey: "codex" }),
  claude: Object.freeze({ kind: "npm", packageName: "@anthropic-ai/claude-code", binKey: "claude" }),
  grok: Object.freeze({ kind: "native", baseName: "grok", owner: "native-unverified" }),
});

export interface ResolvedCli {
  door: CliDoor;
  executable: string;
  prefixArgs: string[];
  owner: CliOwner;
  version?: string;
}

interface RecordedPackageMetadata {
  name?: unknown;
  version?: unknown;
  bin?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

// Pure: absolute PATH directories only, in original order, blanks dropped.
// A relative PATH entry cannot be resolved without a cwd assumption the
// resolver never makes, so it is simply ignored (never eligible).
export function absolutePathDirectories(searchPath: string, delim: string = pathDelimiter): string[] {
  return searchPath.split(delim).filter((dir) => dir.length > 0 && isAbsolute(dir));
}

// Pure: where an npm door's package.json would live under a PATH directory,
// assuming that directory is an npm global-install prefix (the bin shim and
// its node_modules are siblings there) — true for both codex and claude on
// this machine (probed): the PATH entry carrying the shim also carries
// `node_modules/<pkg>/package.json` for that exact package.
export function npmPackageJsonPath(directory: string, packageName: string): string {
  return join(directory, "node_modules", ...packageName.split("/"), "package.json");
}

export function packageRootOf(packageJsonPath: string): string {
  return dirname(packageJsonPath);
}

// Pure: validates parsed package metadata against the expected door spec.
// Returns the declared launcher's package-relative path (e.g. "bin/codex.js")
// or null when the name doesn't match or no matching bin entry exists.
// Name-only or bin-only agreement is not enough (mirrors the original: package
// name alone does not validate its launcher).
export function validatedBinPath(metadata: unknown, spec: NpmDoorSpec): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as RecordedPackageMetadata;
  if (record.name !== spec.packageName) return null;
  const bin = record.bin;
  if (!bin || typeof bin !== "object") return null;
  const declared = bin[spec.binKey];
  if (typeof declared !== "string" || declared.length === 0) return null;
  return declared;
}

export function recordedVersion(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const version = (metadata as RecordedPackageMetadata).version;
  return typeof version === "string" && version.length > 0 ? version : undefined;
}

// Pure: resolves the declared bin path (relative to the package root, i.e.
// dirname(packageJsonPath)) into an absolute launcher path plus how to run
// it. A ".js" launcher runs through the current Node binary (never spawned
// directly); anything else is the executable itself. A `.cmd`/`.ps1` shim is
// never a valid launcher here — refused outright rather than routed through
// a shell.
export function launcherInvocation(
  packageJsonPath: string,
  declaredBinPath: string,
  execPath: string,
): { executable: string; prefixArgs: string[] } | null {
  if (/\.(cmd|ps1)$/i.test(declaredBinPath)) return null;
  const launcher = join(packageRootOf(packageJsonPath), declaredBinPath);
  if (/\.js$/i.test(launcher)) return { executable: execPath, prefixArgs: [launcher] };
  return { executable: launcher, prefixArgs: [] };
}

// codex-only native-vendor optimization, kept from the original resolver: a
// matching vendor/<arch>-<suffix>/{bin,codex}/codex(.exe) build, if present,
// runs directly with no Node startup cost. Pure: returns the ordered list of
// paths to probe, the optional per-platform package's vendor tree first
// (mirrors the original's `roots.unshift` when the optional dependency is
// declared), then the base package's own vendor tree.
//
// Simplification vs. the original: the optional per-platform package root is
// assumed to be nested at packageRoot/node_modules/@openai/codex-<platform>-
// <arch> rather than resolved via `createRequire(...).resolve()`. If npm
// hoists that optional dependency elsewhere, this probe misses it and falls
// through to the safe, always-correct portable Node launcher — never a wrong
// binary. ceiling: no hoisted-optional-dependency resolution; upgrade: pass
// a require-resolve adapter into the I/O layer if a hoisted layout is seen.
export const VENDOR_ARCH: Readonly<Partial<Record<string, string>>> = Object.freeze({ x64: "x86_64", arm64: "aarch64" });
export const VENDOR_SUFFIX: Readonly<Partial<Record<string, string>>> = Object.freeze({
  win32: "pc-windows-msvc",
  linux: "unknown-linux-musl",
  darwin: "apple-darwin",
});

export function codexVendorCandidates(packageRoot: string, platform: string, arch: string): string[] {
  const vendorArch = VENDOR_ARCH[arch];
  const suffix = VENDOR_SUFFIX[platform];
  if (!vendorArch || !suffix) return [];
  const binName = platform === "win32" ? "codex.exe" : "codex";
  const optionalRoot = join(packageRoot, "node_modules", "@openai", `codex-${platform}-${arch}`);
  const roots = [optionalRoot, packageRoot];
  const candidates: string[] = [];
  for (const root of roots) {
    for (const layout of ["bin", "codex"]) {
      candidates.push(join(root, "vendor", `${vendorArch}-${suffix}`, layout, binName));
    }
  }
  return candidates;
}

// Pure: native-only doors (grok) resolve directly by filename under a PATH
// dir — there is no package metadata to verify ownership against, so this is
// necessarily "native-unverified" (DOOR_TABLE.grok.owner).
export function nativeCandidatePaths(directory: string, spec: NativeDoorSpec, platform: string): string[] {
  const names = platform === "win32" ? [`${spec.baseName}.exe`, spec.baseName] : [spec.baseName];
  return names.map((name) => join(directory, name));
}
