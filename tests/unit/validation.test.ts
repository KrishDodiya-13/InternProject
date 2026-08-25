import { describe, expect, test } from "bun:test";
import { GraphQLError } from "graphql";

import {
  badUserInput,
  conflict,
  isIntentionalError,
  notFound,
} from "../../src/validation/errors.ts";
import {
  DEFAULT_PAGE_SIZE,
  MAX_NAME_LENGTH,
  MAX_PAGE_SIZE,
  requireMaxLength,
  requireNonBlank,
  validateCollectionName,
  validateContent,
  validatePagination,
  validateSlug,
  validateTags,
  validateTitle,
} from "../../src/validation/validators.ts";
import { captureErrorSync } from "../helpers.ts";

function codeOf(fn: () => unknown): unknown {
  return captureErrorSync(fn).extensions["code"];
}

function fieldOf(fn: () => unknown): unknown {
  return captureErrorSync(fn).extensions["field"];
}

describe("requireNonBlank", () => {
  test("returns the trimmed value", () => {
    expect(requireNonBlank("  hello  ", "title")).toBe("hello");
  });

  test("rejects empty and whitespace-only strings", () => {
    for (const blank of ["", " ", "   ", "\t", "\n", " \t\n "]) {
      expect(() => requireNonBlank(blank, "title")).toThrow(GraphQLError);
    }
  });

  test("reports the offending field and code", () => {
    expect(codeOf(() => requireNonBlank("  ", "content"))).toBe("BAD_USER_INPUT");
    expect(fieldOf(() => requireNonBlank("  ", "content"))).toBe("content");
  });
});

describe("requireMaxLength", () => {
  test("accepts a value at the limit", () => {
    expect(requireMaxLength("abc", "title", 3)).toBe("abc");
  });

  test("rejects a value over the limit", () => {
    expect(codeOf(() => requireMaxLength("abcd", "title", 3))).toBe("BAD_USER_INPUT");
  });
});

describe("validateTitle", () => {
  test("rejects an empty title", () => {
    expect(codeOf(() => validateTitle(""))).toBe("BAD_USER_INPUT");
  });

  test("rejects a whitespace-only title", () => {
    expect(codeOf(() => validateTitle("   \t  "))).toBe("BAD_USER_INPUT");
    expect(fieldOf(() => validateTitle("   "))).toBe("title");
  });

  test("rejects an over-long title", () => {
    expect(codeOf(() => validateTitle("x".repeat(MAX_NAME_LENGTH + 1)))).toBe("BAD_USER_INPUT");
  });

  test("accepts and trims a valid title", () => {
    expect(validateTitle("  Design notes  ")).toBe("Design notes");
    expect(validateTitle("x".repeat(MAX_NAME_LENGTH))).toHaveLength(MAX_NAME_LENGTH);
  });
});

describe("validateContent", () => {
  test("rejects empty content", () => {
    expect(codeOf(() => validateContent(""))).toBe("BAD_USER_INPUT");
    expect(fieldOf(() => validateContent(""))).toBe("content");
  });

  test("rejects whitespace-only content", () => {
    expect(codeOf(() => validateContent("\n\t   "))).toBe("BAD_USER_INPUT");
  });

  test("accepts long content - documents are not length limited", () => {
    expect(validateContent("a".repeat(50_000))).toHaveLength(50_000);
  });
});

describe("validateCollectionName", () => {
  test("rejects blank names", () => {
    expect(codeOf(() => validateCollectionName("   "))).toBe("BAD_USER_INPUT");
    expect(fieldOf(() => validateCollectionName("   "))).toBe("name");
  });

  test("accepts a normal name", () => {
    expect(validateCollectionName(" Design Docs ")).toBe("Design Docs");
  });
});

