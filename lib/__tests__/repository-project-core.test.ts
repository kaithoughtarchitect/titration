// Production pure-core checks; no Git, network or DB.
import {
  deriveRepositoryProject, bindRepositoryProject, selectRepositoryRemote,
  repositoryLocalKey as localKey, repositoryRemoteKey as remoteKey,
} from "../repository-project-core";

// Sanitized observations: 13 synthetic repositories, 77 read-only Git commands,
// Git 2.47.0.windows.2. Common directories/local links/expanded URLs below replay
// those observations. Remote equivalence and anchor selection are policy, NOT
// network-certified hosting behavior. Extra error cases are pure simulations.
let total = 0, failures = 0;
function check(name: string, condition: boolean): void {
  total++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures++;
}
function refuse(): never { throw new Error("REPOSITORY_IDENTITY_UNRESOLVED"); }
function refused(name: string, run: () => unknown): void {
  try { run(); check(name, false); }
  catch (error) {
    check(name, error instanceof Error && error.message === "REPOSITORY_IDENTITY_UNRESOLVED");
  }
}

// Test-only adapter over already-verified metadata; not production traversal.
type Anchor = string | { local: Observation | null };
type Observation = { common: string; remotes: Record<string, Anchor> };
function identity(observation: Observation, seen = new Set<Observation>()): string {
  if (seen.has(observation)) return refuse();
  seen.add(observation);
  const selected = selectRepositoryRemote(Object.keys(observation.remotes));
  if (selected === null) return localKey(observation.common);
  const anchor = observation.remotes[selected];
  // Object links represent metadata-verified local targets, not guessed paths.
  if (typeof anchor === "string") return remoteKey(anchor);
  if (!anchor.local) return refuse();
  return identity(anchor.local, seen);
}
const common = (name: string) => `/fixtures/${name}/widget/.git`;
const source: Observation = { common: common("source"), remotes: {} };
const worktree: Observation = { common: source.common, remotes: {} };
const localClone: Observation = { common: common("local-clone"), remotes: { origin: { local: source } } };
const chain: Observation = { common: common("chain"), remotes: { origin: { local: localClone } } };
const https = "https://git.example.invalid/acme/widget.git";
const ssh = "git@git.example.invalid:acme/widget.git";
const other = "https://git.example.invalid/other/widget.git";
const httpsClone: Observation = { common: common("https"), remotes: { origin: https } };
const sshClone: Observation = { common: common("ssh"), remotes: { origin: ssh } };
const fork: Observation = { common: common("fork"), remotes: { origin: other, upstream: https } };
// Observed `remote get-url --all origin` expands fixture:widget.git via insteadOf.
const alias: Observation = { common: common("alias"), remotes: { origin: https } };
const multiple: Observation = { common: common("multiple"), remotes: { other, team: https } };
const removed: Observation = { common: common("removed"), remotes: {} };
const separateCopy: Observation = { common: common("copy"), remotes: {} };
const independent: Observation = { common: common("independent"), remotes: {} };
const changed: Observation = { common: common("changed"), remotes: { origin: "https://git.example.invalid/renamed/widget.git" } };

