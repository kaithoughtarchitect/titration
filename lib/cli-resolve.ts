// Titration MCP — CLI "door" resolution (I/O: PATH walk + package metadata read).
//
// Resolves a CLI subscription door (codex, claude, grok) to a launchable
// executable without ever running it. An npm door (codex, claude) is only
// selected once its own package.json — found under a PATH directory's
// node_modules, per lib/cli-resolve-core.ts — has been read and its name/bin
// entry validated; a same-named executable sitting on PATH without that
// metadata is never eligible (PATH-shadowing defence). grok has no npm
// package to verify against and is resolved "native-unverified" — first
// existing `grok`/`grok.exe` on PATH. Never returns a `.cmd`/`.ps1` shim and
// never spawns anything itself (resolution only; lib/judge-doors.ts spawns).
//
// Failure is always `null`, never a throw — an unavailable door is expected
// (the user may not have that CLI installed) and callers decide what to
// do about it.

import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter } from "node:path";
import {
  DOOR_TABLE,
  absolutePathDirectories,
  codexVendorCandidates,
  launcherInvocation,
  nativeCandidatePaths,
  npmPackageJsonPath,
  packageRootOf,
  recordedVersion,
  validatedBinPath,
  type CliDoor,
  type NativeDoorSpec,
  type NpmDoorSpec,
  type ResolvedCli,
} from "./cli-resolve-core";

export interface CliResolveFs {
  readFile(path: string): Promise<string>;
  isExecutableFile(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
}

const defaultFs: CliResolveFs = {
  readFile: (path) => readFile(path, "utf8"),
  async isExecutableFile(path) {
    try {
      await access(path, constants.X_OK);
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
  async isFile(path) {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
};

export interface ResolveCliDoorOptions {
  searchPath?: string;
  platform?: string;
  arch?: string;
  execPath?: string;
  fs?: CliResolveFs;
}

async function resolveNativeDoor(
  door: CliDoor,
  spec: NativeDoorSpec,
  directories: string[],
  platform: string,
  fs: CliResolveFs,
): Promise<ResolvedCli | null> {
  for (const directory of directories) {
    for (const candidate of nativeCandidatePaths(directory, spec, platform)) {
      if (await fs.isFile(candidate)) {
        return { door, executable: candidate, prefixArgs: [], owner: spec.owner };
      }
    }
  }
  return null;
}

async function resolveNpmDoor(
  door: CliDoor,
  spec: NpmDoorSpec,
  directories: string[],
  platform: string,
  arch: string,
  execPath: string,
  fs: CliResolveFs,
): Promise<ResolvedCli | null> {
  for (const directory of directories) {
    const packageJsonPath = npmPackageJsonPath(directory, spec.packageName);
    let metadata: unknown;
    try {
      if (!(await fs.isFile(packageJsonPath))) continue;
      metadata = JSON.parse(await fs.readFile(packageJsonPath));
    } catch {
      // Unreadable or malformed metadata is not eligible. Keep searching —
      // a later PATH entry may still carry a valid installation.
      continue;
    }

    const declaredBinPath = validatedBinPath(metadata, spec);
    if (!declaredBinPath) continue;
    const invocation = launcherInvocation(packageJsonPath, declaredBinPath, execPath);
    if (!invocation) continue; // .cmd/.ps1 shim — never a valid launcher
    const launcherPath = invocation.prefixArgs[0] ?? invocation.executable;
    if (!(await fs.isExecutableFile(launcherPath))) continue;

    const version = recordedVersion(metadata);
    if (door === "codex") {
      const packageRoot = packageRootOf(packageJsonPath);
      for (const vendorPath of codexVendorCandidates(packageRoot, platform, arch)) {
        if (await fs.isExecutableFile(vendorPath)) {
          return { door, executable: vendorPath, prefixArgs: [], owner: "npm-verified", ...(version ? { version } : {}) };
        }
      }
    }
    return {
      door,
      executable: invocation.executable,
      prefixArgs: invocation.prefixArgs,
      owner: "npm-verified",
      ...(version ? { version } : {}),
    };
  }
  return null;
}

export async function resolveCliDoor(door: CliDoor, options: ResolveCliDoorOptions = {}): Promise<ResolvedCli | null> {
  const spec = DOOR_TABLE[door];
  const searchPath = options.searchPath ?? process.env.PATH ?? "";
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const execPath = options.execPath ?? process.execPath;
  const fs = options.fs ?? defaultFs;
  const directories = absolutePathDirectories(searchPath, delimiter);

  if (spec.kind === "native") {
    return resolveNativeDoor(door, spec, directories, platform, fs);
  }
  return resolveNpmDoor(door, spec, directories, platform, arch, execPath, fs);
}
