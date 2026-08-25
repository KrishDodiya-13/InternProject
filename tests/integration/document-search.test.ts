/**
 * Search and filtering for the `documents` query, against real PostgreSQL.
 *
 * The fixture spans two collections and mixes archived state and matching
 * text, so every filter combination has both matches and non-matches to
 * discriminate between - a filter that did nothing would fail these tests
 * rather than pass them by accident.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { loadConfig } from "../../src/config.ts";
import { createContext, type GraphQLContext } from "../../src/context.ts";
import { createPrismaClient, type PrismaClient } from "../../src/db/prisma.ts";
import { captureError, cleanupByPrefix } from "../helpers.ts";
import {
  buildDocumentWhere,
  documentResolvers,
  escapeLikeWildcards,
  type DocumentFilterInput,
} from "../../src/resolvers/document.ts";

const PREFIX = "phase7-";
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

let prisma: PrismaClient;
let context: GraphQLContext;
let alpha: string;
let beta: string;

/** Runs the resolver and returns the matching titles, sorted for stability. */
async function titles(
  filter: DocumentFilterInput | null | undefined,
  take?: number,
): Promise<string[]> {
  const page = await documentResolvers.Query.documents(
    null,
    { filter, ...(take === undefined ? {} : { take }) },
    context,
  );
  return page.nodes.map((node) => node.title).sort();
}

beforeAll(async () => {
  prisma = createPrismaClient(loadConfig().databaseUrl);
  context = createContext(prisma);
  await cleanupByPrefix(prisma, PREFIX);

  const alphaCollection = await prisma.collection.create({
    data: { name: "Alpha", slug: `${PREFIX}alpha` },
  });
  const betaCollection = await prisma.collection.create({
    data: { name: "Beta", slug: `${PREFIX}beta` },
  });
  alpha = alphaCollection.id;
  beta = betaCollection.id;

  // Created oldest-first so ordering assertions are meaningful.
  const fixture = [
    // title match, alpha, active
    { title: "Alpha spec", content: "about widgets", collectionId: alpha, isArchived: false },
    // content match, alpha, archived
    { title: "Beta notes", content: "SPEC details inside", collectionId: alpha, isArchived: true },
    // no match, alpha, active
    { title: "Gamma", content: "unrelated text", collectionId: alpha, isArchived: false },
    // title match, beta, active
    { title: "Delta spec", content: "other collection", collectionId: beta, isArchived: false },
    // content match, beta, archived
    { title: "Epsilon", content: "spec in beta", collectionId: beta, isArchived: true },
    // literal wildcard characters, alpha, active
    { title: "Percent", content: "we hit 100% of target", collectionId: alpha, isArchived: false },
  ];
  for (const data of fixture) {
    await prisma.document.create({ data });
  }
});

afterAll(async () => {
  await cleanupByPrefix(prisma, PREFIX);
  await prisma.$disconnect();
});

describe("buildDocumentWhere", () => {
  test("is empty when no filter is supplied", () => {
    expect(buildDocumentWhere(undefined)).toEqual({});
    expect(buildDocumentWhere(null)).toEqual({});
    expect(buildDocumentWhere({})).toEqual({});
  });

  test("expresses search as a database-level OR over title and content", () => {
    // Proves the search is compiled into SQL rather than applied in JavaScript.
    expect(buildDocumentWhere({ search: "spec" })).toEqual({
      OR: [
        { title: { contains: "spec", mode: "insensitive" } },
        { content: { contains: "spec", mode: "insensitive" } },
      ],
    });
  });

  test("composes all three filters by conjunction", () => {
    const where = buildDocumentWhere({ collectionId: "c1", isArchived: true, search: "x" });
    expect(where.collectionId).toBe("c1");
    expect(where.isArchived).toBe(true);
    expect(where.OR).toBeDefined();
  });

  test("includes isArchived: false rather than dropping it", () => {
    // `false` is a real filter, not an absent one.
    expect(buildDocumentWhere({ isArchived: false })).toEqual({ isArchived: false });
  });

  test("ignores blank and null search terms", () => {
    expect(buildDocumentWhere({ search: "" })).toEqual({});
    expect(buildDocumentWhere({ search: "   " })).toEqual({});
    expect(buildDocumentWhere({ search: null })).toEqual({});
  });
});

describe("escapeLikeWildcards", () => {
  test("escapes LIKE metacharacters", () => {
    expect(escapeLikeWildcards("100%")).toBe("100\\%");
    expect(escapeLikeWildcards("a_b")).toBe("a\\_b");
    expect(escapeLikeWildcards("c:\\path")).toBe("c:\\\\path");
  });

  test("leaves ordinary text alone", () => {
    expect(escapeLikeWildcards("plain text")).toBe("plain text");
  });
});

describe("no filter", () => {
  test("returns every document", async () => {
    expect(await titles(undefined)).toEqual([
      "Alpha spec",
      "Beta notes",
      "Delta spec",
      "Epsilon",
      "Gamma",
      "Percent",
    ]);
  });

  test("returns documents newest first", async () => {
    const page = await documentResolvers.Query.documents(null, {}, context);
    const times = page.nodes.map((node) => node.createdAt.getTime());
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i - 1] ?? 0).toBeGreaterThanOrEqual(times[i] ?? 0);
    }
  });
});

