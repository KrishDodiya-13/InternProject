# Document Vault API

A GraphQL API for organising documents into collections.

Collections are named folders; every document belongs to exactly one of them.
The API supports creating and managing collections, full CRUD on documents,
moving documents between collections, substring search across titles and
content, filtering by collection and archived state, and cursor-based
pagination.

It is built as a production-minded service rather than a demo: the schema is
schema-first, every database change goes through a real Prisma migration,
validation failures become typed GraphQL errors instead of unhandled 500s, and
the test suite runs against a real PostgreSQL database rather than mocks.

---

## Tech stack

| Technology | Role |
| --- | --- |
| **Bun** | Runtime, package manager, bundler and test runner |
| **TypeScript** | Application language, `strict` mode, no `any` |
| **GraphQL Yoga** | GraphQL HTTP server |
| **Prisma** | Type-safe database client and migration tool |
| **PostgreSQL 16** | Database |
| **Docker Compose** | Runs PostgreSQL locally |

Dependencies are kept deliberately small: there is no ORM layer above Prisma,
no dependency-injection container, and no caching or queueing infrastructure.

---

## Architecture

A request flows through four clearly separated layers:

```
GraphQL operation
      │
      ▼
┌───────────────────────────────┐
│ GraphQL Yoga  (src/server.ts) │  HTTP, parsing, schema validation,
│                               │  and the single error-masking policy
└───────────────┬───────────────┘
                ▼
┌───────────────────────────────┐
│ Schema   (src/graphql/)       │  schema.graphql (SDL)  +  DateTime scalar
│                               │  joined to resolvers in schema.ts
└───────────────┬───────────────┘
                ▼
┌───────────────────────────────┐
│ Resolvers (src/resolvers/)    │  input validation, filter and cursor
│                               │  construction, orchestration
└───────────────┬───────────────┘
                ▼
┌───────────────────────────────┐
│ Prisma    (src/db/)           │  the only component that touches the DB
└───────────────┬───────────────┘
                ▼
          PostgreSQL
```

The schema lives in a `.graphql` file and the behaviour lives in TypeScript;
`src/graphql/schema.ts` is the only place the two are joined. Resolvers receive
the Prisma client from the GraphQL context rather than importing a module-level
singleton, which is what lets the integration tests run the real resolvers
against a real, test-owned connection.

```
src/
├── index.ts                  entry point: config, HTTP listener, shutdown
├── server.ts                 Yoga server + error-masking policy
├── context.ts                per-request GraphQL context
├── config.ts                 environment loading and validation
├── graphql/
│   ├── schema.graphql        the GraphQL schema (SDL)
│   ├── schema.ts             SDL + resolvers -> executable schema
│   ├── scalars.ts            DateTime scalar
│   └── cursor.ts             opaque pagination cursors
├── resolvers/
│   ├── index.ts              composes the resolver map
│   ├── collection.ts         collection queries and mutations
│   └── document.ts           document query, mutations, filters, pagination
├── validation/
│   ├── validators.ts         reusable input validators
│   ├── errors.ts             intentional GraphQL errors
│   └── lookups.ts            existence checks
└── db/
    ├── prisma.ts             Prisma client construction
    └── prisma-errors.ts      Prisma error -> GraphQL error translation

prisma/
├── schema.prisma             data model
└── migrations/               Prisma-generated migration SQL

scripts/
└── wait-for-db.ts            readiness check used by `gendb`
```

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Bun** ≥ 1.4 | https://bun.sh — runtime, package manager and test runner |
| **Docker Desktop** (or Docker Engine + Compose v2) | Runs PostgreSQL; must be running before setup |

Nothing else is required. Node.js is not needed, and PostgreSQL does not need
to be installed on the host — it runs entirely in the container.

---

## Environment variables

Copy the template before first run:

```bash
cp .env.example .env
```

`.env` is git-ignored and contains only local development values. **No real
secrets belong in this repository** — for a deployed environment, supply these
through your platform's secret management instead.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_USER` | `vault` | Database user created by the container |
| `POSTGRES_PASSWORD` | `vault` | Password for that user (local development only) |
| `POSTGRES_DB` | `document_vault` | Database name |
| `POSTGRES_PORT` | `5433` | **Host** port the container publishes |
| `DATABASE_URL` | `postgresql://vault:vault@localhost:5433/document_vault?schema=public` | Connection string used by Prisma |
| `PORT` | `4000` | Port the GraphQL server listens on |

