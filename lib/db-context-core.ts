export const DB_ACCESS_LEVELS = [
  "owner",
  "admin",
  "member",
  "creator",
  "machine",
  "worker",
  "internal_advisory",
  "test",
] as const;

export type DbAccessLevel = (typeof DB_ACCESS_LEVELS)[number];

export interface DbContextInput {
  tenantId: string;
  organizationId: string | null;
  userId: string | null;
  access: DbAccessLevel;
}

export interface DbContext extends DbContextInput {
  readonly tenantId: string;
  readonly organizationId: string | null;
  readonly userId: string | null;
  readonly access: DbAccessLevel;
}

export class DbContextError extends Error {
  constructor(
    readonly code:
      | "invalid_context"
      | "missing_db_context"
      | "nested_context_mismatch",
  ) {
    super(
      code === "invalid_context"
        ? "Trusted database context is invalid."
        : code === "missing_db_context"
          ? "Database access requires a trusted transaction context."
          : "A nested database transaction cannot change trusted context.",
    );
    this.name = "DbContextError";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS = new Set<string>(DB_ACCESS_LEVELS);

function nullableUuid(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

export function normalizeDbContext(input: DbContextInput): DbContext {
  const tenantId =
    typeof input?.tenantId === "string" && UUID.test(input.tenantId)
      ? input.tenantId.toLowerCase()
      : "";
  const organizationId = nullableUuid(input?.organizationId);
  const userId = nullableUuid(input?.userId);
  const access = ACCESS.has(input?.access) ? input.access : null;

  const humanAccess =
    access === "owner"
    || access === "admin"
    || access === "member"
    || access === "creator";
  const machineAccess = access === "machine";

  if (
    !tenantId
    || organizationId === undefined
    || userId === undefined
    || !access
    || (humanAccess && (!organizationId || !userId))
    || (machineAccess && !organizationId)
  ) {
    throw new DbContextError("invalid_context");
  }

  return Object.freeze({ tenantId, organizationId, userId, access });
}

export function sameDbContext(left: DbContext, right: DbContext): boolean {
  return (
    left.tenantId === right.tenantId
    && left.organizationId === right.organizationId
    && left.userId === right.userId
    && left.access === right.access
  );
}

export function dbContextSettings(
  context: DbContext,
): readonly [
  tenantId: string,
  organizationId: string,
  userId: string,
  access: DbAccessLevel,
] {
  return [
    context.tenantId,
    context.organizationId ?? "",
    context.userId ?? "",
    context.access,
  ];
}