describe("1. search only", () => {
  test("matches the title OR the content", async () => {
    expect(await titles({ search: "spec" })).toEqual([
      "Alpha spec", // title
      "Beta notes", // content
      "Delta spec", // title
      "Epsilon", // content
    ]);
  });

  test("is case-insensitive", async () => {
    const lower = await titles({ search: "spec" });
    expect(await titles({ search: "SPEC" })).toEqual(lower);
    expect(await titles({ search: "SpEc" })).toEqual(lower);
  });

  test("matches a partial substring, not just whole words", async () => {
    expect(await titles({ search: "pha sp" })).toEqual(["Alpha spec"]);
  });

  test("returns an empty page when nothing matches", async () => {
    expect(await titles({ search: "definitely-not-present" })).toEqual([]);
  });

  test("treats % as a literal character, not a wildcard", async () => {
    // Without escaping this would return every document.
    expect(await titles({ search: "%" })).toEqual(["Percent"]);
  });

  test("treats _ as a literal character", async () => {
    expect(await titles({ search: "_" })).toEqual([]);
  });
});

describe("2. collection only", () => {
  test("returns only that collection's documents", async () => {
    expect(await titles({ collectionId: alpha })).toEqual([
      "Alpha spec",
      "Beta notes",
      "Gamma",
      "Percent",
    ]);
    expect(await titles({ collectionId: beta })).toEqual(["Delta spec", "Epsilon"]);
  });

  test("errors with NOT_FOUND for a collection that does not exist", async () => {
    const error = await captureError(
      documentResolvers.Query.documents(null, { filter: { collectionId: MISSING_ID } }, context),
    );
    expect(error.extensions["code"]).toBe("NOT_FOUND");
    expect(error.extensions["field"]).toBe("collectionId");
  });
});

describe("3. archived only", () => {
  test("true returns only archived documents", async () => {
    expect(await titles({ isArchived: true })).toEqual(["Beta notes", "Epsilon"]);
  });

  test("false returns only active documents", async () => {
    expect(await titles({ isArchived: false })).toEqual([
      "Alpha spec",
      "Delta spec",
      "Gamma",
      "Percent",
    ]);
  });
});

describe("4. search + collection", () => {
  test("narrows to matches inside one collection", async () => {
    expect(await titles({ search: "spec", collectionId: alpha })).toEqual([
      "Alpha spec",
      "Beta notes",
    ]);
    expect(await titles({ search: "spec", collectionId: beta })).toEqual([
      "Delta spec",
      "Epsilon",
    ]);
  });

  test("returns empty when the term exists only in another collection", async () => {
    expect(await titles({ search: "widgets", collectionId: beta })).toEqual([]);
  });
});

describe("5. search + archived", () => {
  test("archived matches only", async () => {
    expect(await titles({ search: "spec", isArchived: true })).toEqual(["Beta notes", "Epsilon"]);
  });

  test("active matches only", async () => {
    expect(await titles({ search: "spec", isArchived: false })).toEqual([
      "Alpha spec",
      "Delta spec",
    ]);
  });
});

describe("6. collection + archived", () => {
  test("narrows within one collection", async () => {
    expect(await titles({ collectionId: alpha, isArchived: false })).toEqual([
      "Alpha spec",
      "Gamma",
      "Percent",
    ]);
    expect(await titles({ collectionId: alpha, isArchived: true })).toEqual(["Beta notes"]);
    expect(await titles({ collectionId: beta, isArchived: true })).toEqual(["Epsilon"]);
  });
});

describe("7. search + collection + archived", () => {
  test("applies all three together", async () => {
    expect(await titles({ search: "spec", collectionId: alpha, isArchived: false })).toEqual([
      "Alpha spec",
    ]);
    expect(await titles({ search: "spec", collectionId: alpha, isArchived: true })).toEqual([
      "Beta notes",
    ]);
    expect(await titles({ search: "spec", collectionId: beta, isArchived: false })).toEqual([
      "Delta spec",
    ]);
  });

  test("returns empty when the combination excludes everything", async () => {
    expect(await titles({ search: "widgets", collectionId: alpha, isArchived: true })).toEqual([]);
    expect(await titles({ search: "no-such-term", collectionId: beta, isArchived: false })).toEqual(
      [],
    );
  });
});

describe("empty search behaviour", () => {
  test("an empty string behaves as no search filter", async () => {
    const all = await titles(undefined);
    expect(await titles({ search: "" })).toEqual(all);
    expect(await titles({ search: "   " })).toEqual(all);
    expect(await titles({ search: null })).toEqual(all);
  });

  test("an empty search still respects the other filters", async () => {
    expect(await titles({ search: "", collectionId: beta })).toEqual(["Delta spec", "Epsilon"]);
    expect(await titles({ search: "  ", isArchived: true })).toEqual(["Beta notes", "Epsilon"]);
  });
});

describe("take", () => {
  test("bounds the number of rows returned", async () => {
    expect(await titles(undefined, 2)).toHaveLength(2);
    expect(await titles({ collectionId: alpha }, 1)).toHaveLength(1);
  });

  test("rejects invalid pagination values", async () => {
    for (const take of [0, -1, 2.5, 101]) {
      const error = await captureError(
        documentResolvers.Query.documents(null, { take }, context),
      );
      expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
      expect(error.extensions["field"]).toBe("take");
    }
  });
});