> **Why 5433?** The container listens on 5432 internally but publishes on 5433,
> so it does not collide with a PostgreSQL already installed on the host. If you
> change `POSTGRES_PORT`, change the port in `DATABASE_URL` to match.

---

## Setup

With Docker running, from the project root:

```bash
docker compose up -d && bun install && bun run gendb && bun run dev
```

What each part does:

| Step | Effect |
| --- | --- |
| `docker compose up -d` | Starts PostgreSQL 16 in the background, with a health check and a named volume so data survives restarts |
| `bun install` | Installs dependencies from `bun.lock` |
| `bun run gendb` | Waits for PostgreSQL to accept connections, applies all Prisma migrations (`prisma migrate deploy`), then generates the typed Prisma client (`prisma generate`) |
| `bun run dev` | Starts the API in watch mode |

The API is then available at **http://localhost:4000/graphql**.

> Run `cp .env.example .env` first if you have not already — `gendb` reads
> `DATABASE_URL` from it and will tell you if it is missing.

`docker compose up -d` returns as soon as the container has *started*, which is
before PostgreSQL is ready to accept queries — noticeably so on the very first
run, when it has to create the database cluster. `gendb` therefore waits for the
database to become reachable before running migrations, so the command above
works on a cold start rather than racing it.

### Everyday commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the server in watch mode |
| `bun run start` | Start the server once |
| `bun run build` | Bundle to `dist/` |
| `bun run typecheck` | TypeScript strict check |
| `bun run db:up` / `db:down` | Start / stop PostgreSQL |
| `bun run db:wait` | Block until PostgreSQL accepts connections |
| `bun run db:migrate` | Create and apply a new migration |
| `bun run db:status` | Show migration status |
| `bun run db:reset` | Drop everything and reapply all migrations |
| `bun run db:studio` | Open Prisma Studio |

---

## Running tests

```bash
bun run test               # everything
bun run test:unit          # unit tests only - no database required
bun run test:integration   # integration tests - database must be running
bun run test:watch         # re-run on change
```

**Unit tests** (`tests/unit/`) cover validators, the error policy and the shape
of the GraphQL schema. They need no database.

**Integration tests** (`tests/integration/`) run against the real Dockerized
PostgreSQL and mock nothing. `tests/integration/api.test.ts` is the full-stack
test: it sends real GraphQL operations through the same server object
`bun run dev` serves, so each assertion travels
`GraphQL → Yoga → resolver → Prisma → PostgreSQL`, then verifies the result
directly in the database.

Start the database first:

```bash
docker compose up -d && bun run gendb
bun run test
```

Each test file namespaces its rows with a slug prefix and deletes them before
and after the run, so runs are repeatable and a crashed run cannot poison the
next one. See [`tests/README.md`](tests/README.md) for details.

---

## Database migrations

Every schema change goes through a **real Prisma migration**. The workflow is:

1. Edit `prisma/schema.prisma`.
2. Run `bun run db:migrate` (`prisma migrate dev`), which generates a migration
   from the schema diff, applies it, and regenerates the client.
3. Commit the generated directory under `prisma/migrations/` alongside the
   schema change.

**Migration SQL is generated by Prisma, never authored or edited by hand.** The
files in `prisma/migrations/` are Prisma's output and are treated as immutable
once created; correcting a mistake means changing `schema.prisma` and generating
a new migration, not editing an existing one.

On a fresh checkout or in CI, `bun run gendb` runs `prisma migrate deploy`, which
applies existing migrations without generating new ones.

---

## Troubleshooting

### `docker compose up -d` fails to pull the Postgres image

