/**
 * GraphQL execution context.
 *
 * Every resolver receives this object as its third argument. Keeping the
 * Prisma client on the context (rather than importing a module-level
 * singleton inside resolvers) is what allows integration tests to run the
 * real resolvers against a real, test-owned database connection.
 */
import type { PrismaClient } from "./db/prisma.ts";

export interface GraphQLContext {
  readonly prisma: PrismaClient;
}

export function createContext(prisma: PrismaClient): GraphQLContext {
  return { prisma };
}
