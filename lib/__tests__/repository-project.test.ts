// Retained context qualification plus public resolver tests using read-only Git.
import { createRepositoryProjectResolver } from "../repository-project";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deriveRepositoryProject, repositoryLocalKey, repositoryRemoteKey } from "../repository-project-core";
// Recorded native fixture: Cursor desktop 3.17.19 (Windows x64), wire client
// cursor-vscode/1.0.0, protocol 2025-11-25, global config, 2026-10-04T22:03:40Z.
// Native roots/list returned an absolute Windows path; SDK 1.30.1 rejected it.
// Below: sanitized REPLAY via actual SDK transport, NOT another native observation.
// All other cases are labelled simulations; product/storage proof is separate.
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ErrorCode, ListRootsRequestSchema, ListRootsResultSchema, McpError,
  ResourceSchema, RootSchema, RootsListChangedNotificationSchema,
  type ClientCapabilities, type Result,
} from "@modelcontextprotocol/sdk/types.js";

let total = 0, failures = 0;
function check(name: string, condition: boolean, detail = "") {
  total++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : ` — ${detail}`}`);
  if (!condition) failures++;
}
async function refused(name: string, run: () => unknown, category?: string) {
  try { await run(); check(name, false, "unexpected acceptance"); }
  catch (error) {
    check(name, error instanceof Error && (!category || error.message === category),
      error instanceof Error ? error.message : "non-Error rejection");
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Private feasibility prototype: platform semantics are explicit, never client-name
// dispatch. Raw path percent signs are literal; URI percent escapes are decoded once.
function localFileUri(value: string, windows: boolean): string {
  try {
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
    let localPath = value;
    if (/^file:/i.test(value)) {
      if (!/^file:\/\/(?:localhost)?\//i.test(value) || /[\\?#\s]/.test(value)
          || /%(?![\da-f]{2})/i.test(value)) throw new Error();
      const decoded = decodeURIComponent(value.replace(/^file:\/\/(?:localhost)?/i, ""));
      // Check before WHATWG parsing can erase dot segments or repair drive syntax.
      if (decoded.startsWith("//") || decoded.split("/").some(p => p === "." || p === "..")
          || (windows && !/^\/[a-z]:\//i.test(decoded))) throw new Error();
      const uri = new URL(value);
      if (uri.hostname || uri.username || uri.password || uri.port || uri.search || uri.hash) throw new Error();
      localPath = fileURLToPath(uri, { windows });
    }
    if (/[\u0000-\u001f\u007f]/.test(localPath)) throw new Error();
    encodeURI(localPath); // Reject ill-formed Unicode rather than replace its identity.
    if (windows) {
      if (!/^[a-z]:[\\/]/i.test(localPath)) throw new Error();
      const parts = localPath.slice(3).split(/[\\/]/);
      if (parts.some(p => /[<>:"|?*]/.test(p) || /[. ]$/.test(p)
          || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error();
    } else if (!localPath.startsWith("/") || localPath.startsWith("//")) throw new Error();
    if (localPath.split(windows ? /[\\/]/ : /\//).some(p => p === "." || p === "..")) throw new Error();
    return pathToFileURL(localPath, { windows }).href;
  } catch {
    throw new Error("REPOSITORY_CONTEXT_INVALID");
  }
}
function rootsSchema(windows: boolean) {
  // Reuse the SDK's string URI primitive, NOT an any/unknown result schema.
  // Root fields retain their SDK types; the COMPLETE result is validated again
  // after representation normalization. No invalid entry is filtered out.
  return ListRootsResultSchema.extend({
    roots: RootSchema.extend({
      uri: ResourceSchema.shape.uri.transform(value => localFileUri(value, windows)),
    }).array(),
  }).pipe(ListRootsResultSchema);
}
const windowsRoots = rootsSchema(true);
const posixRoots = rootsSchema(false);
const recorded = {
  client: { name: "cursor-vscode", version: "1.0.0" },
  capabilities: {
    elicitation: { form: {} }, roots: { listChanged: false },
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  } satisfies ClientCapabilities,
  response: { roots: [{ uri: "c:\\fixtures\\fixture Repo A % encoded", name: "fixture Repo A % encoded" }] },
  expected: "file:///c:/fixtures/fixture%20Repo%20A%20%25%20encoded",
};
const a = "file:///C:/fixtures/Repo%20A", b = "file:///C:/fixtures/Repo%20B";

// Small SDK peer harness. Only roots representations and connection lifecycle are
// qualified here; this is NOT the future repository-identity resolver.
function peer(capabilities: ClientCapabilities = { roots: { listChanged: true } },
  info = { name: "simulated-context-client", version: "1" }) {
  const server = new Server({ name: "context-contract-probe", version: "1" }, { capabilities: {} });
  const client = new Client(info, { capabilities });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const initialized = deferred<void>(), changed = deferred<void>();
  let ready = false, generation = 0, requests = 0;
  let response: Result = { roots: [{ uri: a }] };
  let handler: () => Result | Promise<Result> = () => response;
  const requestParams: unknown[] = [];
  server.oninitialized = () => { ready = true; initialized.resolve(); };
  server.onclose = () => { ready = false; generation++; };
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    generation++; changed.resolve();
  });
  if (capabilities.roots) client.setRequestHandler(ListRootsRequestSchema, request => {
    requests++; requestParams.push(request.params); return handler();
  });
  async function roots(timeout = 200) {
    if (!ready || !server.getClientCapabilities()?.roots) throw new Error("REPOSITORY_CONTEXT_REQUIRED");
    const before = generation;
    let result;
    try {
      result = await server.request({ method: "roots/list" }, windowsRoots, { timeout });
    } catch (error) {
      throw new Error(error instanceof McpError && error.code === ErrorCode.RequestTimeout
        ? "REPOSITORY_LOOKUP_TIMEOUT" : "REPOSITORY_LOOKUP_FAILED");
    }
    if (!ready || generation !== before) throw new Error("REPOSITORY_CONTEXT_CHANGED");
    return result;
  }
  return {
    server, client, initialized: initialized.promise, changed: changed.promise,
    requestParams, roots,
    get requests() { return requests; },
    setResponse(value: Result) { response = value; },
    setHandler(value: () => Result | Promise<Result>) { handler = value; },
    async start() { await server.connect(serverTransport); await client.connect(clientTransport); await initialized.promise; },
    async oneRoot(timeout?: number) {
      const result = await roots(timeout);
      if (!result.roots.length) throw new Error("REPOSITORY_CONTEXT_REQUIRED");
      // ceiling: single-root selection only; upgrade: qualified equivalence or primary signal.
      // Preserve multiple valid roots above, but never guess which one is primary.
      if (result.roots.length !== 1) throw new Error("REPOSITORY_CONTEXT_AMBIGUOUS");
      return result.roots[0].uri;
    },
    async close() { try { await client.close(); } finally { await server.close(); } },
  };
}

const valid: Array<[string, boolean, string]> = [
  [recorded.response.roots[0].uri, true, recorded.expected],
  ["C:/fixtures/space # % é", true, "file:///C:/fixtures/space%20%23%20%25%20%C3%A9"],
  ["file:///C:/fixtures/literal%2520", true, "file:///C:/fixtures/literal%2520"],
  ["C:\\fixtures\\literal%20", true, "file:///C:/fixtures/literal%2520"],
  ["file://localhost/C:/fixtures/Repo%20A", true, a],
  ["file:///C:/fixtures/hash%23question%2525", true, "file:///C:/fixtures/hash%23question%2525"],
  ["/fixtures/space # % é", false, "file:///fixtures/space%20%23%20%25%20%C3%A9"],
  ["file:///fixtures/space%20%25", false, "file:///fixtures/space%20%25"],
  ["file://localhost/fixtures/repo", false, "file:///fixtures/repo"],
];
for (const [input, windows, expected] of valid) {
  const schema = windows ? windowsRoots : posixRoots;
  const original = { roots: [{ uri: input, name: "fixture" }], _meta: { probe: "simulation" } };
  const result = schema.parse(original);
  check(`simulation: canonical encoding ${JSON.stringify(input)}`, result.roots[0].uri === expected);
  check("simulation: normalization is idempotent and preserves name/meta/input",
    schema.parse(result).roots[0].uri === expected && result.roots[0].name === "fixture"
    && result._meta?.probe === "simulation" && original.roots[0].uri === input);
}
const invalidPaths = [
  "", "repo", "./repo", "C:repo", "C:", "\\repo", "/repo", "C:\\repo\\..\\other", "C:\\repo\\.\\child",
  "\\\\host\\share", "//host/share", "\\\\?\\C:\\repo", "\\\\.\\pipe\\repo", "https://host/repo",
  "file://remote/C:/repo", "file://user:pass@host/C:/repo", "file://localhost:80/C:/repo",
  "file:C:/repo", "file:///C|/repo", "file:////host/share", "file:///C:/repo?x", "file:///C:/repo#x",
  "file:///C:/repo?", "file:///C:/repo ", "file:///C:/bad%", "file:///C:/bad%GG", "file:///C:/bad%FF",
  "file:///C:/repo%2fchild", "file:///C:/repo%5cchild", "file:///C:/%2e%2e/other",
  "file:///C:/repo%00", "file:///C:\\repo", "C:\\repo\nsecret", "C:\\repo:stream", "C:\\NUL",
  "C:\\repo. ", "C:\\repo\\child.", "C:\\repo\\\ud800",
];
for (const uri of invalidPaths) await refused(`simulation: invalid local representation ${JSON.stringify(uri)}`,
  () => windowsRoots.parse({ roots: [{ uri }] }), "REPOSITORY_CONTEXT_INVALID");
for (const value of [null, {}, { roots: null }, { roots: "bad" }, { roots: [null] },
  { roots: [{ uri: 42 }] }, { roots: [{ uri: a, name: 42 }] }, { roots: [{ uri: a }], _meta: 42 }]) {
  await refused("simulation: complete roots response shape is validated", () => windowsRoots.parse(value));
}
await refused("simulation: a bad second root invalidates the WHOLE response",
  () => windowsRoots.parse({ roots: [{ uri: a }, { uri: "relative" }] }), "REPOSITORY_CONTEXT_INVALID");
await refused("simulation: POSIX remote double-slash path refused", () => posixRoots.parse({ roots: [{ uri: "//host/share" }] }));
await refused("simulation: POSIX relative path refused", () => posixRoots.parse({ roots: [{ uri: "repo" }] }));

const replay = peer(recorded.capabilities, recorded.client);
try {
  replay.setResponse(recorded.response);
  await refused("replay: pre-initialization context cannot resolve", () => replay.oneRoot(), "REPOSITORY_CONTEXT_REQUIRED");
  await replay.start();
  check("replay: actual SDK initialization captures recorded capabilities",
    replay.server.getClientCapabilities()?.roots?.listChanged === false);
  await refused("replay control: stock listRoots rejects the recorded raw path", () => replay.server.listRoots());
  check("replay: shared schema qualifies recorded global Windows representation", await replay.oneRoot() === recorded.expected);
  check("replay: all context requests omit tenant/project params", replay.requestParams.every(p => p === undefined));
  check("replay: native fixture context differs from actual test/server cwd; no cwd recovery",
    recorded.expected !== pathToFileURL(process.cwd()).href);
} finally { await replay.close(); }

const local = peer(), globalA = peer(), globalB = peer();
try {
  globalB.setResponse({ roots: [{ uri: b }] });
  await Promise.all([local.start(), globalA.start(), globalB.start()]);
  const selected = await Promise.all([local.oneRoot(), globalA.oneRoot(), globalB.oneRoot()]);
  check("simulation: local/global-style same context agrees; concurrent repositories stay separate",
    selected[0] === a && selected[1] === a && selected[2] === b);
  check("simulation: omitted scope on all connections", [local, globalA, globalB].every(p => p.requestParams.every(v => v === undefined)));
  local.setResponse({ roots: [{ uri: a }, { uri: b }] });
  check("simulation: normalization preserves EVERY valid root", (await local.roots()).roots.length === 2);
  await refused("simulation: multiple roots have no guessed primary", () => local.oneRoot(), "REPOSITORY_CONTEXT_AMBIGUOUS");
  local.setResponse({ roots: [{ uri: a }, { uri: "C:relative" }] });
  await refused("simulation: malformed member rejects complete transport response", () => local.oneRoot(), "REPOSITORY_LOOKUP_FAILED");
  local.setResponse({ roots: [] });
  await refused("simulation: empty roots refuse, not cwd/default", () => local.oneRoot(), "REPOSITORY_CONTEXT_REQUIRED");
  local.setResponse({});
  await refused("simulation: missing roots refuse", () => local.oneRoot(), "REPOSITORY_LOOKUP_FAILED");
  local.setHandler(() => { throw new McpError(ErrorCode.InternalError, "simulated private path or credential"); });
  await refused("simulation: failed advertised request refuses with sanitized error", () => local.oneRoot(), "REPOSITORY_LOOKUP_FAILED");
  const late = deferred<Result>();
  local.setHandler(() => late.promise);
  await refused("simulation: withheld roots time out without fallback", () => local.oneRoot(30), "REPOSITORY_LOOKUP_TIMEOUT");
  late.resolve({ roots: [{ uri: a }] });
} finally { await Promise.all([local.close(), globalA.close(), globalB.close()]); }

const absent = peer({});
try {
  await absent.start();
  await refused("simulation: absent capability has no unproven launch-cwd alternative", () => absent.oneRoot(), "REPOSITORY_CONTEXT_REQUIRED");
  check("simulation: absent capability never requests roots", absent.requests === 0);
} finally { await absent.close(); }

const lifecycle = peer();
try {
  await lifecycle.start();
  const captured = await lifecycle.oneRoot();
  const entered = deferred<void>(), pending = deferred<Result>();
  lifecycle.setHandler(() => { entered.resolve(); return pending.promise; });
  const crossing = refused("simulation: changed generation rejects unfinished discovery", () => lifecycle.oneRoot(), "REPOSITORY_CONTEXT_CHANGED");
  await entered.promise;
  await lifecycle.client.notification({ method: "notifications/roots/list_changed" });
  await lifecycle.changed;
  pending.resolve({ roots: [{ uri: a }] });
  await crossing;
  lifecycle.setHandler(() => ({ roots: [{ uri: b }] }));
  check("simulation: subsequent read is fresh; captured scalar remains unchanged",
    await lifecycle.oneRoot() === b && captured === a);
  await lifecycle.close();
  await refused("simulation: closed connection cannot reuse discovery", () => lifecycle.oneRoot(), "REPOSITORY_CONTEXT_REQUIRED");
} finally { await lifecycle.close(); }
const reconnected = peer({ roots: { listChanged: false } });
try {
  reconnected.setResponse({ roots: [{ uri: b }] });
  await reconnected.start();
  check("simulation: reconnect gets independent fresh context", await reconnected.oneRoot() === b);
  reconnected.setResponse({ roots: [{ uri: a }] });
  check("simulation: no notification support still rereads roots", await reconnected.oneRoot() === a);
} finally { await reconnected.close(); }
// Portable synthetic metadata, grounded in the recorded Git fixture structure.
// These are real SDK and Git operations, not additional native-client observations.
const fixture = await mkdtemp(join(tmpdir(), "repository-resolver-test-"));
const https = "https://git.example.invalid/acme/widget.git";
const other = "https://git.example.invalid/other/widget.git";
const config = (urls: string[], name = "origin") => "[core]\nrepositoryformatversion = 0\nbare = false\n" +
  (urls.length ? `[remote "${name}"]\n` + urls.map(url => `url = ${JSON.stringify(url)}\n`).join("") : "");
async function repo(name: string, urls: string[] = []) {
  const path = join(fixture, name);
  await mkdir(join(path, ".git", "objects"), { recursive: true });
  await mkdir(join(path, ".git", "refs"));
  await writeFile(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(path, ".git", "config"), config(urls));
  return path;
}
function productionPeer(path: string, timeoutMs = 5000, capabilities: ClientCapabilities = { roots: { listChanged: true } }) {
  const server = new Server({ name: "resolver-test", version: "1" }, { capabilities: {} });
  const client = new Client({ name: "simulation", version: "1" }, { capabilities });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  let initialized = 0, closed = 0, requests = 0;
  let initializedReceiver: unknown, closedReceiver: unknown;
  let handler: () => Result | Promise<Result> = () => ({ roots: [{ uri: path }] });
  server.oninitialized = function (this: Server) { initialized++; initializedReceiver = this; };
  server.onclose = function (this: Server) { closed++; closedReceiver = this; };
  const resolve = createRepositoryProjectResolver({ protocol: server, timeoutMs, verifiedLaunchCwd: process.cwd() });
  if (capabilities.roots) client.setRequestHandler(ListRootsRequestSchema, request => {
    requests++; check("production: request omits tenant", request.params === undefined); return handler();
  });
  return { server, client, resolve, set: (value: typeof handler) => { handler = value; },
    get initialized() { return initialized; }, get closed() { return closed; }, get requests() { return requests; },
    get initializedReceiver() { return initializedReceiver; }, get closedReceiver() { return closedReceiver; },
    async start() { await server.connect(st); await client.connect(ct); },
    async close() { try { await client.close(); } finally { await server.close(); } } };
}
const sourcePath = await repo("source space %20"), clonePath = await repo("clone", [sourcePath]);
const remotePath = await repo("remote", [https]), sshPath = await repo("ssh", ["git@git.example.invalid:acme/widget.git"]);
const separatePath = await repo("separate");
const worktreePath = join(fixture, "worktree");
const worktreeGit = join(sourcePath, ".git", "worktrees", "linked");
await mkdir(worktreePath); await mkdir(worktreeGit, { recursive: true });
await writeFile(join(worktreePath, ".git"), `gitdir: ${worktreeGit.replaceAll("\\", "/")}\n`);
await writeFile(join(worktreeGit, "commondir"), "../..\n");
await writeFile(join(worktreeGit, "HEAD"), "ref: refs/heads/other\n");
await writeFile(join(worktreeGit, "gitdir"), join(worktreePath, ".git").replaceAll("\\", "/") + "\n");
const subdirectory = join(sourcePath, "nested"); await mkdir(subdirectory);
const expectedRemote = deriveRepositoryProject(createHash("sha256").update(repositoryRemoteKey(https)).digest("hex"));
const expectedLocal = deriveRepositoryProject(createHash("sha256").update(repositoryLocalKey(await realpath(join(sourcePath, ".git")))).digest("hex"));
const prod = productionPeer(sourcePath);
try {
  const pending = prod.resolve(); await prod.start();
  check("production: waits for readiness and preserves callback", await pending === expectedLocal && prod.initialized === 1);
  check("production: initialization callback retains protocol receiver", prod.initializedReceiver === prod.server);
  check("production: wrong ambient cwd ignored and digest pinned", await prod.resolve() === expectedLocal && sourcePath !== process.cwd());
  prod.set(() => ({ roots: [{ uri: pathToFileURL(sourcePath).href }] }));
  check("production: URI escaping preserves literal percent and spaces", await prod.resolve() === expectedLocal);
  prod.set(() => ({ roots: [{ uri: sourcePath }, { uri: clonePath }] }));
  check("production: verified local link and equal roots share identity", await prod.resolve() === expectedLocal);
  prod.set(() => ({ roots: [{ uri: sourcePath }, { uri: worktreePath }, { uri: subdirectory }] }));
  check("production: git-file worktree, different branch and subdirectory share common directory", await prod.resolve() === expectedLocal);
  const malformed = process.platform === "win32" ? invalidPaths : ["relative", "//host/share", "file://remote/repo", "file:///bad%", "file:///bad%2fpath"];
  for (const uri of malformed) {
    prod.set(() => ({ roots: [{ uri }] }));
    await refused("production: malformed local representation refuses before metadata", prod.resolve, "REPOSITORY_LOOKUP_FAILED");
  }
  prod.set(() => ({ roots: Array.from({ length: 33 }, () => ({ uri: sourcePath })) }));
  await refused("production: root traversal ceiling refuses", prod.resolve, "REPOSITORY_CONTEXT_AMBIGUOUS");
  prod.set(() => ({ roots: [{ uri: remotePath }, { uri: sshPath }] }));
  await refused("production: unqualified HTTPS/SSH roots cannot be assumed equal", prod.resolve, "REPOSITORY_CONTEXT_AMBIGUOUS");
  for (const host of ["github.com", "gitlab.com"]) {
    const first = await repo(`qualified-${host}`, [`https://${host}/acme/widget.git`]);
    const second = await repo(`qualified-ssh-${host}`, [`git@${host}:acme/widget.git`]);
    prod.set(() => ({ roots: [{ uri: first }, { uri: second }] }));
    const expected = deriveRepositoryProject(createHash("sha256").update(repositoryRemoteKey(`https://${host}/acme/widget.git`)).digest("hex"));
    check("production: qualified HTTPS/SSH metadata shares a project", await prod.resolve() === expected);
    await writeFile(join(first, ".git", "config"), config([`https://${host}/acme/widget.git`, `git@${host}:acme/widget.git`]));
    prod.set(() => ({ roots: [{ uri: first }] }));
    check("production: qualified equivalent selected URLs remain accepted", await prod.resolve() === expected);
  }
  for (const [index, pair] of [
    ["ssh://git.example.invalid/srv/repo", "git.example.invalid:srv/repo"],
    ["ssh://git.example.invalid/srv/repo", "ssh://git.example.invalid/srv/repo.git"],
    ["https://git.example.invalid/srv/repo", "https://git.example.invalid/srv/repo.git"],
  ].entries()) {
    const first = await repo(`distinct-${index}-a`, [pair[0]]);
    const second = await repo(`distinct-${index}-b`, [pair[1]]);
    prod.set(() => ({ roots: [{ uri: first }] }));
    const firstScope = await prod.resolve();
    prod.set(() => ({ roots: [{ uri: second }] }));
    check("production: previously colliding endpoints derive distinct projects", firstScope !== await prod.resolve());
    prod.set(() => ({ roots: [{ uri: first }, { uri: second }] }));
    await refused("production: previously colliding endpoints refuse combined roots", prod.resolve, "REPOSITORY_CONTEXT_AMBIGUOUS");
  }
  prod.set(() => ({ roots: [{ uri: sourcePath }, { uri: separatePath }] }));
  await refused("production: unrelated roots refuse", prod.resolve, "REPOSITORY_CONTEXT_AMBIGUOUS");
  for (const response of [{ roots: [] }, {}, { roots: [{ uri: sourcePath }, { uri: "relative" }] },
    { roots: [{ uri: sourcePath, name: 42 }] }, { roots: [{ uri: sourcePath }], _meta: 42 }]) {
    // Deliberately malformed wire result: SDK rejects invalid envelope _meta before
    // matching the response, so this case terminates at the overall deadline.
    prod.set(() => response as unknown as Result);
    await refused("production: whole response rejects invalid/missing context", prod.resolve,
      response._meta === 42 ? "REPOSITORY_LOOKUP_TIMEOUT" :
        "roots" in response && response.roots?.length === 0 ? "REPOSITORY_CONTEXT_REQUIRED" : "REPOSITORY_LOOKUP_FAILED");
  }
  prod.set(() => { throw new Error("private credentials/path"); });
  await refused("production: advertised failure sanitized without cwd fallback", prod.resolve, "REPOSITORY_LOOKUP_FAILED");
  prod.set(() => ({ roots: [{ uri: remotePath }] }));
  const captured = await prod.resolve();
  await writeFile(join(remotePath, ".git", "config"), config(["fixture:widget.git"]) + '[url "https://git.example.invalid/acme/"]\ninsteadOf = fixture:\n');
  check("production: Git expands declared URL alias without helper", await prod.resolve() === expectedRemote);
  await writeFile(join(remotePath, ".git", "config"), config([https], "team"));
  check("production: sole non-origin remote selected", await prod.resolve() === expectedRemote);
  await writeFile(join(remotePath, ".git", "config"), config([https], "team") + `[remote "other"]\nurl = ${other}\n`);
  await refused("production: multiple remotes without origin refuse", prod.resolve, "REPOSITORY_IDENTITY_UNRESOLVED");
  await writeFile(join(remotePath, ".git", "config"), config([other]) + `[remote "upstream"]\nurl = ${https}\n`);
  check("production: fork origin wins over upstream", await prod.resolve() !== captured);
  await writeFile(join(remotePath, ".git", "config"), config([]));
  check("production: removed anchor no longer shares remote identity", await prod.resolve() !== captured);
  await writeFile(join(remotePath, ".git", "config"), config([other]));
  check("production: current metadata is rediscovered without notification", await prod.resolve() !== captured && captured === expectedRemote);
  await writeFile(join(remotePath, ".git", "config"), config([https, other]));
  await refused("production: conflicting selected URL multiplicity refuses", prod.resolve, "REPOSITORY_IDENTITY_UNRESOLVED");
  await writeFile(join(remotePath, ".git", "config"), config([https, "git@git.example.invalid:acme/widget.git"]));
  await refused("production: unqualified selected URL multiplicity refuses", prod.resolve, "REPOSITORY_IDENTITY_UNRESOLVED");
  await writeFile(join(remotePath, ".git", "config"), config([join(fixture, "missing")]));
  await refused("production: missing selected link refuses", prod.resolve, "REPOSITORY_IDENTITY_UNRESOLVED");
  const invalidEndpoint = join(separatePath, "old-source");
  await mkdir(invalidEndpoint);
  await writeFile(join(remotePath, ".git", "config"), config([invalidEndpoint]));
  await refused("production: local remote cannot inherit an unrelated enclosing repository", prod.resolve, "REPOSITORY_IDENTITY_UNRESOLVED");
  await writeFile(join(separatePath, ".git", "config"), config([]) + `[core]\nworktree = ${JSON.stringify(invalidEndpoint)}\n`);
  await refused("production: parent worktree configuration cannot replace endpoint metadata", prod.resolve, "REPOSITORY_IDENTITY_UNRESOLVED");
  await writeFile(join(separatePath, ".git", "config"), config([]));
  await writeFile(join(remotePath, ".git", "config"), config([join(separatePath, ".git", "objects")]));
  await refused("production: local remote cannot name a child inside another Git directory", prod.resolve, "REPOSITORY_IDENTITY_UNRESOLVED");
  for (const endpoint of [sourcePath, worktreePath, join(sourcePath, ".git"), worktreeGit]) {
    await writeFile(join(remotePath, ".git", "config"), config([endpoint]));
    check("production: exact local working-tree and Git-directory endpoints remain valid", await prod.resolve() === expectedLocal);
  }
  // A Git-directory endpoint whose own origin is an absolute local link has no working tree.
  const chainMiddle = await repo("chain-middle", [sourcePath]);
  await writeFile(join(remotePath, ".git", "config"), config([join(chainMiddle, ".git")]));
  check("production: chain through a Git-directory endpoint with an absolute local origin", await prod.resolve() === expectedLocal);
  const bareEndpoint = join(await repo("bare-endpoint"), ".git");
  await writeFile(join(bareEndpoint, "config"), "[core]\nrepositoryformatversion = 0\nbare = true\n");
  await writeFile(join(remotePath, ".git", "config"), config([bareEndpoint]));
  const expectedBare = deriveRepositoryProject(createHash("sha256").update(repositoryLocalKey(await realpath(bareEndpoint))).digest("hex"));
  check("production: exact bare remote endpoint remains valid", await prod.resolve() === expectedBare);
  await writeFile(join(remotePath, ".git", "config"), config([remotePath]));
  await refused("production: local cycle refuses", prod.resolve, "REPOSITORY_IDENTITY_UNRESOLVED");
  const entered = deferred<void>(), response = deferred<Result>();
  prod.set(() => { entered.resolve(); return response.promise; });
  const crossing = refused("production: notification invalidates unfinished call", prod.resolve, "REPOSITORY_CONTEXT_CHANGED");
  await entered.promise; await prod.client.notification({ method: "notifications/roots/list_changed" });
  await crossing; response.resolve({ roots: [{ uri: sourcePath }] });
  prod.set(() => ({ roots: [{ uri: sourcePath }] }));
  check("production: concurrent calls independently resolve", (await Promise.all([prod.resolve(), prod.resolve()])).every(v => v === expectedLocal));
  const closeEntered = deferred<void>(), closeResponse = deferred<Result>();
  prod.set(() => { closeEntered.resolve(); return closeResponse.promise; });
  const closing = refused("production: close invalidates unfinished call", prod.resolve, "REPOSITORY_CONTEXT_CHANGED");
  await closeEntered.promise; await prod.close(); await closing;
  closeResponse.resolve({ roots: [] });
  check("production: close callback preserved", prod.closed === 1);
  check("production: close callback retains protocol receiver", prod.closedReceiver === prod.server);
  await refused("production: closed connection cannot reuse scalar", prod.resolve, "REPOSITORY_CONTEXT_REQUIRED");
} finally { await prod.close(); }
const noReady = productionPeer(sourcePath, 30), noCapability = productionPeer(sourcePath, 500, {});
try {
  await refused("production: withheld initialization bounded", noReady.resolve, "REPOSITORY_LOOKUP_TIMEOUT");
  await noCapability.start();
  await refused("production: absent capability ignores unqualified launch cwd", noCapability.resolve, "REPOSITORY_CONTEXT_REQUIRED");
  check("production: no capability means no roots requests", noCapability.requests === 0);
} finally { await noReady.close(); await noCapability.close(); }
const withheld = productionPeer(sourcePath, 40);
try {
  await withheld.start(); const response = deferred<Result>(); withheld.set(() => response.promise);
  await refused("production: withheld roots bounded", withheld.resolve, "REPOSITORY_LOOKUP_TIMEOUT");
  response.resolve({ roots: [] });
} finally { await withheld.close(); }
const fresh = productionPeer(clonePath), independent = productionPeer(separatePath);
try {
  await Promise.all([fresh.start(), independent.start()]);
  const scopes = await Promise.all([fresh.resolve(), independent.resolve()]);
  check("production: fresh connections share only equivalent repositories", scopes[0] === expectedLocal && scopes[1] !== scopes[0]);
  const oldGitDir = process.env.GIT_DIR, oldWorkTree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = join(separatePath, ".git"); process.env.GIT_WORK_TREE = separatePath;
    check("production: ambient Git repository overrides cannot redirect context", await fresh.resolve() === expectedLocal);
  } finally {
    if (oldGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldGitDir;
    if (oldWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = oldWorkTree;
  }
} finally { await fresh.close(); await independent.close(); }
// Ideal-model metadata fault injection, with actual disposable Node children.
// This is not a claim that Git naturally stalls or floods on these fixtures.
const childProcess = (await import("node:child_process")).default;
const { syncBuiltinESMExports } = await import("node:module");
const originalSpawn = childProcess.spawn;
for (const flood of [false, true]) {
  const fault = productionPeer(sourcePath, flood ? 3000 : 300);
  let killed = false, launched = false;
  const exited = deferred<void>();
  try {
    await fault.start();
    childProcess.spawn = ((command: string, args: string[], options: Parameters<typeof originalSpawn>[2]) => {
      launched = true;
      check("simulation: metadata uses shell-free allowed command", command === "git" && args.includes("rev-parse") && options?.shell === false);
      const child = originalSpawn(process.execPath, ["-e", flood ?
        "process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000)" : "setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe"] });
      const kill = child.kill.bind(child);
      child.kill = (...args) => { killed = true; return kill(...args); };
      child.on("close", () => exited.resolve());
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    await refused(flood ? "simulation: metadata output bounded" : "simulation: metadata timeout bounded", fault.resolve,
      flood ? "REPOSITORY_IDENTITY_UNRESOLVED" : "REPOSITORY_LOOKUP_TIMEOUT");
    if (launched) await exited.promise;
    check("simulation: failed metadata child terminated", launched && killed);
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports(); await fault.close();
  }
}
// Ideal-model stalled filesystem promise: overall deadline also covers FS and
// a late rejection must not escape as an unhandled rejection.
const fsPromises = (await import("node:fs/promises")).default;
const originalRealpath = fsPromises.realpath;
const filesystem = productionPeer(sourcePath, 50);
let rejectLate!: (error: Error) => void;
try {
  await filesystem.start();
  fsPromises.realpath = () => new Promise<never>((_done, reject) => { rejectLate = reject; });
  syncBuiltinESMExports();
  await refused("simulation: filesystem operation shares overall deadline", filesystem.resolve, "REPOSITORY_LOOKUP_TIMEOUT");
  rejectLate(new Error("simulated private filesystem failure"));
  await new Promise(done => setImmediate(done));
} finally {
  fsPromises.realpath = originalRealpath; syncBuiltinESMExports(); await filesystem.close();
}
console.log(`\n${total - failures}/${total} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
