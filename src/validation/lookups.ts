/**
 * Existence checks.
 *
 * Resolvers use these before acting on a referenced record, so a bad id
 * produces a clear NOT_FOUND error naming the entity rather than a Prisma
 * exception surfacing later in the operation.
 */
import type { PrismaClient } from "../db/prisma.ts";
import { notFound } from "./errors.ts";

/**
 * The slice of the Prisma client these checks need.
 *
 * Narrowing to the two delegates lets the same helpers run against either the
 * client or a transaction handle, which is what `moveDocument` needs to do
 * its checks and its write inside one transaction.
 */
export type DbClient = Pick<PrismaClient, "collection" | "document">;

/**
 * Throws NOT_FOUND unless a collection with this id exists.
 * Returns the id so it can be used inline.
 */
export async function requireCollectionExists(
  prisma: DbClient,
  id: string,
  field = "collectionId",
): Promise<string> {
  const found = await prisma.collection.findUnique({ where: { id }, select: { id: true } });
  if (found === null) {
    throw notFound("Collection", id, field);
  }
  return found.id;
}

/** Throws NOT_FOUND unless a document with this id exists. */
export async function requireDocumentExists(
  prisma: DbClient,
  id: string,
  field = "id",
): Promise<string> {
  const found = await prisma.document.findUnique({ where: { id }, select: { id: true } });
  if (found === null) {
    throw notFound("Document", id, field);
  }
  return found.id;
}
