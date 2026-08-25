/**
 * Custom scalars.
 *
 * `DateTime` is represented on the wire as an ISO-8601 string and as a
 * JavaScript `Date` inside resolvers, which is exactly what Prisma returns
 * for `DateTime` columns.
 */
import { GraphQLScalarType, Kind, type ValueNode } from "graphql";

import { badUserInput } from "../validation/errors.ts";

function parseDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badUserInput(`"${value}" is not a valid ISO-8601 date-time.`);
  }
  return parsed;
}

export const DateTimeScalar = new GraphQLScalarType<Date, string>({
  name: "DateTime",
  description: "An ISO-8601 date-time string, e.g. `2026-08-25T05:39:07.123Z`.",

  /** Resolver value -> response. */
  serialize(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === "string") {
      return parseDate(value).toISOString();
    }
    throw badUserInput("DateTime values must be Date objects or ISO-8601 strings.");
  },

  /** Variable value -> resolver. */
  parseValue(value: unknown): Date {
    if (typeof value !== "string") {
      throw badUserInput("DateTime values must be provided as ISO-8601 strings.");
    }
    return parseDate(value);
  },

  /** Inline literal -> resolver. */
  parseLiteral(ast: ValueNode): Date {
    if (ast.kind !== Kind.STRING) {
      throw badUserInput("DateTime values must be provided as ISO-8601 strings.");
    }
    return parseDate(ast.value);
  },
});
