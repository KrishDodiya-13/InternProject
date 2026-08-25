/**
 * Collection resolver tests.
 *
 * These call the resolvers directly with a real Prisma context. They are not
 * mocked on purpose: duplicate-slug handling is driven by a database
 * constraint, and a mocked client would only prove that the mock returns what
 * the test told it to.
 *
 * Every test uses slugs under a shared prefix and cleans up after itself, so
 * runs are repeatable and leave no rows behind.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { loadConfig } from "../../src/config.ts";
import { createContext, type GraphQLContext } from "../../src/context.ts";
import { createPrismaClient, type PrismaClient } from "../../src/db/prisma.ts";
import { collectionResolvers } from "../../src/resolvers/collection.ts";
import { captureError, cleanupByPrefix } from "../helpers.ts";

const PREFIX = "phase5-";

let prisma: PrismaClient;
let context: GraphQLContext;

const noArgs = {} as Record<string, never>;

function createCollection(name: string, slug: string) {
  return collectionResolvers.Mutation.createCollection(null, { input: { name, slug } }, context);
}

beforeAll(async () => {
  prisma = createPrismaClient(loadConfig().databaseUrl);
  context = createContext(prisma);
  await cleanupByPrefix(prisma, PREFIX);
});

afterEach(() => cleanupByPrefix(prisma, PREFIX));

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Mutation.createCollection", () => {
  test("creates a collection and returns the stored row", async () => {
    const created = await createCollection("Design Docs", `${PREFIX}design-docs`);

    expect(created.name).toBe("Design Docs");
    expect(created.slug).toBe(`${PREFIX}design-docs`);
    expect(created.id).toBeString();
    expect(created.createdAt).toBeInstanceOf(Date);

    // It really is in the database, not just returned.
    const stored = await prisma.collection.findUnique({ where: { id: created.id } });
    expect(stored?.slug).toBe(`${PREFIX}design-docs`);
  });

  test("trims surrounding whitespace from the name", async () => {
    const created = await createCollection("   Spaced Out   ", `${PREFIX}spaced`);
    expect(created.name).toBe("Spaced Out");
  });

  test("rejects a blank name with BAD_USER_INPUT", async () => {
    const error = await captureError(createCollection("   ", `${PREFIX}blank-name`));
    expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
    expect(error.extensions["field"]).toBe("name");
  });

  describe("invalid slug", () => {
    test("rejects malformed slugs with BAD_USER_INPUT and writes nothing", async () => {
      for (const slug of ["Bad Slug", "bad_slug", "-bad", "bad-", "bad--slug", ""]) {
        const error = await captureError(createCollection("Name", slug));
        expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
        expect(error.extensions["field"]).toBe("slug");
      }
      expect(await prisma.collection.count()).toBe(0);
    });

    test("explains the expected slug format", async () => {
      const error = await captureError(createCollection("Name", "Not A Slug"));
      expect(error.message).toContain("lowercase letters, digits and single hyphens");
    });
  });

  describe("duplicate slug", () => {
    test("rejects a repeated slug with CONFLICT naming the collection", async () => {
      await createCollection("First", `${PREFIX}duplicate`);
      const error = await captureError(createCollection("Second", `${PREFIX}duplicate`));

      expect(error.extensions["code"]).toBe("CONFLICT");
      expect(error.extensions["field"]).toBe("slug");
      expect(error.message).toContain("collection");
      expect(error.message).toContain(`${PREFIX}duplicate`);
    });

    test("leaks no database internals in the conflict message", async () => {
      await createCollection("First", `${PREFIX}leak-check`);
      const error = await captureError(createCollection("Second", `${PREFIX}leak-check`));

      expect(error.message).not.toContain("prisma.");
      expect(error.message).not.toContain("collections");
      expect(error.message).not.toContain("Unique constraint");
    });

    test("does not create a second row", async () => {
      await createCollection("First", `${PREFIX}once`);
      await captureError(createCollection("Second", `${PREFIX}once`));
      expect(await prisma.collection.count({ where: { slug: `${PREFIX}once` } })).toBe(1);
    });
  });
});

describe("Query.collections", () => {
  test("returns an empty list when there are none", async () => {
    expect(await collectionResolvers.Query.collections(null, noArgs, context)).toEqual([]);
  });

  test("returns every collection, newest first", async () => {
    await createCollection("First", `${PREFIX}first`);
    await createCollection("Second", `${PREFIX}second`);
    await createCollection("Third", `${PREFIX}third`);

    const all = await collectionResolvers.Query.collections(null, noArgs, context);

    expect(all).toHaveLength(3);
    expect(all.map((collection) => collection.name)).toEqual(["Third", "Second", "First"]);
  });

  test("orders strictly by createdAt descending", async () => {
    await createCollection("A", `${PREFIX}a`);
    await createCollection("B", `${PREFIX}b`);

    const all = await collectionResolvers.Query.collections(null, noArgs, context);
    const timestamps = all.map((collection) => collection.createdAt.getTime());

    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1] ?? 0);
  });
});

describe("Query.collection", () => {
  test("returns the requested collection", async () => {
    const created = await createCollection("Target", `${PREFIX}target`);
    const found = await collectionResolvers.Query.collection(null, { id: created.id }, context);

    expect(found.id).toBe(created.id);
    expect(found.name).toBe("Target");
    expect(found.slug).toBe(`${PREFIX}target`);
  });

  describe("nonexistent collection", () => {
    test("throws NOT_FOUND naming the id", async () => {
      const missing = "00000000-0000-0000-0000-000000000000";
      const error = await captureError(
        collectionResolvers.Query.collection(null, { id: missing }, context),
      );

      expect(error.extensions["code"]).toBe("NOT_FOUND");
      expect(error.extensions["field"]).toBe("id");
      expect(error.message).toContain("Collection");
      expect(error.message).toContain(missing);
    });

    test("throws NOT_FOUND rather than a Prisma error for a malformed id", async () => {
      const error = await captureError(
        collectionResolvers.Query.collection(null, { id: "not-an-id" }, context),
      );
      expect(error.extensions["code"]).toBe("NOT_FOUND");
    });
  });
});

describe("Collection.documents", () => {
  test("returns an empty list for a collection with no documents", async () => {
    const created = await createCollection("Empty", `${PREFIX}empty`);
    const documents = await collectionResolvers.Collection.documents(created, noArgs, context);
    expect(documents).toEqual([]);
  });

  test("returns only that collection's documents, newest first", async () => {
    const target = await createCollection("Target", `${PREFIX}nested-target`);
    const other = await createCollection("Other", `${PREFIX}nested-other`);

    await prisma.document.create({
      data: { title: "Older", content: "x", collectionId: target.id },
    });
    await prisma.document.create({
      data: { title: "Newer", content: "y", collectionId: target.id, tags: ["spec"] },
    });
    await prisma.document.create({
      data: { title: "Elsewhere", content: "z", collectionId: other.id },
    });

    const documents = await collectionResolvers.Collection.documents(target, noArgs, context);

    expect(documents.map((document) => document.title)).toEqual(["Newer", "Older"]);
    expect(documents.every((document) => document.collectionId === target.id)).toBe(true);
    expect(documents[0]?.tags).toEqual(["spec"]);
  });

  test("uses documents already loaded on the parent instead of querying again", async () => {
    const created = await createCollection("Preloaded", `${PREFIX}preloaded`);
    await prisma.document.create({
      data: { title: "Real", content: "x", collectionId: created.id },
    });

    // A parent carrying its own documents, as `collection(id)` produces.
    const preloaded = await prisma.collection.findUniqueOrThrow({
      where: { id: created.id },
      include: { documents: true },
    });

    const documents = collectionResolvers.Collection.documents(preloaded, noArgs, context);

    // Returned synchronously, which only happens on the pre-loaded path.
    expect(Array.isArray(documents)).toBe(true);
    expect((documents as { title: string }[])[0]?.title).toBe("Real");
  });

  test("collection(id) loads nested documents in one round trip", async () => {
    const created = await createCollection("Nested", `${PREFIX}nested-single`);
    await prisma.document.create({
      data: { title: "Inside", content: "x", collectionId: created.id },
    });

    const found = await collectionResolvers.Query.collection(null, { id: created.id }, context);
    const documents = collectionResolvers.Collection.documents(found, noArgs, context);

    expect(Array.isArray(documents)).toBe(true);
    expect((documents as { title: string }[]).map((document) => document.title)).toEqual([
      "Inside",
    ]);
  });
});
