/**
 * Intentional GraphQL errors.
 *
 * Validation and lookup failures are raised as GraphQLError with an explicit
 * `extensions.code`, so clients receive a meaningful, machine-readable error
 * instead of an unhandled 500. Anything thrown that is *not* one of these is
 * treated as a genuine server fault and masked by the server.
 *
 * Three codes cover every case the API needs:
 *   BAD_USER_INPUT - the request was malformed or failed validation
 *   NOT_FOUND      - a referenced record does not exist
 *   CONFLICT       - the request clashes with existing data
 */
import { GraphQLError } from "graphql";

export const ErrorCode = {
  BAD_USER_INPUT: "BAD_USER_INPUT",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

function graphqlError(message: string, code: ErrorCode, field?: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: field === undefined ? { code } : { code, field },
  });
}

/** The client sent input that failed validation. */
export function badUserInput(message: string, field?: string): GraphQLError {
  return graphqlError(message, ErrorCode.BAD_USER_INPUT, field);
}

/**
 * A referenced entity does not exist. Passing the id makes the error
 * actionable; omitting it is for cases where the id is not known.
 */
export function notFound(entity: string, id?: string, field = "id"): GraphQLError {
  const message =
    id === undefined
      ? `${entity} was not found.`
      : `${entity} with id "${id}" was not found.`;
  return graphqlError(message, ErrorCode.NOT_FOUND, field);
}

/** The request conflicts with existing data, e.g. a duplicate unique value. */
export function conflict(message: string, field?: string): GraphQLError {
  return graphqlError(message, ErrorCode.CONFLICT, field);
}

/**
 * True for errors this application raised deliberately. Used by the server to
 * decide which errors are safe to expose verbatim to the client.
 */
export function isIntentionalError(error: unknown): error is GraphQLError {
  if (!(error instanceof GraphQLError)) {
    return false;
  }
  const code = error.extensions["code"];
  return typeof code === "string" && code in ErrorCode;
}
