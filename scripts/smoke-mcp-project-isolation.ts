// Direct shipped-stdio + PostgreSQL proof; excluded from the offline suite.
// Requires an exclusive disposable schema-ready DB and permission for the two
// pinned synthetic repository projects. Retains all fixtures; no models/deletes.
// Set TITRATION_SMOKE_DATABASE_URL, TITRATION_SMOKE_CONFIRM_DATABASE (exact name)
// and TITRATION_SMOKE_CONFIRM_PROJECTS (the two derived slugs, comma-separated,
// in origin order below). TITRATION_SMOKE_ANCHORS selects qualified (default),
// ssh-path or ssh-suffix. --describe prints that case's exact projects without I/O.
// Run: node --import tsx scripts/smoke-mcp-project-isolation.ts
import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import postgres from "postgres";
import { postgresOptions } from "../lib/db-connect-core";
import { canonicalizeCard } from "../lib/card-contract-core";
import { deriveRepositoryProject, repositoryRemoteKey } from "../lib/repository-project-core";

let checks = 0;
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`SMOKE_ASSERTION_FAILED: ${name}`);
  checks++;
  console.log(`PASS  ${name}`);
}
type Snapshot = Record<string, string[]>;
const anchorCases = {
  qualified: ["https://github.com/titration-fixture-a/widget.git", "https://github.com/titration-fixture-b/widget.git"],
  "ssh-path": ["ssh://git.example.invalid/srv/repo", "git.example.invalid:srv/repo"],
  "ssh-suffix": ["ssh://git.example.invalid/srv/repo", "ssh://git.example.invalid/srv/repo.git"],
};
const anchorCase = process.env.TITRATION_SMOKE_ANCHORS ?? "qualified";
if (!Object.hasOwn(anchorCases, anchorCase)) throw new Error("SMOKE_ANCHORS_INVALID");
const origins = anchorCases[anchorCase as keyof typeof anchorCases];
const projects = origins.map(origin => deriveRepositoryProject(createHash("sha256").update(repositoryRemoteKey(origin)).digest("hex")));