describe("validateSlug", () => {
  test("accepts well-formed slugs", () => {
    for (const slug of ["design", "design-docs", "q3-2026-notes", "a", "a1", "1-2-3"]) {
      expect(validateSlug(slug)).toBe(slug);
    }
  });

  test("rejects malformed slugs", () => {
    const malformed = [
      "Design", // uppercase
      "design docs", // space
      "design_docs", // underscore
      "-design", // leading hyphen
      "design-", // trailing hyphen
      "design--docs", // repeated hyphen
      "design.docs", // punctuation
      "desiégn", // non-ascii
      "design/docs", // slash
      "", // empty
      "   ", // whitespace only
    ];
    for (const slug of malformed) {
      expect(codeOf(() => validateSlug(slug))).toBe("BAD_USER_INPUT");
    }
  });

  test("reports slug as the offending field and explains the format", () => {
    const error = captureErrorSync(() => validateSlug("Bad Slug"));
    expect(error.extensions["field"]).toBe("slug");
    expect(error.message).toContain("lowercase letters, digits and single hyphens");
  });

  test("rejects an over-long slug", () => {
    expect(codeOf(() => validateSlug("a".repeat(101)))).toBe("BAD_USER_INPUT");
  });
});

describe("validateTags", () => {
  test("accepts an empty list", () => {
    expect(validateTags([])).toEqual([]);
  });

  test("trims, de-duplicates and preserves order", () => {
    expect(validateTags([" spec ", "draft", "spec"])).toEqual(["spec", "draft"]);
  });

  test("rejects blank tags", () => {
    expect(codeOf(() => validateTags(["ok", "  "]))).toBe("BAD_USER_INPUT");
    expect(fieldOf(() => validateTags([""]))).toBe("tags");
  });
});

describe("validatePagination", () => {
  test("defaults take when omitted", () => {
    expect(validatePagination(undefined, undefined)).toEqual({
      take: DEFAULT_PAGE_SIZE,
      cursor: undefined,
    });
    expect(validatePagination(null, null).take).toBe(DEFAULT_PAGE_SIZE);
  });

  test("accepts valid values", () => {
    expect(validatePagination(1, undefined).take).toBe(1);
    expect(validatePagination(MAX_PAGE_SIZE, undefined).take).toBe(MAX_PAGE_SIZE);
    expect(validatePagination(10, "doc-1")).toEqual({ take: 10, cursor: "doc-1" });
  });

  test("rejects zero and negative take", () => {
    expect(codeOf(() => validatePagination(0, undefined))).toBe("BAD_USER_INPUT");
    expect(codeOf(() => validatePagination(-5, undefined))).toBe("BAD_USER_INPUT");
    expect(fieldOf(() => validatePagination(0, undefined))).toBe("take");
  });

  test("rejects non-integer take", () => {
    expect(codeOf(() => validatePagination(2.5, undefined))).toBe("BAD_USER_INPUT");
    expect(codeOf(() => validatePagination(Number.NaN, undefined))).toBe("BAD_USER_INPUT");
    expect(codeOf(() => validatePagination(Number.POSITIVE_INFINITY, undefined))).toBe(
      "BAD_USER_INPUT",
    );
  });

  test("rejects take above the maximum", () => {
    expect(codeOf(() => validatePagination(MAX_PAGE_SIZE + 1, undefined))).toBe("BAD_USER_INPUT");
  });

  test("rejects a blank cursor", () => {
    expect(codeOf(() => validatePagination(10, "   "))).toBe("BAD_USER_INPUT");
    expect(fieldOf(() => validatePagination(10, ""))).toBe("cursor");
  });
});

describe("error helpers", () => {
  test("notFound includes the id and uses NOT_FOUND", () => {
    const error = notFound("Collection", "abc");
    expect(error.extensions["code"]).toBe("NOT_FOUND");
    expect(error.message).toContain("Collection");
    expect(error.message).toContain("abc");
  });

  test("notFound works without an id", () => {
    expect(notFound("Record").message).toBe("Record was not found.");
  });

  test("conflict uses CONFLICT", () => {
    expect(conflict("taken", "slug").extensions["code"]).toBe("CONFLICT");
  });

  test("isIntentionalError recognises our errors only", () => {
    expect(isIntentionalError(badUserInput("nope", "title"))).toBe(true);
    expect(isIntentionalError(notFound("Collection", "abc"))).toBe(true);
    expect(isIntentionalError(conflict("dupe"))).toBe(true);
    expect(isIntentionalError(new Error("boom"))).toBe(false);
    expect(isIntentionalError(new GraphQLError("no code"))).toBe(false);
    expect(isIntentionalError(new GraphQLError("odd", { extensions: { code: "WAT" } }))).toBe(
      false,
    );
    expect(isIntentionalError(undefined)).toBe(false);
  });
});
