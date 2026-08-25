/**
 * Application entry point: load configuration, connect to PostgreSQL and
 * serve the GraphQL API.
 */
import { loadConfig } from "./config.ts";
import { createPrismaClient } from "./db/prisma.ts";
import { createServer } from "./server.ts";

const config = loadConfig();
const prisma = createPrismaClient(config.databaseUrl);
const yoga = createServer(prisma);

const server = Bun.serve({
  port: config.port,
  fetch: (request: Request) => yoga.fetch(request, {}),
});

console.log(`Document Vault API ready at http://localhost:${server.port}/graphql`);

async function shutdown(): Promise<void> {
  await server.stop();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
