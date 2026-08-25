import { describe, expect, test } from "bun:test";
import { GraphQLError } from "graphql";

import { Prisma } from "../../generated/prisma/client.ts";
import { translatePrismaError } from "../../src/db/prisma-errors.ts";
import { maskVaultError } from "../../src/server.ts";
import { badUserInput, notFound } from "../../src/validation/errors.ts";

/** Builds a Prisma error the way the client would raise one. */
function prismaError(code: string, meta?: Record<string, unknown>): Error {
  return new Prisma.PrismaClientKnownRequestError(
    // A realistic raw message: it names the table and constraint, which is
    // exactly the kind of detail that must never reach a client.
    `Invalid \`prisma.collection.create()\` invocation: Unique constraint failed on the fields: (\`slug\`) for table \`collections\``,
    { code, clientVersion: "7.9.1", ...(meta === undefined ? {} : { meta }) },
  );
}

describe("translatePrismaError", () => {
  test("maps a unique violation to CONFLICT naming the field", () => {
    const translated = translatePrismaError(prismaError("P2002", { target: ["slug"] }));
    expect(translated?.extensions["code"]).toBe("CONFLICT");
    expect(translated?.message).toContain("slug");
  });

  test("handles a unique violation with no target metadata", () => {
    const translated = translatePrismaError(prismaError("P2002"));
    expect(translated?.extensions["code"]).toBe("CONFLICT");
  });

  test("maps a foreign key violation to BAD_USER_INPUT", () => {
    expect(translatePrismaError(prismaError("P2003"))?.extensions["code"]).toBe("BAD_USER_INPUT");
  });

  test("maps a restricted delete to CONFLICT", () => {
    expect(translatePrismaError(prismaError("P2014"))?.extensions["code"]).toBe("CONFLICT");
  });

  test("maps a missing record to NOT_FOUND", () => {
    expect(translatePrismaError(prismaError("P2025"))?.extensions["code"]).toBe("NOT_FOUND");
  });

  test("ignores unknown Prisma codes and non-Prisma errors", () => {
    expect(translatePrismaError(prismaError("P9999"))).toBeUndefined();
    expect(translatePrismaError(new Error("boom"))).toBeUndefined();
    expect(translatePrismaError(undefined)).toBeUndefined();
  });

  test("never leaks the raw Prisma message", () => {
    const raw = prismaError("P2002", { target: ["slug"] });
    const translated = translatePrismaError(raw);
    expect(translated?.message).not.toContain("prisma.collection.create");
    expect(translated?.message).not.toContain("collections");
    expect(translated?.message).not.toContain("Unique constraint failed");
  });
});

describe("maskVaultError", () => {
  const message = "Unexpected error.";

  test("passes intentional errors through untouched", () => {
    const intentional = badUserInput("title must not be empty", "title");
    expect(maskVaultError(intentional, message, false)).toBe(intentional);
    const missing = notFound("Document", "abc");
    expect(maskVaultError(missing, message, false)).toBe(missing);
  });

  test("preserves an intentional error wrapped by graphql-js", () => {
    // graphql-js copies `extensions` onto the wrapper, so the wrapper is
    // itself recognised as intentional and returned - keeping the `path` and
    // `locations` that graphql-js attached.
    const intentional = badUserInput("bad slug", "slug");
    const wrapped = new GraphQLError(intentional.message, { originalError: intentional });
    const result = maskVaultError(wrapped, message, false);
    expect(result).toBeInstanceOf(GraphQLError);
    expect((result as GraphQLError).extensions["code"]).toBe("BAD_USER_INPUT");
    expect((result as GraphQLError).extensions["field"]).toBe("slug");
    expect(result.message).toBe("bad slug");
  });

  test("unwraps an intentional error hidden behind a generic wrapper", () => {
    // A wrapper with its own extensions does not inherit the inner code, so
    // the originalError branch is what recovers it.
    const intentional = notFound("Collection", "abc");
    const wrapped = new GraphQLError("wrapped", {
      originalError: intentional,
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
    const result = maskVaultError(wrapped, message, false);
    expect(result).toBe(intentional);
    expect((result as GraphQLError).extensions["code"]).toBe("NOT_FOUND");
  });

  test("translates a wrapped Prisma error instead of masking it", () => {
    const wrapped = new GraphQLError("db failed", {
      originalError: prismaError("P2002", { target: ["slug"] }),
    });
    const result = maskVaultError(wrapped, message, false);
    expect(result).toBeInstanceOf(GraphQLError);
    expect((result as GraphQLError).extensions["code"]).toBe("CONFLICT");
  });

  test("masks genuine faults so internals never reach the client", () => {
    const secret = new Error("connect ECONNREFUSED 127.0.0.1:5433 password=hunter2");
    const result = maskVaultError(secret, message, false);
    expect(result.message).toBe(message);
    expect(result.message).not.toContain("hunter2");
    expect(result.message).not.toContain("5433");
  });

  test("masks unrecognised Prisma codes rather than guessing", () => {
    const result = maskVaultError(prismaError("P9999"), message, false);
    expect(result.message).toBe(message);
    expect(result.message).not.toContain("collections");
  });
});