check("originless key pins canonical common-directory tuple", identity(source) === '["git-common-v1","/fixtures/source/widget/.git"]');
check("branch selection does not enter common-directory identity", identity(source) === identity({ ...source }));
check("subdirectory observation resolves to source common directory", identity({ common: source.common, remotes: {} }) === identity(source));
check("git-file worktree shares common directory", identity(worktree) === identity(source));
check("verified local clone link shares source", identity(localClone) === identity(source));
check("verified local clone chain shares source", identity(chain) === identity(source));
check("unqualified remote key preserves transport and exact path", identity(httpsClone) === '["git-remote-v2","https","git.example.invalid",null,"acme/widget.git"]');
check("observed unqualified SSH and HTTPS anchors remain separate", identity(httpsClone) !== identity(sshClone));
check("observed explicit Git URL expansion shares anchor", identity(alias) === identity(httpsClone));
check("fork origin wins over shared upstream and history", identity(fork) !== identity(httpsClone) && identity(fork) === remoteKey(other));
refused("distinct remotes without origin refuse", () => identity(multiple));
check("removed local origin no longer implies source relationship", identity(removed) === localKey(removed.common) && identity(removed) !== identity(source));
check("separate originless copy is not equated by shared history", identity(separateCopy) !== identity(source) && identity(separateCopy) !== identity(removed));
check("independent same-basename originless checkout stays separate", identity(independent) !== identity(source));
const before = identity({ common: changed.common, remotes: { origin: https } });
const after = identity(changed);
check("changed origin changes current key", before !== after && after === remoteKey(changed.remotes.origin as string));
check("captured scalar remains old identity after rediscovery", before === identity(httpsClone));
// No persistence exists in this test: no old-data deletion/reassignment is
// claimed tested. Captured jobs/baselines and storage are integration obligations.

// Pure contract simulations, not additional Git observations.
check("sole non-origin remote is selected", identity({ common: common("sole"), remotes: { team: https } }) === identity(httpsClone));
check("HTTPS credentials do not enter key", remoteKey("https://user:secret@git.example.invalid/acme/widget.git") === remoteKey(https));
check("SSH host case alone is cosmetic", remoteKey("ssh://user@GIT.EXAMPLE.INVALID/acme/widget.git") === remoteKey("ssh://user@git.example.invalid/acme/widget.git"));
check("unqualified HTTPS suffix remains meaningful", remoteKey("https://git.example.invalid/acme/widget") !== remoteKey(https));
for (const host of ["github.com", "gitlab.com"]) {
  const expected = remoteKey(`https://${host}/acme/widget.git`);
  check("qualified host retains established key", expected === JSON.stringify(["git-remote-v1", host, "acme/widget"]));
  for (const remote of [`https://${host}/acme/widget`, `https://user:secret@${host}/acme/widget.git`,
    `ssh://git@${host}/acme/widget.git`, `git@${host}:acme/widget.git`, `git@${host}:acme/widget`]) {
    check("qualified public-host forms share one anchor", remoteKey(remote) === expected);
  }
  for (const remote of [`ssh://${host}/acme/widget.git`, `ssh://other@${host}/acme/widget.git`,
    `${host}:acme/widget.git`, `other@${host}:acme/widget.git`]) {
    check("implicit or different SSH user does not inherit public-host equivalence", remoteKey(remote) !== expected);
  }
}
for (const [first, second] of [
  ["ssh://git.example.invalid/srv/repo", "git.example.invalid:srv/repo"],
  ["ssh://git.example.invalid/srv/repo", "ssh://git.example.invalid/srv/repo.git"],
  ["git.example.invalid:srv/repo", "git.example.invalid:srv/repo.git"],
  ["ssh://alice@git.example.invalid/srv/repo", "ssh://bob@git.example.invalid/srv/repo"],
  ["alice@git.example.invalid:srv/repo", "bob@git.example.invalid:srv/repo"],
  ["https://github.com.example.invalid/acme/widget.git", "git@github.com.example.invalid:acme/widget.git"],
  ["https://gitlab.example.invalid/acme/widget.git", "git@gitlab.example.invalid:acme/widget.git"],
]) {
  check("unqualified endpoint distinctions never collapse", remoteKey(first) !== remoteKey(second));
}
refused("SSH passwords are unsupported rather than erased", () => remoteKey("ssh://git:secret@github.com/acme/widget.git"));
check("repository path case remains meaningful", remoteKey("https://git.example.invalid/Acme/widget.git") !== remoteKey(https));
check("host remains meaningful", remoteKey("https://other.example.invalid/acme/widget.git") !== remoteKey(https));
refused("failed selected local link cannot fall back to upstream or common directory", () => identity({ common: source.common, remotes: { origin: { local: null }, upstream: https } }));
refused("unsupported origin cannot fall back to valid upstream", () => identity({ common: source.common, remotes: { origin: "fixture:widget.git", upstream: https } }));
const cycle: Observation = { common: common("cycle"), remotes: {} };
cycle.remotes.origin = { local: cycle };
refused("local link cycle refuses", () => identity(cycle));
for (const value of ["fixture:widget.git", "https://git.example.invalid:8443/acme/widget.git", "ssh://git@git.example.invalid:2222/acme/widget.git", "http://git.example.invalid/acme/widget.git", "https://git.example.invalid/acme/../widget", "https://git.example.invalid/acme//widget", "https://git.example.invalid/acme/widget?token=secret", "https://git.example.invalid/acme/%77idget", "", "../widget"]) {
  refused("unsupported or ambiguous representation refuses without echoing input", () => remoteKey(value));
}
// Digest and assertion cases are pure simulations, not filesystem/hash coverage.
function projectRefused(name: string, category: string, run: () => unknown): void {
  try { run(); check(name, false); }
  catch (error) {
    check(name, error instanceof Error && error.constructor === Error && error.message === category);
  }
}
const digest = "0123456789abcdef".repeat(4);
const project = deriveRepositoryProject(digest);
check("deterministic 63-character automatic slug", project === `repo-${digest.slice(0, 58)}` &&
  project.length === 63 && deriveRepositoryProject(digest) === project);
