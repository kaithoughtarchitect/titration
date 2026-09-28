import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";
import {
  DbContextError,
  dbContextSettings,
  normalizeDbContext,
  sameDbContext,
  type DbContext,
  type DbContextInput,
} from "./db-context-core";

type Sql = ReturnType<typeof postgres>;
type TransactionSql = postgres.TransactionSql<{}>;

export type DbContextTransactionOptions = "isolation level repeatable read";

type TransactionState = {
  kind: "transaction";
  context: DbContext;
  sql: TransactionSql;
};

type GuardState = { kind: "no_context_guard" };
type ContextState = TransactionState | GuardState;

export interface ContextualSql {
  sql: Sql;
  withDbContext<T>(
    context: DbContextInput,
    fn: () => T | Promise<T>,
    transactionOptions?: DbContextTransactionOptions,
  ): Promise<T>;
  withGuardedSql<T>(fn: () => T | Promise<T>): T | Promise<T>;
  currentDbContext(): DbContext | null;
}

const QUERY_METHODS = new Set([
  "array",
  "file",
  "json",
  "notify",
  "unsafe",
]);

const CONNECTION_METHODS = new Set([
  "largeObject",
  "listen",
  "reserve",
  "subscribe",
]);

/**
 * Build the transaction-aware facade around one postgres.js pool.
 *
 * The exported default instance is used by store.ts. Injection exists so the
 * isolation/savepoint contract can be proven without a database or network.
 */
export function createContextualSql(baseSql: Sql): ContextualSql {
  const storage = new AsyncLocalStorage<ContextState>();

  function currentQuerySql(): Sql | TransactionSql {
    const state = storage.getStore();
    if (state?.kind === "transaction") return state.sql;
    if (state?.kind === "no_context_guard") {
      throw new DbContextError("missing_db_context");
    }
    return baseSql;
  }

  async function applySettings(tx: TransactionSql, context: DbContext): Promise<void> {
    const [tenantId, organizationId, userId, access] = dbContextSettings(context);
    await tx`
      select
        set_config('app.tenant_id', ${tenantId}, true),
        set_config('app.organization_id', ${organizationId}, true),
        set_config('app.user_id', ${userId}, true),
        set_config('app.access', ${access}, true)`;
  }

  async function withDbContext<T>(
    input: DbContextInput,
    fn: () => T | Promise<T>,
    transactionOptions?: DbContextTransactionOptions,
  ): Promise<T> {
    const context = normalizeDbContext(input);
    const current = storage.getStore();

    if (current?.kind === "transaction") {
      if (!sameDbContext(current.context, context)) {
        throw new DbContextError("nested_context_mismatch");
      }
      if (transactionOptions !== undefined) {
        throw new DbContextError("nested_context_mismatch");
      }
      return current.sql.savepoint(async (savepointSql) => {
        await applySettings(savepointSql, context);
        return storage.run(
          { kind: "transaction", context, sql: savepointSql },
          fn,
        );
      }) as Promise<T>;
    }

    const run = async (tx: TransactionSql): Promise<T> => {
      await applySettings(tx, context);
      return storage.run({ kind: "transaction", context, sql: tx }, fn);
    };
    return (
      transactionOptions === undefined
        ? baseSql.begin(run)
        : baseSql.begin(transactionOptions, run)
    ) as Promise<T>;
  }

  function withGuardedSql<T>(fn: () => T | Promise<T>): T | Promise<T> {
    if (storage.getStore()?.kind === "transaction") return fn();
    return storage.run({ kind: "no_context_guard" }, fn);
  }

  const callable = function (
    first: unknown,
    ...rest: readonly unknown[]
  ): unknown {
    return (currentQuerySql() as any)(first, ...rest);
  };

  const facade = new Proxy(callable, {
    get(_target, property) {
      if (property === "begin") {
        return <T>(
          optionsOrCallback:
            | string
            | ((tx: TransactionSql) => T | Promise<T>),
          maybeCallback?: (tx: TransactionSql) => T | Promise<T>,
        ) => {
          const callback =
            typeof optionsOrCallback === "function"
              ? optionsOrCallback
              : maybeCallback;
          if (!callback) throw new TypeError("sql.begin requires a callback");

          const current = storage.getStore();
          if (current?.kind === "no_context_guard") {
            throw new DbContextError("missing_db_context");
          }
          if (current?.kind === "transaction") {
            return current.sql.savepoint((savepointSql) =>
              storage.run(
                {
                  kind: "transaction",
                  context: current.context,
                  sql: savepointSql,
                },
                () => callback(savepointSql),
              ),
            );
          }
          return typeof optionsOrCallback === "string"
            ? baseSql.begin(optionsOrCallback, callback)
            : baseSql.begin(callback);
        };
      }

      // Closing the shared pool is an application-lifecycle operation, not a
      // tenant query. Preserve the existing `close() -> sql.end()` contract.
      if (property === "end") return baseSql.end.bind(baseSql);

      if (CONNECTION_METHODS.has(String(property))) {
        const current = storage.getStore();
        if (current) {
          return () => {
            throw new DbContextError(
              current.kind === "no_context_guard"
                ? "missing_db_context"
                : "nested_context_mismatch",
            );
          };
        }
        const value = Reflect.get(baseSql, property);
        return typeof value === "function" ? value.bind(baseSql) : value;
      }

      if (QUERY_METHODS.has(String(property))) {
        const active = currentQuerySql() as any;
        const value = Reflect.get(active, property);
        return typeof value === "function" ? value.bind(active) : value;
      }

      return Reflect.get(baseSql, property);
    },
    apply(_target, _thisArg, args) {
      return (currentQuerySql() as any)(...args);
    },
  }) as unknown as Sql;

  return {
    sql: facade,
    withDbContext,
    withGuardedSql,
    currentDbContext(): DbContext | null {
      const state = storage.getStore();
      return state?.kind === "transaction" ? state.context : null;
    },
  };
}

export type { DbContext, DbContextInput };
