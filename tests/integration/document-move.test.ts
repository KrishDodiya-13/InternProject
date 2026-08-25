/**
 * `moveDocument` tests, against real PostgreSQL.
 *
 * Moving is the one operation that changes which collection a document
 * belongs to, so the assertions check both sides of the move: the document
 * leaves the old collection and appears in the new one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CollectionModel, DocumentModel } from "../../generated/prisma/models.ts";
import { loadConfig } from "../../src/config.ts";
import { createContext, type GraphQLContext } from "../../src/context.ts";
import { createPrismaClient, type PrismaClient } from "../../src/db/prisma.ts";
import { collectionResolvers } from "../../src/resolvers/collection.ts";
import { documentResolvers } from "../../src/resolvers/document.ts";
import { captureError, cleanupByPrefix } from "../helpers.ts";

const PREFIX = "phase9-";
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

let prisma: PrismaClient;
let context: GraphQLContext;
let source: CollectionModel;
let target: CollectionModel;
let document: DocumentModel;

const noArgs = {} as Record<string, never>;

function move(id: string, collectionId: string): Promise<DocumentModel> {
  return documentResolvers.Mutation.moveDocument(null, { id, collectionId }, context);
}

/** Titles of the documents the given collection currently exposes. */
async function documentsIn(collection: CollectionModel): Promise<string[]> {
  const nested = await collectionResolvers.Collection.documents(collection, noArgs, context);
  return (await nested).map((entry) => entry.title);
}

beforeEach(async () => {
  prisma ??= createPrismaClient(loadConfig().databaseUrl);
  context ??= createContext(prisma);
  await cleanupByPrefix(prisma, PREFIX);

  source = await prisma.collection.create({
    data: { name: "Source", slug: `${PREFIX}source` },
  });
  target = await prisma.collection.create({
    data: { name: "Target", slug: `${PREFIX}target` },
  });
  document = await prisma.document.create({
    data: {
      title: "Movable",
      content: "body",
      tags: ["keep"],
      collectionId: source.id,
    },
  });
});

afterEach(() => cleanupByPrefix(prisma, PREFIX));

afterAll(async () => {
  await prisma.$disconnect();
});

describe("successful move", () => {
  test("returns the updated document", async () => {
    const moved = await move(document.id, target.id);

    expect(moved.id).toBe(document.id);
    expect(moved.collectionId).toBe(target.id);
  });

  test("persists the new collection", async () => {
    await move(document.id, target.id);
    const stored = await prisma.document.findUnique({ where: { id: document.id } });
    expect(stored?.collectionId).toBe(target.id);
  });

  test("leaves every other field untouched", async () => {
    const moved = await move(document.id, target.id);

    expect(moved.title).toBe("Movable");
    expect(moved.content).toBe("body");
    expect(moved.tags).toEqual(["keep"]);
    expect(moved.isArchived).toBe(false);
    expect(moved.createdAt.getTime()).toBe(document.createdAt.getTime());
  });

  test("the old collection no longer returns the document", async () => {
    expect(await documentsIn(source)).toEqual(["Movable"]);
    await move(document.id, target.id);
    expect(await documentsIn(source)).toEqual([]);
  });

  test("the new collection returns the document", async () => {
    expect(await documentsIn(target)).toEqual([]);
    await move(document.id, target.id);
    expect(await documentsIn(target)).toEqual(["Movable"]);
  });

  test("the documents query reflects the move on both collections", async () => {
    await move(document.id, target.id);

    const fromSource = await documentResolvers.Query.documents(
      null,
      { filter: { collectionId: source.id } },
      context,
    );
    const fromTarget = await documentResolvers.Query.documents(
      null,
      { filter: { collectionId: target.id } },
      context,
    );

    expect(fromSource.nodes).toEqual([]);
    expect(fromTarget.nodes.map((node) => node.title)).toEqual(["Movable"]);
  });

  test("moves back again", async () => {
    await move(document.id, target.id);
    const back = await move(document.id, source.id);

    expect(back.collectionId).toBe(source.id);
    expect(await documentsIn(source)).toEqual(["Movable"]);
    expect(await documentsIn(target)).toEqual([]);
  });

  test("moves only the requested document", async () => {
    const sibling = await prisma.document.create({
      data: { title: "Stays", content: "x", collectionId: source.id },
    });

    await move(document.id, target.id);

    const stored = await prisma.document.findUnique({ where: { id: sibling.id } });
    expect(stored?.collectionId).toBe(source.id);
    expect(await documentsIn(target)).toEqual(["Movable"]);
  });
});

describe("moving to the same collection", () => {
  test("is accepted as a no-op", async () => {
    const moved = await move(document.id, source.id);
    expect(moved.collectionId).toBe(source.id);
    expect(moved.title).toBe("Movable");
  });

  test("leaves the collection contents unchanged", async () => {
    await move(document.id, source.id);
    expect(await documentsIn(source)).toEqual(["Movable"]);
    expect(await documentsIn(target)).toEqual([]);
  });

  test("does not duplicate the document", async () => {
    await move(document.id, source.id);
    await move(document.id, source.id);
    expect(await prisma.document.count()).toBe(1);
  });
});

describe("nonexistent document", () => {
  test("errors with NOT_FOUND naming the document id", async () => {
    const error = await captureError(move(MISSING_ID, target.id));

    expect(error.extensions["code"]).toBe("NOT_FOUND");
    expect(error.extensions["field"]).toBe("id");
    expect(error.message).toContain("Document");
    expect(error.message).toContain(MISSING_ID);
  });

  test("errors on a malformed document id too", async () => {
    const error = await captureError(move("not-an-id", target.id));
    expect(error.extensions["code"]).toBe("NOT_FOUND");
  });

  test("changes nothing", async () => {
    await captureError(move(MISSING_ID, target.id));
    expect(await documentsIn(source)).toEqual(["Movable"]);
    expect(await documentsIn(target)).toEqual([]);
  });
});

describe("nonexistent target collection", () => {
  test("errors with NOT_FOUND naming the collection", async () => {
    const error = await captureError(move(document.id, MISSING_ID));

    expect(error.extensions["code"]).toBe("NOT_FOUND");
    expect(error.extensions["field"]).toBe("collectionId");
    expect(error.message).toContain("Collection");
    expect(error.message).toContain(MISSING_ID);
  });

  test("does not create the missing collection", async () => {
    const before = await prisma.collection.count();
    await captureError(move(document.id, MISSING_ID));

    expect(await prisma.collection.count()).toBe(before);
    expect(await prisma.collection.findUnique({ where: { id: MISSING_ID } })).toBeNull();
  });

  test("leaves the document in its original collection", async () => {
    await captureError(move(document.id, MISSING_ID));

    const stored = await prisma.document.findUnique({ where: { id: document.id } });
    expect(stored?.collectionId).toBe(source.id);
    expect(await documentsIn(source)).toEqual(["Movable"]);
  });

  test("reports the document first when both ids are unknown", async () => {
    const error = await captureError(move(MISSING_ID, MISSING_ID));
    expect(error.extensions["field"]).toBe("id");
    expect(error.message).toContain("Document");
  });

  test("leaks no database internals", async () => {
    const error = await captureError(move(document.id, MISSING_ID));
    expect(error.message).not.toContain("prisma.");
    expect(error.message).not.toContain("documents");
  });
});
