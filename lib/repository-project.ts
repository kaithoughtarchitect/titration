// Read-only connection-local discovery. Client roots are the context; the launch
// directory is used only when the client advertises no roots capability.
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError, ListRootsResultSchema, RootSchema, ResourceSchema, RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { deriveRepositoryProject, selectRepositoryRemote, repositoryLocalKey, repositoryRemoteKey } from "./repository-project-core";

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
const rootsResult = rootsSchema(process.platform === "win32");
const failure = (category: string) => new Error(`REPOSITORY_${category}`);

/** Install before connect. Each invocation captures a fresh scalar scope. */
export function createRepositoryProjectResolver(options: {
  protocol: Server;
  timeoutMs: number;
  // Clients without roots support (observed: Codex CLI) start stdio servers in the
  // opened project. Used only when roots are NOT advertised; never inside serverRoot.
  launchContext?: { cwd: string; serverRoot: string };
}): () => Promise<string> {
  const { protocol, timeoutMs, launchContext } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw failure("LOOKUP_TIMEOUT");
  let ready = false, closed = false, generation = 0;
  const waiters = new Set<() => void>();
  const active = new Set<AbortController>();
  const initialized = protocol.oninitialized, onclose = protocol.onclose;
  function invalidate() {
    generation++;
    for (const controller of active) controller.abort(failure("CONTEXT_CHANGED"));
  }
  protocol.oninitialized = () => {
    ready = true;
    for (const wake of waiters) wake();
    initialized?.call(protocol);
  };
  protocol.onclose = () => {
    closed = true; ready = false; invalidate(); onclose?.call(protocol);
  };
  protocol.setNotificationHandler(RootsListChangedNotificationSchema, invalidate);

  return async () => {
    if (closed) throw failure("CONTEXT_REQUIRED");
    const before = generation, controller = new AbortController();
    const { signal } = controller;
    active.add(controller);
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(failure("LOOKUP_TIMEOUT")), timeoutMs);
    function guard() {
      if (signal.aborted) throw signal.reason;
      if (Date.now() >= deadline) throw failure("LOOKUP_TIMEOUT");
      if (closed || generation !== before) throw failure("CONTEXT_CHANGED");
    }
    async function bounded<T>(operation: Promise<T>): Promise<T> {
      // Observe both outcomes even after cancellation; remove listeners on settlement.
      return new Promise<T>((done, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        operation.then(value => { signal.removeEventListener("abort", abort); done(value); },
          error => { signal.removeEventListener("abort", abort); reject(error); });
        if (signal.aborted) abort();
      });
    }
    let commands = 0;
    async function git(directory: string, args: string[]): Promise<string> {
      guard();
      // ceiling: 256 commands and 64 KiB per child; upgrade: qualify larger inputs.
      if (++commands > 256) throw failure("IDENTITY_UNRESOLVED");
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
      Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_CONFIG_NOSYSTEM: "1" });
      return bounded(new Promise<string>((done, reject) => {
        const child = spawn("git", ["--no-pager", "-C", directory, ...args], {
          shell: false, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "", size = 0, settled = false;
        function finish(error?: Error) {
          if (settled) return;
          settled = true; signal.removeEventListener("abort", abort);
          if (error) { child.kill(); reject(error); } else done(output);
        }
        const abort = () => finish(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          size += Buffer.byteLength(chunk);
          if (size > 65536) finish(failure("IDENTITY_UNRESOLVED"));
          else output += chunk;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65536) finish(failure("IDENTITY_UNRESOLVED"));
        });
        child.on("error", () => finish(failure("LOOKUP_FAILED")));
        child.on("close", code => finish(code === 0 ? undefined : failure("IDENTITY_UNRESOLVED")));
        if (signal.aborted) abort();
      }));
    }
    function lines(value: string): string[] {
      // Remove only the command's final newline, never meaningful path whitespace.
      if (!value.endsWith("\n")) throw failure("IDENTITY_UNRESOLVED");
      const result = value.slice(0, -1).split("\n");
      if (result.some(line => !line || /[\u0000-\u001f\u007f]/.test(line))) throw failure("IDENTITY_UNRESOLVED");
      return result;
    }
    function one(value: string): string {
      const result = lines(value);
      if (result.length !== 1) throw failure("IDENTITY_UNRESOLVED");
      return result[0];
    }
    async function canonical(path: string): Promise<string> {
      guard();
      // Refuse explicit network/device paths before any filesystem operation.
      if (/^(?:\\\\|\/\/)/.test(path)) throw failure("IDENTITY_UNRESOLVED");
      try { return await bounded(realpath(path)); }
      catch { guard(); throw failure("IDENTITY_UNRESOLVED"); }
    }
    async function identity(path: string, seen = new Set<string>()): Promise<string> {
      guard();
      // ceiling: 16 repositories per local-link chain (including the root); upgrade: qualify deeper chains, never guess cycles.
      if (seen.size >= 16) throw failure("IDENTITY_UNRESOLVED");
      const directory = await canonical(path);
      if (seen.size > 0) {
        // Client roots may be subdirectories; local remote endpoints must not
        // inherit an enclosing repository after their own metadata disappears.
        const gitDir = await canonical(one(await git(directory, ["rev-parse", "--absolute-git-dir"])));
        if (directory !== gitDir) {
          const endpoint = await canonical(one(await git(directory, ["rev-parse", "--resolve-git-dir", resolve(directory, ".git")])));
          if (endpoint !== gitDir) throw failure("IDENTITY_UNRESOLVED");
        }
      }
      const common = await canonical(one(await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
      const verified = await canonical(one(await git(common, ["rev-parse", "--absolute-git-dir"])));
      if (common !== verified || seen.has(common)) throw failure("IDENTITY_UNRESOLVED");
      seen = new Set(seen).add(common);
      const remotes = await git(directory, ["remote"]);
      const selected = selectRepositoryRemote(remotes === "" ? [] : lines(remotes));
      if (selected === null) return repositoryLocalKey(common);
      const urls = lines(await git(directory, ["remote", "get-url", "--all", "--", selected]));
      let key: string | undefined;
      for (const url of urls) {
        let candidate: string;
        if (/^file:/i.test(url) || isAbsolute(url) || !url.includes(":")) {
          // Only a relative path needs a base; a Git-directory endpoint has no working tree.
          let local = url;
          if (!/^file:/i.test(url) && !isAbsolute(url)) {
            const bare = one(await git(directory, ["rev-parse", "--is-bare-repository"]));
            local = resolve(bare === "true" ? common : one(await git(directory, ["rev-parse", "--show-toplevel"])), url);
          }
          let target: string;
          try {
            target = fileURLToPath(localFileUri(local, process.platform === "win32"));
          } catch { throw failure("IDENTITY_UNRESOLVED"); }
          candidate = await identity(target, seen);
        } else candidate = repositoryRemoteKey(url);
        if (key !== undefined && key !== candidate) throw failure("IDENTITY_UNRESOLVED");
        key = candidate;
      }
      if (key === undefined) throw failure("IDENTITY_UNRESOLVED");
      return key;
    }
    try {
      if (!ready) {
        let wake!: () => void;
        const pending = new Promise<void>(done => { wake = done; waiters.add(wake); });
        try { await bounded(pending); } finally { waiters.delete(wake); }
      }
      guard();
      if (!protocol.getClientCapabilities()?.roots) {
        // Advertised roots always win; this path exists only for clients without them.
        if (!launchContext) throw failure("CONTEXT_REQUIRED");
        const cwd = await canonical(launchContext.cwd), serverRoot = await canonical(launchContext.serverRoot);
        const inside = relative(serverRoot, cwd);
        // A launch inside the server's own clone says nothing about the user's project.
        // Compare whole segments: a child folder named "..cache" is still inside.
        const outside = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
        if (!outside) throw failure("CONTEXT_REQUIRED");
        const key = await identity(cwd);
        guard();
        return deriveRepositoryProject(createHash("sha256").update(key).digest("hex"));
      }
      let roots;
      try {
        roots = await bounded(protocol.request({ method: "roots/list" }, rootsResult,
          { timeout: Math.max(1, deadline - Date.now()), signal }));
      } catch (error) {
        guard();
        throw failure(error instanceof McpError && error.code === ErrorCode.RequestTimeout ? "LOOKUP_TIMEOUT" : "LOOKUP_FAILED");
      }
      guard();
      if (!roots.roots.length) throw failure("CONTEXT_REQUIRED");
      // ceiling: 32 roots; upgrade: qualify larger root sets.
      if (roots.roots.length > 32) throw failure("CONTEXT_AMBIGUOUS");
      let key: string | undefined;
      for (const root of roots.roots) {
        const candidate = await identity(fileURLToPath(root.uri));
        if (key !== undefined && candidate !== key) throw failure("CONTEXT_AMBIGUOUS");
        key = candidate;
      }
      guard();
      return deriveRepositoryProject(createHash("sha256").update(key!).digest("hex"));
    } finally {
      clearTimeout(timer); active.delete(controller);
    }
  };
}
