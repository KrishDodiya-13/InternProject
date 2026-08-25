/**
 * Prisma client construction.
 *
 * All database access in the application goes through a PrismaClient created
 * here. Prisma 7 connects through a driver adapter, so the PostgreSQL adapter
 * owns the connection pool. The connection string is passed explicitly rather
 * than read implicitly from the environment, which keeps the dependency
 * visible and lets integration tests point the client at their own database.
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../generated/prisma/client.ts";

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

export type { PrismaClient };
