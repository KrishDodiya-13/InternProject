/**
 * Cursor pagination for the `documents` query, against real PostgreSQL.
 *
 * The fixture deliberately includes documents that share an identical
 * `createdAt`, which is the case that breaks naive cursor implementations.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { loadConfig } from "../../src/config.ts";
import { createContext, type GraphQLContext } from "../../src/context.ts";
import { createPrismaClient, type PrismaClient } from "../../src/db/prisma.ts";
import { decodeCursor, encodeCursor } from "../../src/graphql/cursor.ts";
import { documentResolvers, type DocumentFilterInput } from "../../src/resolvers/document.ts";
import { captureError, cleanupByPrefix } from "../helpers.ts";

const PREFIX = "phase8-";

let prisma: PrismaClient;
let context: GraphQLContext;
let alpha: string;
let beta: string;

/** Every document title in the fixture, in expected result order. */
let expectedOrder: string[] = [];

function page(args: {
  filter?: DocumentFilterInput;
  take?: number;
  cursor?: string | null;
}) {
  return documentResolvers.Query.documents(null, args, context);
}

/**
 * Walks every page and returns the titles in order, plus how many requests it
 * took. Fails loudly if pagination does not terminate.
 */
async function drain(
  take: number,
  filter?: DocumentFilterInput,
): Promise<{ titles: string[]; requests: number }> {
  const titles: string[] = [];
  let cursor: string | null = null;
  let requests = 0;

  do {
    const result = await page({ take, ...(filter === undefined ? {} : { filter }), cursor });
    requests += 1;
    titles.push(...result.nodes.map((node) => node.title));
    cursor = result.nextCursor;
    if (requests > 50) {
      throw new Error("pagination did not terminate");
    }
  } while (cursor !== null);

  return { titles, requests };
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

  const base = new Date("2026-01-01T00:00:00.000Z");
  const shared = new Date("2026-01-01T00:00:05.000Z");

  // Ten documents. D3/D4/D5 share one timestamp exactly.
  const fixture = [
    { title: "D0", createdAt: new Date(base.getTime() + 0), collectionId: alpha, archived: false },
    { title: "D1", createdAt: new Date(base.getTime() + 1000), collectionId: beta, archived: false },
    { title: "D2", createdAt: new Date(base.getTime() + 2000), collectionId: alpha, archived: true },
    { title: "D3", createdAt: shared, collectionId: alpha, archived: false },
    { title: "D4", createdAt: shared, collectionId: beta, archived: false },
    { title: "D5", createdAt: shared, collectionId: alpha, archived: true },
    { title: "D6", createdAt: new Date(base.getTime() + 6000), collectionId: beta, archived: false },
    { title: "D7", createdAt: new Date(base.getTime() + 7000), collectionId: alpha, archived: false },
    { title: "D8", createdAt: new Date(base.getTime() + 8000), collectionId: beta, archived: true },
    { title: "D9", createdAt: new Date(base.getTime() + 9000), collectionId: alpha, archived: false },
  ];

  for (const item of fixture) {
    await prisma.document.create({
      data: {
        title: item.title,
        content: `content of ${item.title} searchable`,
        collectionId: item.collectionId,
        isArchived: item.archived,
        createdAt: item.createdAt,
      },
    });
  }

  // The authoritative order, taken from the database itself.
  const ordered = await prisma.document.findMany({
    where: { collection: { slug: { startsWith: PREFIX } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  expectedOrder = ordered.map((document) => document.title);
});

afterAll(async () => {
  await cleanupByPrefix(prisma, PREFIX);
  await prisma.$disconnect();
});

describe("cursor encoding", () => {
  test("round-trips a position", () => {
    const position = { createdAt: new Date("2026-01-01T00:00:05.000Z"), id: "abc-123" };
    const decoded = decodeCursor(encodeCursor(position));
    expect(decoded.id).toBe("abc-123");
    expect(decoded.createdAt.toISOString()).toBe(position.createdAt.toISOString());
  });

  test("is opaque - not the raw id", () => {
    const cursor = encodeCursor({ createdAt: new Date(), id: "abc-123" });
    expect(cursor).not.toContain("abc-123");
    expect(cursor).not.toContain("|");
  });
});

describe("1. first page", () => {
  test("returns the first `take` documents in order", async () => {
    const first = await page({ take: 3 });
    expect(first.nodes.map((node) => node.title)).toEqual(expectedOrder.slice(0, 3));
  });

  test("provides a nextCursor when more documents exist", async () => {
    expect((await page({ take: 3 })).nextCursor).toBeString();
  });

  test("an explicitly null cursor is the same as omitting it", async () => {
    const omitted = await page({ take: 3 });
    const explicit = await page({ take: 3, cursor: null });
    expect(explicit.nodes.map((n) => n.title)).toEqual(omitted.nodes.map((n) => n.title));
  });
});

describe("2. second page", () => {
  test("continues exactly where the first page ended", async () => {
    const first = await page({ take: 3 });
    const second = await page({ take: 3, cursor: first.nextCursor });
    expect(second.nodes.map((node) => node.title)).toEqual(expectedOrder.slice(3, 6));
  });
});

describe("3. multiple pages", () => {
  test("walking every page reproduces the full ordering exactly", async () => {
    const { titles, requests } = await drain(3);
    expect(titles).toEqual(expectedOrder);
    expect(requests).toBe(4); // 3 + 3 + 3 + 1
  });

  test("works at every page size", async () => {
    for (const take of [1, 2, 3, 4, 5, 7, 10, 11]) {
      const { titles } = await drain(take);
      expect(titles).toEqual(expectedOrder);
    }
  });

  test("3. no duplicates between pages", async () => {
    const { titles } = await drain(3);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test("4. no documents missing between pages", async () => {
    const { titles } = await drain(2);
    expect(titles.sort()).toEqual([...expectedOrder].sort());
    expect(titles).toHaveLength(10);
  });

  test("5. ordering remains deterministic across repeated runs", async () => {
    const runs = await Promise.all([drain(3), drain(3), drain(3)]);
    for (const run of runs) {
      expect(run.titles).toEqual(expectedOrder);
    }
  });
});

describe("final page", () => {
  test("returns null nextCursor on the last page", async () => {
    let cursor: string | null = null;
    let last = await page({ take: 4 });
    cursor = last.nextCursor;
    while (cursor !== null) {
      last = await page({ take: 4, cursor });
      cursor = last.nextCursor;
    }
    expect(last.nextCursor).toBeNull();
    expect(last.nodes.at(-1)?.title).toBe(expectedOrder.at(-1));
  });

  test("a page that exactly consumes the remainder reports no next page", async () => {
    // 10 documents, take 5: the second page ends exactly on the boundary.
    const first = await page({ take: 5 });
    expect(first.nextCursor).toBeString();
    const second = await page({ take: 5, cursor: first.nextCursor });
    expect(second.nodes).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
  });

  test("take larger than the result set returns everything and no cursor", async () => {
    const only = await page({ take: 50 });
    expect(only.nodes).toHaveLength(10);
    expect(only.nextCursor).toBeNull();
  });
});

describe("7. same-createdAt documents", () => {
  test("the fixture really does contain a timestamp collision", async () => {
    const grouped = await prisma.document.groupBy({
      by: ["createdAt"],
      where: { collection: { slug: { startsWith: PREFIX } } },
      _count: { _all: true },
    });
    const collisions = grouped.filter((group) => group._count._all > 1);
    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions[0]?._count._all).toBe(3);
  });

  test("paginating one document at a time never repeats or skips a tied row", async () => {
    // take: 1 forces a cursor to land *inside* the tied group.
    const { titles } = await drain(1);
    expect(titles).toEqual(expectedOrder);
    expect(new Set(titles).size).toBe(10);
  });

  test("a page boundary inside the tied group is handled correctly", async () => {
    const tied = expectedOrder.slice(3, 6); // D3/D4/D5 in resolved order
    const first = await page({ take: 4 });
    const second = await page({ take: 4, cursor: first.nextCursor });
    const seen = [...first.nodes, ...second.nodes].map((node) => node.title);

    for (const title of tied) {
      expect(seen.filter((entry) => entry === title)).toHaveLength(1);
    }
  });
});

describe("6. take validation", () => {
  test("rejects invalid values", async () => {
    for (const take of [0, -1, 2.5, 101, Number.NaN]) {
      const error = await captureError(page({ take }));
      expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
      expect(error.extensions["field"]).toBe("take");
    }
  });

  test("defaults to 20 when omitted", async () => {
    const all = await page({});
    expect(all.nodes).toHaveLength(10); // fewer than the default page size
    expect(all.nextCursor).toBeNull();
  });
});

describe("8. invalid cursor", () => {
  test("rejects malformed cursors with BAD_USER_INPUT", async () => {
    const malformed = [
      "not-a-cursor",
      "!!!!",
      Buffer.from("no-separator").toString("base64url"),
      Buffer.from("|missing-timestamp").toString("base64url"),
      Buffer.from("2026-01-01T00:00:00.000Z|").toString("base64url"),
      Buffer.from("not-a-date|abc").toString("base64url"),
      Buffer.from("2026-13-45T99:99:99.000Z|abc").toString("base64url"),
    ];

    for (const cursor of malformed) {
      const error = await captureError(page({ take: 3, cursor }));
      expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
      expect(error.extensions["field"]).toBe("cursor");
    }
  });

  test("rejects a blank cursor", async () => {
    const error = await captureError(page({ take: 3, cursor: "   " }));
    expect(error.extensions["code"]).toBe("BAD_USER_INPUT");
    expect(error.extensions["field"]).toBe("cursor");
  });

  test("leaks no internals in the message", async () => {
    const error = await captureError(page({ take: 3, cursor: "garbage" }));
    expect(error.message).not.toContain("prisma");
    expect(error.message).not.toContain("documents");
    expect(error.message).toContain("cursor");
  });

  test("a cursor pointing past the end simply returns an empty page", async () => {
    const beyond = encodeCursor({ createdAt: new Date("2000-01-01T00:00:00.000Z"), id: "0" });
    const result = await page({ take: 3, cursor: beyond });
    expect(result.nodes).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

describe("9. pagination combined with filters", () => {
  test("collection filter", async () => {
    const expected = expectedOrder.filter((title) =>
      ["D0", "D2", "D3", "D5", "D7", "D9"].includes(title),
    );
    const { titles } = await drain(2, { collectionId: alpha });
    expect(titles).toEqual(expected);
    expect(titles).toHaveLength(6);
  });

  test("search filter", async () => {
    const { titles } = await drain(3, { search: "searchable" });
    expect(titles).toEqual(expectedOrder);
  });

  test("a narrower search paginates correctly", async () => {
    const { titles } = await drain(1, { search: "content of D4" });
    expect(titles).toEqual(["D4"]);
  });

  test("archived filter", async () => {
    const expected = expectedOrder.filter((title) => ["D2", "D5", "D8"].includes(title));
    const { titles } = await drain(2, { isArchived: true });
    expect(titles).toEqual(expected);
  });

  test("active filter", async () => {
    const { titles } = await drain(3, { isArchived: false });
    expect(titles).toHaveLength(7);
    expect(new Set(titles).size).toBe(7);
  });

  test("all filters combined with pagination", async () => {
    const expected = expectedOrder.filter((title) => ["D0", "D3", "D7", "D9"].includes(title));
    const { titles } = await drain(1, {
      collectionId: alpha,
      isArchived: false,
      search: "searchable",
    });
    expect(titles).toEqual(expected);
  });

  test("the filter stays applied on every page, not just the first", async () => {
    const first = await page({ take: 2, filter: { collectionId: alpha } });
    const second = await page({
      take: 2,
      filter: { collectionId: alpha },
      cursor: first.nextCursor,
    });
    for (const node of [...first.nodes, ...second.nodes]) {
      expect(node.collectionId).toBe(alpha);
    }
  });

  test("beta collection paginates independently", async () => {
    const { titles } = await drain(1, { collectionId: beta });
    expect(titles).toHaveLength(4);
    expect(titles.every((title) => ["D1", "D4", "D6", "D8"].includes(title))).toBe(true);
  });
});
