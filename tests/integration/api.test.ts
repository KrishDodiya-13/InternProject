/**
 * Full-stack integration test.
 *
 * Nothing here is mocked. Every assertion travels the real path:
 *
 *   GraphQL document -> GraphQL Yoga -> resolver -> Prisma -> PostgreSQL
 *
 * Operations are sent as HTTP requests to the same server object `bun run dev`
 * serves, built by `createServer` from `src/server.ts`. Requests go through
 * `yoga.fetch` in-process, so there is no port to allocate and no server to
 * start or tear down - but the request, parsing, validation, execution and
 * error-masking layers are all the real ones.
 *
 * Isolation: every collection this file creates uses the `phase10-` slug
 * prefix, and both `beforeAll` and `afterAll` delete everything under that
 * prefix. A crashed run therefore cannot poison the next one.
 *
 * Requires the Dockerized database to be running:
 *   docker compose up -d
 *   bun run gendb
 *   bun test tests/integration
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { loadConfig } from "../../src/config.ts";
import { createPrismaClient, type PrismaClient } from "../../src/db/prisma.ts";
import { createServer, type VaultServer } from "../../src/server.ts";
import { cleanupByPrefix } from "../helpers.ts";

const PREFIX = "phase10-";
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

let prisma: PrismaClient;
let server: VaultServer;

interface GraphQLErrorShape {
  readonly message: string;
  readonly extensions?: Record<string, unknown>;
}

interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: GraphQLErrorShape[];
}

/** Sends one GraphQL operation over the real Yoga HTTP handler. */
async function post<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ status: number; body: GraphQLResponse<T> }> {
  const response = await server.fetch(
    "http://localhost/graphql",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
    {},
  );
  return { status: response.status, body: (await response.json()) as GraphQLResponse<T> };
}

