/**
 * Shared test helpers.
 *
 * These were duplicated verbatim across every integration file; keeping one
 * copy means a fix to the cleanup or error-capture logic applies everywhere.
 */
import { GraphQLError } from "graphql";

import type { PrismaClient } from "../src/db/prisma.ts";

/**
 * Awaits `promise` and returns the GraphQLError it rejected with.
 *
 * Fails loudly if the call resolved, so a test asserting an error cannot pass
 * silently when the error stops being raised. Non-GraphQL errors are re-thrown
 * rather than swallowed.
 */
export async function captureError(promise: Promise<unknown>): Promise<GraphQLError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraphQLError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to reject with a GraphQLError");
}

/** Synchronous counterpart of {@link captureError}. */
export function captureErrorSync(fn: () => unknown): GraphQLError {
  try {
    fn();
  } catch (error) {
    if (error instanceof GraphQLError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to throw a GraphQLError");
}

/**
 * Deletes every collection whose slug starts with `prefix`, and the documents
 * inside them. Each test file owns a prefix, which is what keeps files from
 * disturbing each other's rows and makes a crashed run harmless.
 */
export async function cleanupByPrefix(prisma: PrismaClient, prefix: string): Promise<void> {
  await prisma.document.deleteMany({ where: { collection: { slug: { startsWith: prefix } } } });
  await prisma.collection.deleteMany({ where: { slug: { startsWith: prefix } } });
}
