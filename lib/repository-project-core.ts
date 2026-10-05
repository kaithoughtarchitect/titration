// Pure repository identity keys and automatic project assertions.
import { InvalidProjectError, resolveProject } from "./project-core";

function refuse(): never { throw new Error("REPOSITORY_IDENTITY_UNRESOLVED"); }

/** Validate the complete SHA-256 hex digest supplied by the I/O boundary. */
export function deriveRepositoryProject(identityDigestHex: string): string {
  if (typeof identityDigestHex !== "string" || identityDigestHex.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(identityDigestHex)) {
    throw new Error("REPOSITORY_PROJECT_INVALID");
  }
  return `repo-${identityDigestHex.slice(0, 58)}`;
}

/** Manual values are independent assertions, never overrides or fallbacks. */
export function bindRepositoryProject(
  derivedProject: string,
  suppliedProject: unknown,
  configuredProject?: string,
): string {
  if (typeof derivedProject !== "string" || derivedProject.length !== 63 ||
      !/^repo-[a-f0-9]{58}$/.test(derivedProject)) {
    throw new Error("REPOSITORY_PROJECT_INVALID");
  }
  for (const assertion of [suppliedProject, configuredProject]) {
    if (assertion === undefined || assertion === null ||
        (typeof assertion === "string" && !assertion.trim())) continue;
    let normalized: string;
    try {
      normalized = resolveProject(assertion);
    } catch (error) {
      if (error instanceof InvalidProjectError) throw new Error("REPOSITORY_PROJECT_INVALID");
      throw error;
    }
    if (normalized !== derivedProject) throw new Error("REPOSITORY_PROJECT_CONFLICT");
  }
  return derivedProject;
}

/** Names come from read-only metadata; null means no remote, not a failed lookup. */
export function selectRepositoryRemote(names: readonly string[]): string | null {
  if (names.includes("origin")) return "origin";
  if (!names.length) return null;
  if (names.length === 1) return names[0];
  return refuse();
}

// Pin a versioned, unambiguous tuple serialization; never basename or history.
// Input common directories are already canonical metadata, not raw caller paths.
export function repositoryLocalKey(common: string): string {
  if (typeof common !== "string" || !common.trim()) return refuse();
  return JSON.stringify(["git-common-v1", common]);
}
export function repositoryRemoteKey(value: string): string {
  // ceiling: conventional DNS host + ASCII repository path, HTTPS/SSH/SCP only;
  // upgrade: qualify additional URL forms before extending the supported forms.
  if (/[\s\\?#%]/.test(value)) return refuse();
  const url = /^(https|ssh):\/\/(?:([^/@:]+)(?::([^/@]*))?@)?([a-z0-9.-]+)(?::([0-9]+))?\/(.+)$/i.exec(value);
  const scp = /^(?:([^@/:]+)@)?([a-z0-9.-]+):([a-z0-9_./-]+)$/i.exec(value);
  if (!url && !scp) return refuse();
  const scheme = url ? url[1].toLowerCase() : "scp";
  const host = (url ? url[4] : scp![2]).toLowerCase();
  const user = scheme === "https" ? null : (url ? url[2] : scp![1]) ?? null;
  // Explicit ports and SSH passwords are unsupported, not silently erased.
  if (url?.[5] || (scheme === "ssh" && url?.[3] !== undefined)
      || !host.includes(".") || host.startsWith(".") || host.endsWith(".")) return refuse();
  let repo = url ? url[6] : scp![3];
  if (!/^[a-z0-9_./-]+$/i.test(repo)
      || repo.split("/").some(part => !part || part === "." || part === "..")) return refuse();
  // Only these public hosts have qualified cross-transport namespace semantics.
  // SSH requires explicit git user; no assumptions about ambient SSH configuration.
  if ((host === "github.com" || host === "gitlab.com") && (scheme === "https" || user === "git")) {
    if (repo.endsWith(".git")) repo = repo.slice(0, -4);
    if (repo.split("/").some(part => !part || part === "." || part === "..")) return refuse();
    return JSON.stringify(["git-remote-v1", host, repo]);
  }
  // Other hosts retain transport, SSH user, absolute-vs-home-relative syntax and
  // the .git suffix. Identical spellings share; unproven aliases may stay separate.
  return JSON.stringify(["git-remote-v2", scheme, host, user, repo]);
}