If you're behind a restrictive firewall, VPN, or corporate proxy that blocks
`registry-1.docker.io` (you'll see `403 Forbidden` or `unexpected status from
HEAD request`), Docker isn't usable for the database. Fall back to a native
PostgreSQL 16 install instead:

1. Install PostgreSQL 16 locally (e.g. `apt install postgresql-16`, `brew
   install postgresql@16`, or the Windows installer from postgresql.org).
2. Start it and create a user/database matching `.env`:
   ```sql
   CREATE USER vault WITH PASSWORD 'vault' SUPERUSER;
   CREATE DATABASE document_vault OWNER vault;
   ```
3. Make sure it's listening on the port in `DATABASE_URL` (`5433` by default —
   either change Postgres's `port` setting to match, or edit `POSTGRES_PORT`
   and `DATABASE_URL` in `.env` to match Postgres's actual port).
4. Skip `docker compose up -d` and continue with `bun install && bun run gendb
   && bun run dev`.

### `prisma migrate deploy` / `prisma generate` fails with `403 Forbidden` fetching from `binaries.prisma.sh`

Prisma downloads a Rust `schema-engine` binary from `binaries.prisma.sh` the
first time you run any `prisma` command. If that host is blocked by your
network (same symptom as above — `403 Forbidden`), the whole `prisma` CLI
becomes unusable, since even `prisma -v` needs it. Setting
`PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` does **not** fix this — it only
skips the checksum, not the download itself.

Workaround: apply the migration SQL directly, then reuse an already-generated
Prisma client rather than regenerating it.

```bash
# Apply the migration by hand (safe — Prisma migration SQL is plain,
# hand-readable SQL under prisma/migrations/):
psql "$DATABASE_URL" -f prisma/migrations/20260825053907_init_document_vault/migration.sql

# Then skip `bun run gendb` (it calls the blocked Prisma CLI) and go
# straight to:
bun run dev
```

This works because the app uses `@prisma/adapter-pg` (a driver adapter), so
the generated client is plain TypeScript that talks to Postgres through the
`pg` driver — it does not need any native engine binary at runtime. Only the
`prisma` CLI itself (migrations, `generate`, `studio`) needs network access to
`binaries.prisma.sh`. If you already have a `generated/` directory produced on
a machine with unrestricted internet access, copy it over rather than
regenerating it on the restricted machine.

Once your network allows both `registry-1.docker.io` and `binaries.prisma.sh`,
go back to the normal `docker compose up -d && bun install && bun run gendb &&
bun run dev` flow from [Setup](#setup) — it's simpler and keeps migrations
tracked properly in Prisma's `_prisma_migrations` table, which the manual
`psql` route above does not do.

---

## GraphQL API

### Queries

| Query | Returns | Notes |
| --- | --- | --- |
| `collections` | `[Collection!]!` | Every collection, newest first |
| `collection(id: ID!)` | `Collection!` | One collection with its nested `documents`; errors `NOT_FOUND` if the id is unknown |
| `documents(filter, take, cursor)` | `DocumentPage!` | Filtered, searched and paginated documents |

### Mutations

| Mutation | Returns | Notes |
| --- | --- | --- |
| `createCollection(input)` | `Collection!` | `name` + `slug`; errors `CONFLICT` if the slug is taken |
| `createDocument(input)` | `Document!` | `title`, `content`, `collectionId`, optional `tags` and `isArchived` |
| `updateDocument(id, input)` | `Document!` | Partial update; omitted fields are left unchanged |
| `deleteDocument(id)` | `DeleteDocumentPayload!` | Returns `{ id, deleted }` |
| `moveDocument(id, collectionId)` | `Document!` | Moves a document to another existing collection |

### Types

```graphql
type Collection {
  id: ID!
  name: String!
  slug: String!
  createdAt: DateTime!
  documents: [Document!]!
}

type Document {
  id: ID!
  title: String!
  content: String!
  tags: [String!]!
  collectionId: ID!
  isArchived: Boolean!
  createdAt: DateTime!
}

type DocumentPage {
  nodes: [Document!]!
  nextCursor: String
}
```

`DateTime` is an ISO-8601 string. Slugs must be lowercase letters, digits and
single hyphens between words (for example `design-docs`).

### Example

```graphql
mutation {
  createCollection(input: { name: "Engineering", slug: "engineering" }) {
    id
    slug
  }
}

query {
  documents(filter: { search: "kickoff", isArchived: false }, take: 20) {
    nodes { id title tags }
    nextCursor
  }
}
```

The full schema is in
[`src/graphql/schema.graphql`](src/graphql/schema.graphql).

---

## Search and filtering

`documents` accepts a `DocumentFilterInput` with three independent, composable
fields. Any combination may be supplied; each one narrows the result set, and
omitting a field means "do not filter on it".

| Field | Behaviour |
| --- | --- |
| `collectionId` | Restricts results to one collection. An unknown id errors `NOT_FOUND` rather than silently returning nothing |
| `search` | Case-insensitive **substring** match against the title **OR** the content |
| `isArchived` | `true` returns archived documents, `false` active ones; omit for both |

Search runs entirely in PostgreSQL. Prisma compiles it to a single query using
`ILIKE` on both columns:

```sql
WHERE "collectionId" = $1
  AND "isArchived" = $2
  AND ("title" ILIKE '%' || $3 || '%' OR "content" ILIKE '%' || $4 || '%')
```

Nothing is loaded into memory and filtered in JavaScript. Characters that
PostgreSQL treats as `LIKE` wildcards (`%`, `_`, `\`) are escaped, so searching
for `100%` finds the literal text rather than matching everything.

A blank or whitespace-only `search` is treated as no search at all, so clearing
a search box returns the full list rather than an empty one.

---

## Pagination

`documents` uses **keyset (cursor) pagination**, not offset pagination.

- `take` — page size. Must be an integer between 1 and 100; defaults to 20.
- `cursor` — the `nextCursor` returned by the previous page. Omit it for the
  first page.
- `nextCursor` — an opaque token for the next page, or `null` on the last page.
  Its presence is the only reliable "has more" signal.

Walk the pages by following `nextCursor` until it is `null`:

```graphql
query { documents(take: 20) { nodes { id title } nextCursor } }
query { documents(take: 20, cursor: "eyJ...") { nodes { id title } nextCursor } }
```

Results are ordered by `createdAt DESC, id DESC`. The `id` tie-breaker matters:
timestamps can collide, and without a deterministic second sort key rows could
be skipped or repeated across pages. The cursor encodes both values, and the
next page is fetched with a plain `WHERE` clause that seeks straight past that
position:

```sql
WHERE "createdAt" < $1 OR ("createdAt" = $2 AND "id" < $3)
```

Because it is a seek rather than an `OFFSET`, page 100 costs the same as page 1.
Cursors are opaque — do not parse or construct them; an invalid cursor produces
a `BAD_USER_INPUT` error. Filters are supplied on every request and continue to
apply on every page.

---

## Error handling

Validation and lookup failures are raised as intentional GraphQL errors with a
machine-readable `extensions.code` and, where relevant, the offending `field`.
They are returned in the GraphQL response body with HTTP 200 — a validation
failure is never an unhandled 500.

| Code | Meaning | Examples |
| --- | --- | --- |
| `BAD_USER_INPUT` | The request failed validation | Empty or whitespace-only title or content; malformed slug; `take` outside 1–100 or non-integer; malformed cursor |
| `NOT_FOUND` | A referenced record does not exist | Unknown collection or document id |
| `CONFLICT` | The request clashes with existing data | Duplicate collection slug |

```json
{
  "errors": [{
    "message": "\"title\" must not be empty or whitespace only.",
    "path": ["createDocument"],
    "extensions": { "code": "BAD_USER_INPUT", "field": "title" }
  }],
  "data": null
}
```

Error policy lives in one place, `maskVaultError` in `src/server.ts`:

1. Intentional errors pass through untouched.
2. Recognised Prisma errors are translated into the codes above — a unique
   violation becomes `CONFLICT`, a missing row becomes `NOT_FOUND`. The raw
   Prisma message, which names tables, constraints and query fragments, is
   discarded.
3. Anything else is a genuine fault and is masked as `"Unexpected error."`, so
   internal details never reach a client.

Uniqueness is enforced by the database constraint rather than a prior `SELECT`,
so two concurrent requests cannot both succeed.

---

## Possible extensions

None of the following are implemented; they are the directions this design
would most naturally grow.

- **Authentication and authorization** — there is no auth today; every caller
  sees everything. Ownership would start as a `userId` on `Collection`, with
  the authenticated user carried on the GraphQL context that resolvers already
  receive.
- **Full-text search** — substring `ILIKE` is correct and predictable but does
  not rank results or handle stemming, and it cannot use a plain B-tree index.
  PostgreSQL `tsvector` with a GIN index, or a `pg_trgm` index for fuzzy
  matching, would be the next step.
- **Document versioning** — a `DocumentVersion` table written on each update
  would give history and rollback.
- **Soft deletion** — a `deletedAt` column instead of a hard `DELETE`, giving a
  recovery window. `isArchived` already models "hidden but kept" and is
  deliberately a separate concern.
- **Tags as first-class entities** — tags are a `text[]` column today, which is
  simple and fast to read but cannot carry metadata or be renamed globally. A
  `Tag` table with a join table would allow both.
- **Object storage for binary documents** — `content` is text; storing PDFs or
  images would mean putting bytes in S3-compatible storage and keeping a
  reference in the row.
- **DataLoader** — `collections { documents }` currently issues one query per
  collection. The required single-collection query is already a single query,
  so batching is not yet warranted; if that nested-list access pattern becomes
  common, per-request DataLoader batching is the fix.
