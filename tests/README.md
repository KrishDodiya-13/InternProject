# Tests

Two kinds of test live here.

| Directory | Needs PostgreSQL? | What it covers |
| --- | --- | --- |
| `tests/unit` | No | Pure logic: validators, error policy, schema shape |
| `tests/integration` | **Yes** | Resolvers and the full API against the real Dockerized database |

Nothing is mocked. The integration tests talk to a real PostgreSQL instance,
because the behaviour worth testing — unique constraints, `NOT NULL`, foreign
keys, `ILIKE` matching, keyset pagination — lives in the database, and a mock
would only replay whatever the test told it to.

`tests/integration/api.test.ts` is the full-stack test. It sends real GraphQL
operations through the same server object `bun run dev` serves:

```
GraphQL document -> GraphQL Yoga -> resolver -> Prisma -> PostgreSQL
```

Requests go through `yoga.fetch` in-process, so no port is allocated, but the
request parsing, schema validation, execution and error-masking layers are all
the real ones.

## Starting PostgreSQL

The database runs in Docker. From the project root:

```bash
docker compose up -d          # start PostgreSQL (or: bun run db:up)
bun run gendb                 # apply migrations + generate the Prisma client
```

Check it is healthy before running tests:

```bash
docker compose ps             # STATUS should read "Up ... (healthy)"
```

`docker compose up -d` is idempotent — running it again when the container is
already up does nothing.

> The container publishes port **5433**, not 5432, so it does not collide with
> a PostgreSQL installed directly on the host. `DATABASE_URL` in `.env` must
> match. Copy `.env.example` to `.env` if you have not already.

## Running the tests

```bash
bun run test               # everything (unit + integration)
bun run test:unit          # unit tests only - no database needed
bun run test:integration   # integration tests only - database must be running
bun run test:watch         # re-run on change
```

A single file, or a single test by name:

```bash
bun test tests/integration/api.test.ts
bun test --test-name-pattern "nested document"
```

## Test isolation

Each integration file namespaces its data with its own slug prefix
(`phase10-`, `phase9-`, …) and deletes everything under that prefix both
before and after the run. A crashed run cannot poison the next one, and files
cannot interfere with each other's rows.

Tests share the development database rather than spinning up a second one.
That keeps the setup to two commands; the trade-off is that
`bun run test:integration` will delete rows matching those prefixes, so do not
create your own collections with a `phaseN-` slug.

To wipe the database completely and reapply migrations:

```bash
bun run db:reset
```

## Stopping PostgreSQL

```bash
docker compose down           # stop (data is kept in a named volume)
docker compose down -v        # stop and delete all data
```
