/**
 * GraphQL Yoga server construction.
 *
 * Kept free of any process/listening concerns so that integration tests can
 * build a fully wired server and execute operations against it in-process.
 */
import { createYoga, maskError, type YogaServerInstance } from "graphql-yoga";

import { createContext, type GraphQLContext } from "./context.ts";
import type { PrismaClient } from "./db/prisma.ts";
import { translatePrismaError } from "./db/prisma-errors.ts";
import { buildSchema } from "./graphql/schema.ts";
import { isIntentionalError } from "./validation/errors.ts";

export type VaultServer = YogaServerInstance<Record<string, never>, GraphQLContext>;

/**
 * The single place error handling policy lives.
 *
 * 1. Errors this application raised deliberately pass through untouched.
 * 2. Recognised Prisma errors become clean intentional errors - the raw
 *    message, which names tables and columns, is discarded.
 * 3. Everything else is a genuine fault and is masked, so internal details
 *    never reach a client.
 *
 * Because every failure is turned into a structured GraphQL error, no
 * validation failure can become an unhandled 500.
 */
export function maskVaultError(error: unknown, message: string, isDev?: boolean): Error {
  if (isIntentionalError(error)) {
    return error;
  }

  // Resolver errors arrive wrapped by graphql-js; the cause is on originalError.
  const original =
    error instanceof Error && "originalError" in error ? error.originalError : undefined;

  if (isIntentionalError(original)) {
    return original;
  }

  const translated = translatePrismaError(error) ?? translatePrismaError(original);
  if (translated !== undefined) {
    return translated;
  }

  return maskError(error, message, isDev);
}

export function createServer(prisma: PrismaClient): VaultServer {
  return createYoga<Record<string, never>, GraphQLContext>({
    schema: buildSchema(),
    context: () => createContext(prisma),
    graphqlEndpoint: "/graphql",
    landingPage: false,
    maskedErrors: { maskError: maskVaultError },
  });
}