async function main(): Promise<void> {
  if (process.argv.includes("--describe")) {
    console.log(JSON.stringify({ anchorCase, origins, projects }));
    return;
  }
  // No bootstrap import: every confirmation precedes pool/child/fixture creation.
  const databaseUrl = process.env.TITRATION_SMOKE_DATABASE_URL;
  const confirmation = process.env.TITRATION_SMOKE_CONFIRM_DATABASE;
  if (!databaseUrl || !confirmation) throw new Error("SMOKE_DATABASE_REQUIRED: set both explicit smoke database inputs; no connection or child started");
  let parsed: URL;
  try { parsed = new URL(databaseUrl); }
  catch { throw new Error("SMOKE_DATABASE_INVALID: expected a PostgreSQL URL"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
      || decodeURIComponent(parsed.pathname.slice(1)) !== confirmation || parsed.search || parsed.hash) {
    throw new Error("SMOKE_DATABASE_MISMATCH: exact database confirmation and a URL without query/fragment required");
  }
  if (process.env.TITRATION_SMOKE_CONFIRM_PROJECTS !== projects.join(",")) {
    throw new Error(`SMOKE_PROJECTS_REQUIRED: confirm exactly ${projects.join(",")}; no connection or child started`);
  }
  const sql = postgres(databaseUrl, {
    ...postgresOptions(databaseUrl, {}), max: 1, connect_timeout: 10,
    connection: { default_transaction_read_only: true },
  });
  const fixtures = projects.map(project => {
    const runRef = `RUN-${randomUUID()}`;
    const card = { card_ref: `T-MET-${Date.now()}${randomInt(100000, 1000000)}`, type: "METHOD",
      title: "Repository isolation smoke", body: `Private isolation fixture ${runRef}` };
    return { project, runRef, card, expected: canonicalizeCard(card) };
  });
  console.log(JSON.stringify({ fixtures }));
  let children = 0, closed = 0, calls = 0, embedWarnings = 0;
  const pids: number[] = [];
  try {
    const [db] = await sql`select current_database() as name, current_setting('transaction_read_only') as readonly`;
    check("confirmed database and read-only audit connection", db.name === confirmation && db.readonly === "on");
    async function schema() {
      const tables = await sql`select p.tablename, exists (
        select 1 from information_schema.columns c where c.table_schema = p.schemaname
        and c.table_name = p.tablename and c.column_name = 'tenant_id'
      ) as tenant_scoped from pg_tables p where p.schemaname = 'public' order by p.tablename`;
      for (const required of ["tenants", "cards", "runs", "jobs", "card_relationships", "baselines"]) {
        check(`schema contains ${required}`, tables.some(t => t.tablename === required));
      }
      const [jobs] = await sql`select count(*)::int as n from jobs`;
      check("zero jobs before product launch; unchanged sweep has nothing to change", jobs.n === 0);
      return tables;
    }
    const tables = await schema();
    async function fixtureRows() {
      const cards: Record<string, unknown>[] = [], runs: Record<string, unknown>[] = [];
      for (const tenant of await sql`select id from tenants`) {
        for (const f of fixtures) {
          cards.push(...await sql`select c.*, t.slug from cards c join tenants t on t.id = c.tenant_id
            where c.tenant_id = ${tenant.id} and c.card_ref = ${f.card.card_ref}`);
          runs.push(...await sql`select r.*, t.slug from runs r join tenants t on t.id = r.tenant_id
            where r.tenant_id = ${tenant.id} and r.ref = ${f.runRef}`);
        }
      }
      return { cards, runs };
    }
    const absent = await fixtureRows();
    check("unique card/run refs absent across freshly enumerated tenants", absent.cards.length === 0 && absent.runs.length === 0);
    // ceiling: small exclusive disposable database; upgrade: streamed audit for large fixtures.
    async function snapshot(): Promise<Snapshot> {
      const currentTables = await schema();
      check("public table inventory unchanged", JSON.stringify(currentTables) === JSON.stringify(tables));
      const result: Snapshot = {};
      const tenants = await sql`select id from tenants`;
      for (const table of currentTables) {
        const rows: string[] = [];
        if (table.tenant_scoped) {
          for (const tenant of tenants) {
            const scoped = await sql`select to_jsonb(t)::text as row from ${sql(table.tablename)} t where t.tenant_id = ${tenant.id}`;
            rows.push(...scoped.map(r => r.row as string));
          }
        } else {
          const global = await sql`select to_jsonb(t)::text as row from ${sql(table.tablename)} t`;
          rows.push(...global.map(r => r.row as string));
        }
        result[table.tablename] = rows.sort();
      }
      return result;
    }
    const before = await snapshot();
    console.log(JSON.stringify({ audit_before: before }));
    try {
      const directory = await mkdtemp(join(tmpdir(), "repository-smoke-space-%20-"));
      const config = (origin: string) => `[core]\nrepositoryformatversion = 0\nbare = false\n[remote "origin"]\nurl = ${JSON.stringify(origin)}\n`;
      async function repo(name: string, origin: string) {
        const path = join(directory, name);
        await mkdir(join(path, ".git", "objects"), { recursive: true });
        await mkdir(join(path, ".git", "refs"));
        await writeFile(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
        await writeFile(join(path, ".git", "config"), config(origin));
        return path;
      }
      const a = await repo("a/widget", origins[0]), b = await repo("b/widget", origins[1]);
      const ssh = await repo("remote-clone", anchorCase === "qualified"
        ? "git@github.com:titration-fixture-a/widget.git" : origins[0]);
      const local = await repo("local", a);
      const subdir = join(a, "nested"); await mkdir(subdir);
      const worktree = join(directory, "worktree"), gitdir = join(a, ".git", "worktrees", "linked");
      await mkdir(worktree); await mkdir(gitdir, { recursive: true });
      await writeFile(join(worktree, ".git"), `gitdir: ${gitdir.replaceAll("\\", "/")}\n`);
      await writeFile(join(gitdir, "commondir"), "../..\n");
      await writeFile(join(gitdir, "HEAD"), "ref: refs/heads/other\n");
      await writeFile(join(gitdir, "gitdir"), join(worktree, ".git").replaceAll("\\", "/") + "\n");
      console.log(JSON.stringify({ fixture_directory_retained: directory, roots: { a, b, ssh, local, subdir, worktree } }));
      async function session(label: string, roots: () => string[], config: string,
        exercise: (client: Client) => Promise<void>, capability = true): Promise<void> {
        await schema();
        const transport = new StdioClientTransport({
          command: process.execPath, args: ["--import", "tsx", "server/server.ts"],
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          // Only SDK OS-required allowlist is inherited. Pin bootstrap-sensitive values.
          env: { TITRATION_DATABASE_URL: databaseUrl!, OPENROUTER_API_KEY: "", TITRATION_PROJECT: config,
            TITRATION_DB_SSL: postgresOptions(databaseUrl!, {}).ssl === false ? "disable" : "require", NODE_OPTIONS: "" },
          stderr: "pipe",
        });
        const client = new Client({ name: "repository-smoke", version: "1.0.0" },
          { capabilities: capability ? { roots: { listChanged: true } } : {} });
        if (capability) client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: roots().map(uri => ({ uri })) }));
        let stderr = "", pid: number | null = null;
        transport.stderr?.on("data", chunk => { stderr += String(chunk); });
        try {
          await client.connect(transport);
          pid = transport.pid;
          check(`${label}: child PID captured`, pid !== null);
          pids.push(pid!); children++;
          await exercise(client);
        } finally {
          try { await client.close(); } finally {
            await transport.close();
            if (pid !== null) {
              let alive = true;
              try { process.kill(pid, 0); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
              check(`${label}: owned child absent after close`, !alive);
              closed++;
            }
            console.log(JSON.stringify({ session: label, pid, stderr, closed: pid !== null }));
          }
        }
        const warnings = stderr.split("\n").filter(line => line.includes("[cardCreate] embed-on-write failed"));
        for (const warning of warnings) check("embed refused locally by empty key", fixtures.some(f => warning.includes(`${f.project}/${f.card.card_ref}`))
          && warning.includes("Set OPENROUTER_API_KEY before using an OpenRouter judge or embeddings."));
        embedWarnings += warnings.length;
        check(`${label}: no unexpected stderr`, stderr.split("\n").every(line => !line.trim()
          || line.includes("titration MCP server ready (stdio)") || warnings.includes(line)));
      }
      async function call(client: Client, name: string, args: Record<string, unknown>, error?: RegExp): Promise<Record<string, unknown>> {
        calls++;
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text").map(c => c.text).join("\n");
        console.log(JSON.stringify({ call: calls, name, args, result }));
        if (error) { check(`${name} refuses with ${error.source}`, result.isError === true && error.test(text)); return {}; }
        check(`${name} succeeds`, result.isError !== true);
        return JSON.parse(text) as Record<string, unknown>;
      }
      async function read(client: Client, index: number, present: boolean, project?: string) {
        const f = fixtures[index];
        const result = await call(client, "card_get", { card_ref: `project:${f.card.card_ref}`, ...(project === undefined ? {} : { project }) }, present ? undefined : /not found in tenant/i);
        if (present) check("exact project-layer fixture content", result.card_ref === f.card.card_ref && result.body === f.expected.body && result.title === f.expected.title && result.layer === "project");
      }
      async function create(client: Client, index: number) {
        const f = fixtures[index];
        // A matching assertion is read-only proof of derived selection before writes.
        await read(client, index, false, f.project);
        const card = await call(client, "card_create", f.card);
        check("omitted project writes derived card", card.tenant === f.project && card.card_ref === f.card.card_ref);
        const run = await call(client, "run_capture", { ref: f.runRef, summary: f.card.body });
        check("omitted project writes derived run without edges", run.tenant === f.project && run.run === f.runRef && run.linked_cards === 0);
      }
      let current = a;
      await session("local-style raw path", () => [current], "", async ca => {
        await create(ca, 0);
        // Nested sessions stay concurrently connected; writes are serial, so a
        // partial failure stops subsequent writes rather than racing more work.
        await session("global-style unrelated same basename", () => [pathToFileURL(b).href], "", async cb => {
          await read(cb, 0, false); await create(cb, 1);
          await read(ca, 0, true); await read(ca, 1, false);
          await read(cb, 1, true); await read(cb, 0, false);
          current = b; await ca.sendRootsListChanged();
          await read(ca, 1, true); await read(ca, 0, false);
          current = a; await ca.sendRootsListChanged(); await read(ca, 0, true);
        });
        for (const project of [projects[1], "default", "__base__", "INVALID!"]) {
          await call(ca, "card_create", { ...fixtures[0].card, body: "must never overwrite", project },
            project === "INVALID!" ? /REPOSITORY_PROJECT_INVALID/ : /REPOSITORY_PROJECT_CONFLICT/);
          await call(ca, "run_capture", { ref: fixtures[0].runRef, summary: "must never overwrite", project },
            project === "INVALID!" ? /REPOSITORY_PROJECT_INVALID/ : /REPOSITORY_PROJECT_CONFLICT/);
        }
      });
      for (const [label, path] of [[anchorCase === "qualified" ? "qualified SSH clone" : "same-URL clone", ssh], ["local-link clone", local], ["subdirectory", subdir], ["git-file other branch", worktree]]) {
        await session(label, () => [pathToFileURL(path).href], "", async client => { await read(client, 0, true); await read(client, 1, false); });
      }
      const invalidLocalTarget = join(b, "plain-child"); await mkdir(invalidLocalTarget);
      await writeFile(join(local, ".git", "config"), config(invalidLocalTarget));
      await session("invalid local endpoint", () => [local], "", async client => {
        await call(client, "card_get", { card_ref: `project:${fixtures[1].card.card_ref}` }, /REPOSITORY_IDENTITY_UNRESOLVED/);
      });
      await session("matching independent assertions", () => [a], ` ${projects[0]} `, async client => { await read(client, 0, true, ` ${projects[0]} `); });
      for (const config of [projects[1], "default", "__base__", "INVALID!"]) {
        await session("configured refusal", () => [a], config, async client => {
          await call(client, "card_create", { ...fixtures[0].card, project: projects[0], body: "must never overwrite" },
            config === "INVALID!" ? /REPOSITORY_PROJECT_INVALID/ : /REPOSITORY_PROJECT_CONFLICT/);
        });
      }
      for (const mode of ["missing", "failed", "ambiguous"]) {
        await session(mode, () => {
          if (mode === "failed") throw new Error("synthetic roots failure");
          return [a, b];
        }, "", async client => {
          await call(client, "card_create", fixtures[0].card,
            mode === "missing" ? /REPOSITORY_CONTEXT_REQUIRED/ : mode === "failed" ? /REPOSITORY_LOOKUP_FAILED/ : /REPOSITORY_CONTEXT_AMBIGUOUS/);
        }, mode !== "missing");
      }
      // Metadata changes affect future calls, never the already persisted rows.
      await writeFile(join(ssh, ".git", "config"), config(origins[1]));
      await session("changed anchor reconnect", () => [ssh], "", async client => { await read(client, 1, true); await read(client, 0, false); });
      check("two empty-key embedding refusals; no grading path invoked", embedWarnings === 2);
      const { cards, runs } = await fixtureRows();
      check("exactly two actual cards and runs", cards.length === 2 && runs.length === 2);
      for (const f of fixtures) {
        const card = cards.find(c => c.card_ref === f.card.card_ref), run = runs.find(r => r.ref === f.runRef);
        check("joined card has exact derived owner/content and NULL embedding", card?.slug === f.project && card?.embedding === null
          && card?.body === f.expected.body && card?.title === f.expected.title);
        check("joined run has same derived tenant_id and exact summary", run?.slug === f.project && run?.tenant_id === card?.tenant_id && run?.summary === f.card.body);
      }
    } finally {
      // On partial failure retain actual rows and full snapshots; never delete or retry writes.
      const rows = await fixtureRows();
      const after = await snapshot();
      console.log(JSON.stringify({ actual_rows: rows, audit_after: after, children, closed, pids, calls, embedWarnings }));
      for (const table of Object.keys(before)) {
        const remaining = after[table].filter(row => {
          const value = JSON.parse(row) as Record<string, unknown>;
          if (before[table].includes(row)) return true;
          if (table === "cards") return !rows.cards.some(c => c.id === value.id && fixtures.some(f => f.project === c.slug && f.card.card_ref === c.card_ref
            && c.body === f.expected.body && c.title === f.expected.title && c.embedding === null));
          if (table === "runs") return !rows.runs.some(r => r.id === value.id && fixtures.some(f => f.project === r.slug && f.runRef === r.ref && f.card.body === r.summary));
          if (table === "tenants") return !projects.includes(String(value.slug)) || before.tenants.some(old => JSON.parse(old).slug === value.slug);
          return true;
        });
        check(`exact unchanged full-row snapshot: ${table} except authorized additions`, JSON.stringify(remaining) === JSON.stringify(before[table]));
      }
      check("all connected owned product processes closed", children === closed);
    }
  } finally {
    await sql.end({ timeout: 5 });
    console.log("AUDIT_POOL_CLOSED");
  }
  console.log(`PASS ${checks}/${checks} smoke-mcp-project-isolation`);
}
main().catch(error => {
  const message = error instanceof Error && /^SMOKE_/.test(error.message)
    ? error.message : "SMOKE_FAILED: database, transport, or response failure; inspect retained partial evidence before retrying";
  console.error(message);
  process.exitCode = 1;
});