/** Executes an operation that is expected to succeed. */
async function execute<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const { status, body } = await post<T>(query, variables);
  expect(status).toBe(200);
  if (body.errors !== undefined) {
    throw new Error(`unexpected GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  if (body.data === undefined) {
    throw new Error("response contained no data");
  }
  return body.data;
}

/** Executes an operation that is expected to fail, returning the first error. */
async function expectError(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphQLErrorShape> {
  const { status, body } = await post<unknown>(query, variables);
  // GraphQL reports application errors in the body, never as an HTTP 5xx.
  expect(status).toBe(200);
  const error = body.errors?.[0];
  if (error === undefined) {
    throw new Error("expected the operation to produce a GraphQL error");
  }
  return error;
}

interface CollectionShape {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  documents?: { id: string; title: string; tags: string[]; isArchived: boolean }[];
}

interface DocumentShape {
  id: string;
  title: string;
  content: string;
  tags: string[];
  collectionId: string;
  isArchived: boolean;
  createdAt: string;
}

const CREATE_COLLECTION = `
  mutation CreateCollection($input: CreateCollectionInput!) {
    createCollection(input: $input) { id name slug createdAt }
  }
`;

const CREATE_DOCUMENT = `
  mutation CreateDocument($input: CreateDocumentInput!) {
    createDocument(input: $input) {
      id title content tags collectionId isArchived createdAt
    }
  }
`;

const COLLECTION_WITH_DOCUMENTS = `
  query Collection($id: ID!) {
    collection(id: $id) {
      id name slug createdAt
      documents { id title tags isArchived }
    }
  }
`;

const DOCUMENTS = `
  query Documents($filter: DocumentFilterInput, $take: Int, $cursor: String) {
    documents(filter: $filter, take: $take, cursor: $cursor) {
      nodes { id title collectionId isArchived }
      nextCursor
    }
  }
`;

function createCollection(name: string, slug: string): Promise<CollectionShape> {
  return execute<{ createCollection: CollectionShape }>(CREATE_COLLECTION, {
    input: { name, slug: `${PREFIX}${slug}` },
  }).then((data) => data.createCollection);
}

function createDocument(input: {
  title: string;
  content: string;
  collectionId: string;
  tags?: string[];
  isArchived?: boolean;
}): Promise<DocumentShape> {
  return execute<{ createDocument: DocumentShape }>(CREATE_DOCUMENT, { input }).then(
    (data) => data.createDocument,
  );
}

beforeAll(async () => {
  prisma = createPrismaClient(loadConfig().databaseUrl);
  server = createServer(prisma);
  await cleanupByPrefix(prisma, PREFIX);
});

afterAll(async () => {
  await cleanupByPrefix(prisma, PREFIX);
  await prisma.$disconnect();
});

describe("the required end-to-end flow", () => {
  test("create a collection, add a document, read it back nested", async () => {
    // 1. Create a collection.
    const collection = await createCollection("Engineering", "engineering");
    expect(collection.id).toBeString();
    expect(collection.slug).toBe(`${PREFIX}engineering`);
    expect(Date.parse(collection.createdAt)).not.toBeNaN();

    // 2. Create a document in that collection.
    const document = await createDocument({
      title: "Design Doc",
      content: "The architecture of the vault.",
      collectionId: collection.id,
      tags: ["design", "architecture"],
    });
    expect(document.collectionId).toBe(collection.id);
    expect(document.isArchived).toBe(false);
    expect(document.tags).toEqual(["design", "architecture"]);

    // 3. Query the collection.
    const { collection: fetched } = await execute<{ collection: CollectionShape }>(
      COLLECTION_WITH_DOCUMENTS,
      { id: collection.id },
    );
    expect(fetched.id).toBe(collection.id);
    expect(fetched.name).toBe("Engineering");

    // 4. Verify the nested document is returned.
    expect(fetched.documents).toHaveLength(1);
    expect(fetched.documents?.[0]?.id).toBe(document.id);
    expect(fetched.documents?.[0]?.title).toBe("Design Doc");
    expect(fetched.documents?.[0]?.tags).toEqual(["design", "architecture"]);

    // And it genuinely reached PostgreSQL, not just the resolver's return value.
    const stored = await prisma.document.findUnique({ where: { id: document.id } });
    expect(stored?.title).toBe("Design Doc");
    expect(stored?.collectionId).toBe(collection.id);
  });

  test("collections lists the new collection", async () => {
    const created = await createCollection("Listed", "listed");
    const { collections } = await execute<{ collections: CollectionShape[] }>(
      `query { collections { id slug } }`,
    );
    expect(collections.some((entry) => entry.id === created.id)).toBe(true);
  });
});

describe("errors travel the real stack", () => {
  test("a duplicate slug becomes CONFLICT, not an HTTP 500", async () => {
    await createCollection("First", "dupe");
    const error = await expectError(CREATE_COLLECTION, {
      input: { name: "Second", slug: `${PREFIX}dupe` },
    });

    expect(error.extensions?.["code"]).toBe("CONFLICT");
    expect(error.extensions?.["field"]).toBe("slug");
    // The raw Prisma message never reaches the client.
    expect(error.message).not.toContain("Unique constraint");
    expect(error.message).not.toContain("prisma.");
  });

  test("an invalid slug becomes BAD_USER_INPUT", async () => {
    const error = await expectError(CREATE_COLLECTION, {
      input: { name: "Bad", slug: "Not A Slug" },
    });
    expect(error.extensions?.["code"]).toBe("BAD_USER_INPUT");
    expect(error.extensions?.["field"]).toBe("slug");
  });

  test("a blank title becomes BAD_USER_INPUT", async () => {
    const collection = await createCollection("Titles", "titles");
    const error = await expectError(CREATE_DOCUMENT, {
      input: { title: "   ", content: "body", collectionId: collection.id },
    });
    expect(error.extensions?.["code"]).toBe("BAD_USER_INPUT");
    expect(error.extensions?.["field"]).toBe("title");
  });

  test("an unknown collection becomes NOT_FOUND", async () => {
    const error = await expectError(COLLECTION_WITH_DOCUMENTS, { id: MISSING_ID });
    expect(error.extensions?.["code"]).toBe("NOT_FOUND");
  });

  test("schema validation rejects an unknown field", async () => {
    const error = await expectError(`query { nope }`);
    expect(error.extensions?.["code"]).toBe("GRAPHQL_VALIDATION_FAILED");
  });
});

describe("document movement", () => {
  test("moves a document between collections end to end", async () => {
    const source = await createCollection("Source", "move-source");
    const target = await createCollection("Target", "move-target");
    const document = await createDocument({
      title: "Portable",
      content: "moves around",
      collectionId: source.id,
    });

    const { moveDocument } = await execute<{ moveDocument: DocumentShape }>(
      `mutation Move($id: ID!, $collectionId: ID!) {
        moveDocument(id: $id, collectionId: $collectionId) { id title collectionId }
      }`,
      { id: document.id, collectionId: target.id },
    );
    expect(moveDocument.collectionId).toBe(target.id);

    const before = await execute<{ collection: CollectionShape }>(COLLECTION_WITH_DOCUMENTS, {
      id: source.id,
    });
    const after = await execute<{ collection: CollectionShape }>(COLLECTION_WITH_DOCUMENTS, {
      id: target.id,
    });

    expect(before.collection.documents).toEqual([]);
    expect(after.collection.documents?.map((entry) => entry.title)).toEqual(["Portable"]);
  });

  test("moving to an unknown collection is NOT_FOUND and changes nothing", async () => {
    const source = await createCollection("Stay", "move-stay");
    const document = await createDocument({
      title: "Stays put",
      content: "x",
      collectionId: source.id,
    });

    const error = await expectError(
      `mutation Move($id: ID!, $collectionId: ID!) {
        moveDocument(id: $id, collectionId: $collectionId) { id }
      }`,
      { id: document.id, collectionId: MISSING_ID },
    );
    expect(error.extensions?.["code"]).toBe("NOT_FOUND");

    const stored = await prisma.document.findUnique({ where: { id: document.id } });
    expect(stored?.collectionId).toBe(source.id);
  });
});

describe("search, filtering and pagination", () => {
  let alpha: CollectionShape;
  let beta: CollectionShape;

  beforeAll(async () => {
    alpha = await createCollection("Alpha", "search-alpha");
    beta = await createCollection("Beta", "search-beta");

    const fixture = [
      { title: "Kickoff notes", content: "project kickoff", cid: alpha.id, archived: false },
      { title: "Retro", content: "KICKOFF retrospective", cid: alpha.id, archived: true },
      { title: "Budget", content: "unrelated numbers", cid: alpha.id, archived: false },
      { title: "Kickoff plan", content: "beta side", cid: beta.id, archived: false },
      { title: "Archive", content: "old kickoff material", cid: beta.id, archived: true },
    ];
    for (const item of fixture) {
      await createDocument({
        title: item.title,
        content: item.content,
        collectionId: item.cid,
        isArchived: item.archived,
      });
    }
  });

  interface Page {
    documents: { nodes: { id: string; title: string; collectionId: string }[]; nextCursor: string | null };
  }

  async function titles(variables: Record<string, unknown>): Promise<string[]> {
    const data = await execute<Page>(DOCUMENTS, variables);
    return data.documents.nodes.map((node) => node.title).sort();
  }

  test("search matches title or content, case-insensitively", async () => {
    expect(await titles({ filter: { search: "kickoff" } })).toEqual([
      "Archive",
      "Kickoff notes",
      "Kickoff plan",
      "Retro",
    ]);
    expect(await titles({ filter: { search: "KICKOFF" } })).toEqual(
      await titles({ filter: { search: "kickoff" } }),
    );
  });

  test("filters by collection", async () => {
    expect(await titles({ filter: { collectionId: beta.id } })).toEqual([
      "Archive",
      "Kickoff plan",
    ]);
  });

  test("filters by archived state", async () => {
    expect(await titles({ filter: { isArchived: true } })).toEqual(["Archive", "Retro"]);
  });

  test("composes search, collection and archived together", async () => {
    expect(
      await titles({ filter: { search: "kickoff", collectionId: alpha.id, isArchived: false } }),
    ).toEqual(["Kickoff notes"]);
  });

  test("paginates with a cursor without duplicating or dropping rows", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let requests = 0;

    do {
      const data: Page = await execute<Page>(DOCUMENTS, {
        filter: { search: "kickoff" },
        take: 2,
        cursor,
      });
      seen.push(...data.documents.nodes.map((node) => node.title));
      cursor = data.documents.nextCursor;
      requests += 1;
      expect(requests).toBeLessThan(10);
    } while (cursor !== null);

    expect(requests).toBe(2);
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect([...seen].sort()).toEqual(["Archive", "Kickoff notes", "Kickoff plan", "Retro"]);
  });

  test("an invalid cursor is a GraphQL error, not a crash", async () => {
    const error = await expectError(DOCUMENTS, { take: 2, cursor: "garbage" });
    expect(error.extensions?.["code"]).toBe("BAD_USER_INPUT");
    expect(error.extensions?.["field"]).toBe("cursor");
  });

  test("an invalid take is a GraphQL error", async () => {
    const error = await expectError(DOCUMENTS, { take: 0 });
    expect(error.extensions?.["code"]).toBe("BAD_USER_INPUT");
    expect(error.extensions?.["field"]).toBe("take");
  });
});

describe("update and delete round trip", () => {
  test("updates a document partially and then deletes it", async () => {
    const collection = await createCollection("Lifecycle", "lifecycle");
    const document = await createDocument({
      title: "Draft",
      content: "original body",
      collectionId: collection.id,
      tags: ["draft"],
    });

    const { updateDocument } = await execute<{ updateDocument: DocumentShape }>(
      `mutation Update($id: ID!, $input: UpdateDocumentInput!) {
        updateDocument(id: $id, input: $input) { id title content tags isArchived }
      }`,
      { id: document.id, input: { isArchived: true } },
    );

    expect(updateDocument.isArchived).toBe(true);
    expect(updateDocument.title).toBe("Draft");
    expect(updateDocument.content).toBe("original body");
    expect(updateDocument.tags).toEqual(["draft"]);

    const { deleteDocument } = await execute<{ deleteDocument: { id: string; deleted: boolean } }>(
      `mutation Delete($id: ID!) { deleteDocument(id: $id) { id deleted } }`,
      { id: document.id },
    );
    expect(deleteDocument).toEqual({ id: document.id, deleted: true });

    expect(await prisma.document.findUnique({ where: { id: document.id } })).toBeNull();

    const error = await expectError(`mutation Delete($id: ID!) { deleteDocument(id: $id) { id } }`, {
      id: document.id,
    });
    expect(error.extensions?.["code"]).toBe("NOT_FOUND");
  });
});

describe("test isolation", () => {
  test("cleanup removes everything this file created", async () => {
    await cleanupByPrefix(prisma, PREFIX);
    const remaining = await prisma.collection.count({ where: { slug: { startsWith: PREFIX } } });
    const orphans = await prisma.document.count({
      where: { collection: { slug: { startsWith: PREFIX } } },
    });
    expect(remaining).toBe(0);
    expect(orphans).toBe(0);
  });
});
