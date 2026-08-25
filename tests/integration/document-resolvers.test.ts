/**
 * Document resolver tests, run against the real Dockerized PostgreSQL.
 *
 * Not mocked: missing-row handling is driven by database error codes, and a
 * mocked client would only replay whatever the test told it to.
 *
 * Every row created here lives under a collection with a known slug prefix
 * and is removed after each test, so runs are repeatable.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CollectionModel, DocumentModel } from "../../generated/prisma/models.ts";
import { loadConfig } from "../../src/config.ts";
import { createContext, type GraphQLContext } from "../../src/context.ts";
import { createPrismaClient, type PrismaClient } from "../../src/db/prisma.ts";
import { documentResolvers } from "../../src/resolvers/document.ts";
import { captureError, cleanupByPrefix } from "../helpers.ts";

const PREFIX = "phase6-";
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

let prisma: PrismaClient;
let context: GraphQLContext;
let collection: CollectionModel;

function create(
  input: Partial<{
    title: string;
    content: string;
    collectionId: string;
    tags: string[];
    isArchived: boolean;
  }> = {},
): Promise<DocumentModel> {
  return documentResolvers.Mutation.createDocument(
    null,
    {
      input: {
        title: input.title ?? "A title",
        content: input.content ?? "Some content",
        collectionId: input.collectionId ?? collection.id,
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.isArchived === undefined ? {} : { isArchived: input.isArchived }),
      },
    },
    context,
  );
}

beforeEach(async () => {
  prisma ??= createPrismaClient(loadConfig().databaseUrl);
  context ??= createContext(prisma);
  await cleanupByPrefix(prisma, PREFIX);
  collection = await prisma.collection.create({
    data: { name: "Phase 6", slug: `${PREFIX}docs` },
  });
});

afterEach(() => cleanupByPrefix(prisma, PREFIX));

afterAll(async () => {
  await prisma.$disconnect();
});

describe("createDocument", () => {
  describe("successful creation", () => {
    test("creates and persists a document", async () => {
      const created = await create({ title: "Spec", content: "The body", tags: ["a", "b"] });

      expect(created.title).toBe("Spec");
      expect(created.content).toBe("The body");
      expect(created.tags).toEqual(["a", "b"]);
      expect(created.collectionId).toBe(collection.id);
      expect(created.createdAt).toBeInstanceOf(Date);

      const stored = await prisma.document.findUnique({ where: { id: created.id } });
      expect(stored?.title).toBe("Spec");
    });

    test("defaults isArchived to false", async () => {
      expect((await create()).isArchived).toBe(false);
    });

    test("honours isArchived when explicitly supplied", async () => {
      expect((await create({ isArchived: true })).isArchived).toBe(true);
    });

    test("defaults tags to an empty list", async () => {
      expect((await create()).tags).toEqual([]);
    });

    test("trims the title and de-duplicates tags", async () => {
      const created = await create({ title: "  Padded  ", tags: [" x ", "y", "x"] });
      expect(created.title).toBe("Padded");
      expect(created.tags).toEqual(["x", "y"]);
    });
  });

  describe("invalid title", () => {
    test("rejects an empty title", async () => {
      const error = await captureError(create({ title: "" }));
      expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
      expect(error.extensions["field"]).toBe("title");
    });

    test("rejects a whitespace-only title", async () => {
      const error = await captureError(create({ title: "   \t\n " }));
      expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
      expect(error.extensions["field"]).toBe("title");
    });

    test("writes nothing when the title is invalid", async () => {
      await captureError(create({ title: "  " }));
      expect(await prisma.document.count()).toBe(0);
    });
  });

  describe("invalid content", () => {
    test("rejects empty content", async () => {
      const error = await captureError(create({ content: "" }));
      expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
      expect(error.extensions["field"]).toBe("content");
    });

    test("rejects whitespace-only content", async () => {
      const error = await captureError(create({ content: "\n\t  " }));
      expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
      expect(error.extensions["field"]).toBe("content");
    });

    test("writes nothing when the content is invalid", async () => {
      await captureError(create({ content: "   " }));
      expect(await prisma.document.count()).toBe(0);
    });
  });

  describe("nonexistent collection", () => {
    test("rejects with NOT_FOUND naming collectionId", async () => {
      const error = await captureError(create({ collectionId: MISSING_ID }));
      expect(error.extensions["code"]).toBe("NOT_FOUND");
      expect(error.extensions["field"]).toBe("collectionId");
      expect(error.message).toContain("Collection");
      expect(error.message).toContain(MISSING_ID);
    });

    test("rejects a malformed collection id the same way", async () => {
      const error = await captureError(create({ collectionId: "not-an-id" }));
      expect(error.extensions["code"]).toBe("NOT_FOUND");
    });

    test("writes nothing when the collection is missing", async () => {
      await captureError(create({ collectionId: MISSING_ID }));
      expect(await prisma.document.count()).toBe(0);
    });
  });
});

describe("updateDocument", () => {
  function update(
    id: string,
    input: {
      title?: string | null;
      content?: string | null;
      tags?: string[] | null;
      isArchived?: boolean | null;
    },
  ): Promise<DocumentModel> {
    return documentResolvers.Mutation.updateDocument(null, { id, input }, context);
  }

  describe("successful update", () => {
    test("updates every supplied field", async () => {
      const created = await create({ title: "Old", content: "Old body", tags: ["old"] });
      const updated = await update(created.id, {
        title: "New",
        content: "New body",
        tags: ["new"],
        isArchived: true,
      });

      expect(updated.title).toBe("New");
      expect(updated.content).toBe("New body");
      expect(updated.tags).toEqual(["new"]);
      expect(updated.isArchived).toBe(true);
      expect(updated.id).toBe(created.id);
    });

    test("persists the change", async () => {
      const created = await create({ title: "Old" });
      await update(created.id, { title: "Persisted" });
      const stored = await prisma.document.findUnique({ where: { id: created.id } });
      expect(stored?.title).toBe("Persisted");
    });

    test("validates a supplied title", async () => {
      const created = await create();
      const error = await captureError(update(created.id, { title: "   " }));
      expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
      expect(error.extensions["field"]).toBe("title");
    });

    test("validates supplied content", async () => {
      const created = await create();
      const error = await captureError(update(created.id, { content: "" }));
      expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
      expect(error.extensions["field"]).toBe("content");
    });

    test("leaves the row untouched when validation fails", async () => {
      const created = await create({ title: "Untouched" });
      await captureError(update(created.id, { title: " " }));
      const stored = await prisma.document.findUnique({ where: { id: created.id } });
      expect(stored?.title).toBe("Untouched");
    });
  });

  describe("partial update", () => {
    test("changes only the supplied field", async () => {
      const created = await create({
        title: "Keep title",
        content: "Keep content",
        tags: ["keep"],
      });

      const updated = await update(created.id, { isArchived: true });

      expect(updated.isArchived).toBe(true);
      expect(updated.title).toBe("Keep title");
      expect(updated.content).toBe("Keep content");
      expect(updated.tags).toEqual(["keep"]);
      expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
    });

    test("can update the title alone", async () => {
      const created = await create({ content: "Unchanged", tags: ["t"] });
      const updated = await update(created.id, { title: "Only title" });

      expect(updated.title).toBe("Only title");
      expect(updated.content).toBe("Unchanged");
      expect(updated.tags).toEqual(["t"]);
    });

    test("can clear tags with an empty list", async () => {
      const created = await create({ tags: ["a", "b"] });
      expect((await update(created.id, { tags: [] })).tags).toEqual([]);
    });

    test("can unarchive", async () => {
      const created = await create({ isArchived: true });
      expect((await update(created.id, { isArchived: false })).isArchived).toBe(false);
    });

    test("treats an explicit null as 'leave unchanged'", async () => {
      const created = await create({ title: "Kept" });
      const updated = await update(created.id, { title: null, isArchived: true });

      expect(updated.title).toBe("Kept");
      expect(updated.isArchived).toBe(true);
    });

    test("rejects an update with no fields at all", async () => {
      const created = await create();
      const error = await captureError(update(created.id, {}));
      expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
      expect(error.message).toContain("at least one field");
    });
  });

  describe("nonexistent document", () => {
    test("rejects with NOT_FOUND naming the id", async () => {
      const error = await captureError(update(MISSING_ID, { title: "New" }));
      expect(error.extensions["code"]).toBe("NOT_FOUND");
      expect(error.extensions["field"]).toBe("id");
      expect(error.message).toContain("Document");
      expect(error.message).toContain(MISSING_ID);
    });

    test("leaks no database internals", async () => {
      const error = await captureError(update(MISSING_ID, { title: "New" }));
      expect(error.message).not.toContain("prisma.");
      expect(error.message).not.toContain("documents");
    });
  });
});

describe("deleteDocument", () => {
  function remove(id: string) {
    return documentResolvers.Mutation.deleteDocument(null, { id }, context);
  }

  describe("successful deletion", () => {
    test("returns the echoed id and deleted flag", async () => {
      const created = await create();
      expect(await remove(created.id)).toEqual({ id: created.id, deleted: true });
    });

    test("removes the row from the database", async () => {
      const created = await create();
      await remove(created.id);
      expect(await prisma.document.findUnique({ where: { id: created.id } })).toBeNull();
    });

    test("leaves other documents alone", async () => {
      const kept = await create({ title: "Keep" });
      const doomed = await create({ title: "Delete" });

      await remove(doomed.id);

      expect(await prisma.document.count()).toBe(1);
      expect((await prisma.document.findUnique({ where: { id: kept.id } }))?.title).toBe("Keep");
    });

    test("leaves the parent collection in place", async () => {
      const created = await create();
      await remove(created.id);
      expect(await prisma.collection.findUnique({ where: { id: collection.id } })).not.toBeNull();
    });
  });

  describe("nonexistent document", () => {
    test("rejects with NOT_FOUND naming the id", async () => {
      const error = await captureError(remove(MISSING_ID));
      expect(error.extensions["code"]).toBe("NOT_FOUND");
      expect(error.extensions["field"]).toBe("id");
      expect(error.message).toContain("Document");
      expect(error.message).toContain(MISSING_ID);
    });

    test("rejects a second delete of the same document", async () => {
      const created = await create();
      await remove(created.id);
      const error = await captureError(remove(created.id));
      expect(error.extensions["code"]).toBe("NOT_FOUND");
    });

    test("leaks no database internals", async () => {
      const error = await captureError(remove(MISSING_ID));
      expect(error.message).not.toContain("prisma.");
      expect(error.message).not.toContain("Invalid `prisma");
    });
  });
});
