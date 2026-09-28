import {
  DbContextError,
  normalizeDbContext,
  sameDbContext,
  type DbContextInput,
} from "../db-context-core";
import { createContextualSql } from "../db-context";

let passed = 0;
let failed = 0;

function check(condition: unknown, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}

async function rejectsCode(
  fn: () => unknown | Promise<unknown>,
  code: DbContextError["code"],
): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof DbContextError && error.code === code;
  }
}

const A: DbContextInput = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  access: "owner",
};
const B: DbContextInput = {
  tenantId: "22222222-2222-4222-8222-222222222222",
  organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  userId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  access: "member",
};

const normalizedA = normalizeDbContext(A);
check(Object.isFrozen(normalizedA), "normalized context is immutable");
check(sameDbContext(normalizedA, normalizeDbContext(A)), "equal context matches");
check(!sameDbContext(normalizedA, normalizeDbContext(B)), "foreign context differs");
check(
  await rejectsCode(
    () =>
      normalizeDbContext({
        ...A,
        tenantId: "not-a-uuid",
      }),
    "invalid_context",
  ),
  "invalid tenant id is refused",
);
check(
  await rejectsCode(
    () =>
      normalizeDbContext({
        ...A,
        organizationId: null,
      }),
    "invalid_context",
  ),
  "human context requires organization",
);

type FakeTx = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>) & {
  savepoint<T>(cb: (tx: FakeTx) => T | Promise<T>): Promise<T>;
  json(value: unknown): unknown;
  unsafe(query: string): Promise<any[]>;
};

const queryLog: Array<{ connection: number; values: readonly unknown[] }> = [];
const beginOptions: Array<string | null> = [];
let connection = 0;
let savepoints = 0;

function makeTx(id: number): FakeTx {
  const tx = (async (
    _strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    queryLog.push({ connection: id, values });
    await Promise.resolve();
    return [];
  }) as unknown as FakeTx;
  tx.savepoint = async <T>(cb: (nested: FakeTx) => T | Promise<T>) => {
    savepoints += 1;
    return cb(makeTx(id));
  };
  tx.json = (value) => ({ json: value, connection: id });
  tx.unsafe = async () => {
    queryLog.push({ connection: id, values: ["unsafe"] });
    return [];
  };
  return tx;
}

const base = makeTx(0) as FakeTx & {
  begin<T>(cb: (tx: FakeTx) => T | Promise<T>): Promise<T>;
  begin<T>(options: string, cb: (tx: FakeTx) => T | Promise<T>): Promise<T>;
  end(): Promise<void>;
};
base.begin = async <T>(
  optionsOrCallback: string | ((tx: FakeTx) => T | Promise<T>),
  maybeCallback?: (tx: FakeTx) => T | Promise<T>,
) => {
  const callback = typeof optionsOrCallback === "function"
    ? optionsOrCallback
    : maybeCallback;
  if (!callback) throw new TypeError("fake begin requires a callback");
  beginOptions.push(typeof optionsOrCallback === "string" ? optionsOrCallback : null);
  connection += 1;
  return callback(makeTx(connection));
};
base.end = async () => {};

const contextual = createContextualSql(base as any);

check(
  await rejectsCode(
    () =>
      contextual.withGuardedSql(async () => {
        await contextual.sql`select 1`;
      }),
    "missing_db_context",
  ),
  "guarded query without context refuses before base SQL",
);
check(queryLog.length === 0, "missing-context refusal performs no SQL");

const observed: string[] = [];
await Promise.all([
  contextual.withGuardedSql(() =>
    contextual.withDbContext(A, async () => {
      await Promise.resolve();
      observed.push(contextual.currentDbContext()!.tenantId);
      await contextual.sql`select ${"A"}`;
    }),
  ),
  contextual.withGuardedSql(() =>
    contextual.withDbContext(B, async () => {
      await Promise.resolve();
      observed.push(contextual.currentDbContext()!.tenantId);
      await contextual.sql`select ${"B"}`;
    }),
  ),
]);

check(
  observed.includes(A.tenantId) && observed.includes(B.tenantId),
  "concurrent A/B contexts retain their own tenant",
);
const queryA = queryLog.find((row) => row.values.includes("A"));
const queryB = queryLog.find((row) => row.values.includes("B"));
check(
  !!queryA && !!queryB && queryA.connection !== queryB.connection,
  "concurrent A/B queries use distinct transactions",
);
check(
  queryLog.filter((row) => row.values.length === 4).length === 2,
  "each root transaction applies four transaction-local settings",
);

await contextual.withDbContext(
  A,
  async () => {
    await contextual.sql`select ${"repeatable"}`;
  },
  "isolation level repeatable read",
);
check(
  beginOptions.at(-1) === "isolation level repeatable read",
  "root context forwards the exact repeatable-read transaction option",
);

await contextual.withDbContext(A, async () => {
  await contextual.withDbContext(A, async () => {
    await contextual.sql.begin(async (tx) => {
      await tx`select ${"nested"}`;
    });
  });
});
check(savepoints === 2, "nested context and nested sql.begin each use a savepoint");
const savepointsBeforeNestedOptions = savepoints;
check(
  await contextual.withDbContext(A, () =>
    rejectsCode(
      () => contextual.withDbContext(
        A,
        async () => {},
        "isolation level repeatable read",
      ),
      "nested_context_mismatch",
    ),
  ),
  "nested context cannot silently downgrade a requested transaction option",
);
check(
  savepoints === savepointsBeforeNestedOptions,
  "nested transaction-option refusal occurs before a savepoint",
);
check(
  await contextual.withDbContext(A, () =>
    rejectsCode(
      () => contextual.withDbContext(B, async () => {}),
      "nested_context_mismatch",
    ),
  ),
  "nested context cannot switch tenant",
);

const beforeLocal = queryLog.length;
await contextual.sql`select ${"unwrapped"}`;
check(
  queryLog.length === beforeLocal + 1
  && queryLog.at(-1)?.connection === 0,
  "unwrapped SQL behavior is unchanged",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
