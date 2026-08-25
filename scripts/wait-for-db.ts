/**
 * Waits until PostgreSQL is ready to accept queries.
 *
 * `docker compose up -d` returns as soon as the container has *started*, but
 * PostgreSQL needs a few more seconds to initialise - considerably longer on a
 * fresh volume, where it has to create the database cluster. Without this the
 * documented one-command setup races the database and fails with
 * `P1001: Can't reach database server`.
 *
 * Uses Bun's built-in PostgreSQL client so the check adds no dependency.
 */
import { SQL } from "bun";

const TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 500;

/**
 * Prisma connection strings carry `?schema=`, which is meaningful to Prisma
 * but not a real PostgreSQL connection parameter - the server rejects it.
 */
function toPostgresUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.delete("schema");
  return url.toString();
}

async function canConnect(url: string): Promise<boolean> {
  const sql = new SQL(url);
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end().catch(() => undefined);
  }
}

const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  console.error(
    'Missing DATABASE_URL. Copy ".env.example" to ".env" before running this command.',
  );
  process.exit(1);
}

const url = toPostgresUrl(databaseUrl);
const deadline = Date.now() + TIMEOUT_MS;
let reported = false;

while (Date.now() < deadline) {
  if (await canConnect(url)) {
    if (reported) {
      console.log("PostgreSQL is ready.");
    }
    process.exit(0);
  }

  if (!reported) {
    console.log("Waiting for PostgreSQL to accept connections...");
    reported = true;
  }
  await Bun.sleep(RETRY_DELAY_MS);
}

console.error(
  `PostgreSQL was not reachable within ${TIMEOUT_MS / 1000}s.\n` +
    "Is the container running? Check with: docker compose ps",
);
process.exit(1);
