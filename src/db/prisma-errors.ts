/**
 * Translation of Prisma errors into intentional GraphQL errors.
 *
 * Prisma error messages embed table names, constraint names and even the
 * source file that issued the query. None of that belongs in an API response,
 * so the known error codes are mapped to clean messages here and everything
 * else is left for the server to mask as a genuine fault.
 *
 * Reference: https://www.prisma.io/docs/orm/reference/error-reference
 */
import type { GraphQLError } from "graphql";

import { Prisma } from "../../generated/prisma/client.ts";
import { badUserInput, conflict, notFound } from "../validation/errors.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return undefined;
}

/**
 * The columns a constraint violation refers to.
 *
 * Prisma reports these in one of two shapes depending on how the client is
 * connected: `meta.target` on the classic engine, and a structured
 * `meta.driverAdapterError.cause.constraint.fields` when a driver adapter is
 * in use - which is the case here, via `@prisma/adapter-pg`.
 */
function constraintFields(error: Prisma.PrismaClientKnownRequestError): string[] | undefined {
  const target = asStringArray(error.meta?.["target"]);
  if (target !== undefined) {
    return target;
  }

  const adapterError = error.meta?.["driverAdapterError"];
  if (!isRecord(adapterError) || !isRecord(adapterError["cause"])) {
    return undefined;
  }
  const constraint = adapterError["cause"]["constraint"];
  if (!isRecord(constraint)) {
    return undefined;
  }
  return asStringArray(constraint["fields"]);
}

/**
 * Maps a Prisma error to an intentional GraphQL error, or returns `undefined`
 * when the error is not one we can describe safely.
 */
export function translatePrismaError(error: unknown): GraphQLError | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return undefined;
  }

  switch (error.code) {
    // Unique constraint violation.
    case "P2002": {
      const fields = constraintFields(error);
      return fields === undefined
        ? conflict("A record with the same unique value already exists.")
        : conflict(`A record with this ${fields.join(", ")} already exists.`, fields.join(", "));
    }
    // Foreign key constraint violation: the referenced row does not exist.
    case "P2003":
      return badUserInput("A referenced record does not exist.");
    // Would break a required relation - our documents/collections restrict rule.
    case "P2014":
      return conflict("This record is still referenced by other records.");
    // An operation targeted a record that does not exist.
    case "P2025":
      return notFound("Record");
    default:
      return undefined;
  }
}

/**
 * True when the error is a unique constraint violation, optionally narrowed
 * to a specific field. Lets a resolver raise a message naming the entity
 * instead of the generic translation above.
 *
 * When Prisma does not report which columns were involved, a P2002 is
 * accepted for any requested field: the alternative is discarding a real
 * conflict, and the caller only asks about fields it actually constrains.
 */
export function isUniqueViolation(error: unknown, field?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  if (field === undefined) {
    return true;
  }
  const fields = constraintFields(error);
  return fields === undefined || fields.includes(field);
}

/**
 * True when the operation targeted a row that does not exist (P2025). Lets a
 * resolver turn a failed update or delete into a NOT_FOUND naming the entity,
 * without a separate existence check beforehand.
 */
export function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}
