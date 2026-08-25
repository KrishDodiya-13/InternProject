/**
 * Existence checks against the real Dockerized PostgreSQL database.
 *
 * These are deliberately not mocked: the point is to prove that a real
 * missing row produces a NOT_FOUND GraphQL error rather than a Prisma
 * exception. The full-stack API integration test lives alongside this file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GraphQLError } from "graphql";

import { loadConfig } from "../../src/config.ts";
import { createPrismaClient, type PrismaClient } from "../../src/db/prisma.ts";
import { captureError } from "../helpers.ts";
import {
  requireCollectionExists,
  requireDocumentExists,
} from "../../src/validation/lookups.ts";

let prisma: PrismaClient;
let collectionId: string;
let documentId: string;

const SLUG = "lookup-test-collection";

beforeAll(async () => {
  prisma = createPrismaClient(loadConfig().databaseUrl);

  // Start from a clean slate in case a previous run was interrupted.
  await prisma.document.deleteMany({ where: { collection: { slug: SLUG } } });
  await prisma.collection.deleteMany({ where: { slug: SLUG } });

  const collection = await prisma.collection.create({
    data: { name: "Lookup Test", slug: SLUG },
  });
  collectionId = collection.id;

  const document = await prisma.document.create({
    data: { title: "Lookup Test Doc", content: "body", collectionId },
  });
  documentId = document.id;
});

afterAll(async () => {
  await prisma.document.deleteMany({ where: { collectionId } });
  await prisma.collection.deleteMany({ where: { id: collectionId } });
  await prisma.$disconnect();
});

describe("requireCollectionExists", () => {
  test("returns the id when the collection exists", async () => {
    await expect(requireCollectionExists(prisma, collectionId)).resolves.toBe(collectionId);
  });

  test("throws NOT_FOUND for an id that does not exist", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    const error = await captureError(requireCollectionExists(prisma, missing));
    expect(error.extensions["code"]).toBe("NOT_FOUND");
    expect(error.extensions["field"]).toBe("collectionId");
    expect(error.message).toContain("Collection");
    expect(error.message).toContain(missing);
  });

  test("throws NOT_FOUND rather than a Prisma error for a non-uuid id", async () => {
    const error = await captureError(requireCollectionExists(prisma, "not-a-uuid"));
    expect(error).toBeInstanceOf(GraphQLError);
    expect(error.extensions["code"]).toBe("NOT_FOUND");
  });
});

describe("requireDocumentExists", () => {
  test("returns the id when the document exists", async () => {
    await expect(requireDocumentExists(prisma, documentId)).resolves.toBe(documentId);
  });

  test("throws NOT_FOUND for an id that does not exist", async () => {
    const missing = "11111111-1111-1111-1111-111111111111";
    const error = await captureError(requireDocumentExists(prisma, missing));
    expect(error.extensions["code"]).toBe("NOT_FOUND");
    expect(error.extensions["field"]).toBe("id");
    expect(error.message).toContain("Document");
  });

  test("never leaks database internals in the message", async () => {
    const error = await captureError(requireDocumentExists(prisma, "bogus"));
    expect(error.message).not.toContain("prisma");
    expect(error.message).not.toContain("documents");
    expect(error.message).not.toContain("SELECT");
  });
});