check("valid full digest suffix is validated but not included", deriveRepositoryProject(digest.slice(0, 58) + "ffffff") === project);
for (const value of [undefined, null, 42, false, {}, [], Symbol("digest"), "", "a".repeat(63), "a".repeat(65),
  "A".repeat(64), "g".repeat(64), digest.slice(0, 63) + "g", digest + "\n", " " + digest, digest + " "]) {
  projectRefused("invalid full digest refuses without coercion", "REPOSITORY_PROJECT_INVALID",
    () => deriveRepositoryProject(value as string));
}
for (const value of [undefined, null, 42, {}, "", "default", "__base__", "demo", "repo-" + "a".repeat(57),
  "repo-" + "a".repeat(59), "repo-" + "A".repeat(58), "repo-" + "g".repeat(58), project + "\n", ` ${project} `]) {
  projectRefused("derived scope must itself be automatic", "REPOSITORY_PROJECT_INVALID",
    () => bindRepositoryProject(value as string, undefined));
}
for (const supplied of [undefined, null, "", " \t\n ", project, ` ${project}\n`]) {
  for (const configured of [undefined, "", " \t\n ", project, ` ${project}\n`]) {
    check("omitted or matching independent assertions preserve derived scope",
      bindRepositoryProject(project, supplied, configured) === project);
  }
}
for (const invalid of [42, false, {}, [], Symbol("project"), 1n, () => project, "Bad Name", "a/b", "x".repeat(64)]) {
  projectRefused("invalid caller cannot fall back to matching config", "REPOSITORY_PROJECT_INVALID",
    () => bindRepositoryProject(project, invalid, project));
  projectRefused("matching caller cannot hide invalid config", "REPOSITORY_PROJECT_INVALID",
    () => bindRepositoryProject(project, project, invalid as string));
}
for (const conflict of ["other", "default", "__base__", ` ${deriveRepositoryProject("f".repeat(64))} `]) {
  projectRefused("conflicting caller cannot override matching config", "REPOSITORY_PROJECT_CONFLICT",
    () => bindRepositoryProject(project, conflict, project));
  projectRefused("matching caller cannot hide conflicting config", "REPOSITORY_PROJECT_CONFLICT",
    () => bindRepositoryProject(project, project, conflict));
}
const unexpected = new Error("unexpected normalization failure");
// Nonstring assertions must not have their conversion hooks invoked.
const hostile = { trim() { throw unexpected; }, toString() { throw unexpected; } };
projectRefused("nonstring hooks are never invoked", "REPOSITORY_PROJECT_INVALID",
  () => bindRepositoryProject(project, hostile));
refused("empty canonical common directory refuses", () => localKey(""));
check("empty remote list is explicit local selection", selectRepositoryRemote([]) === null);
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${total - failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
