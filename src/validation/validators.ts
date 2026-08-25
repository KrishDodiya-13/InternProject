/**
 * Input validators.
 *
 * Each validator either returns a normalised value or throws an intentional
 * GraphQL error. They are plain functions with no shared state so they can be
 * called directly from resolvers and tested in isolation.
 */
import { badUserInput } from "./errors.ts";

/** Longest accepted collection name and document title. */
export const MAX_NAME_LENGTH = 200;
/** Longest accepted collection slug. */
export const MAX_SLUG_LENGTH = 100;
/** Page size used when `take` is omitted. */
export const DEFAULT_PAGE_SIZE = 20;
/** Largest page a client may request, to bound the work a query can cause. */
export const MAX_PAGE_SIZE = 100;

/**
 * Collection slug format: lowercase alphanumeric words separated by single
 * hyphens, e.g. `design-docs` or `q3-2026-notes`.
 *
 * Rejects uppercase letters, spaces, underscores, other punctuation, leading
 * or trailing hyphens, and consecutive hyphens.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Human-readable form of {@link SLUG_PATTERN}, reused in error messages. */
export const SLUG_FORMAT_DESCRIPTION =
  "lowercase letters, digits and single hyphens between words (e.g. \"design-docs\"), " +
  "with no leading, trailing or repeated hyphens";

/**
 * Requires a non-empty, non-whitespace-only string and returns it trimmed.
 * This is what rejects empty and whitespace-only titles and contents.
 */
export function requireNonBlank(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw badUserInput(`"${field}" must not be empty or whitespace only.`, field);
  }
  return trimmed;
}

/** Requires a string no longer than `max` characters. */
export function requireMaxLength(value: string, field: string, max: number): string {
  if (value.length > max) {
    throw badUserInput(`"${field}" must be at most ${max} characters, got ${value.length}.`, field);
  }
  return value;
}

/** Validates a document title: non-blank and within the length limit. */
export function validateTitle(title: string): string {
  return requireMaxLength(requireNonBlank(title, "title"), "title", MAX_NAME_LENGTH);
}

/**
 * Validates document content: non-blank. Content is deliberately not length
 * limited - documents are the point of the product.
 */
export function validateContent(content: string): string {
  return requireNonBlank(content, "content");
}

/** Validates a collection name: non-blank and within the length limit. */
export function validateCollectionName(name: string): string {
  return requireMaxLength(requireNonBlank(name, "name"), "name", MAX_NAME_LENGTH);
}

/**
 * Validates a collection slug against {@link SLUG_PATTERN}.
 *
 * The slug is trimmed of surrounding whitespace but is otherwise taken
 * literally - it is an identifier, so silently rewriting it would hide
 * client bugs.
 */
export function validateSlug(slug: string): string {
  const trimmed = requireNonBlank(slug, "slug");
  requireMaxLength(trimmed, "slug", MAX_SLUG_LENGTH);
  if (!SLUG_PATTERN.test(trimmed)) {
    throw badUserInput(
      `"slug" must use ${SLUG_FORMAT_DESCRIPTION}. Received "${trimmed}".`,
      "slug",
    );
  }
  return trimmed;
}

/**
 * Validates the tag list: no blank tags, each within the length limit.
 * Returns the tags trimmed, with duplicates removed and order preserved.
 */
export function validateTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const trimmed = requireNonBlank(tag, "tags");
    requireMaxLength(trimmed, "tags", MAX_NAME_LENGTH);
    seen.add(trimmed);
  }
  return [...seen];
}

/** A validated page request. */
export interface Pagination {
  readonly take: number;
  readonly cursor: string | undefined;
}

/**
 * Validates cursor pagination arguments.
 *
 * `take` must be a positive integer no larger than {@link MAX_PAGE_SIZE};
 * omitting it yields {@link DEFAULT_PAGE_SIZE}. `cursor`, when supplied, must
 * be a non-blank document id.
 */
export function validatePagination(
  take: number | null | undefined,
  cursor: string | null | undefined,
): Pagination {
  let size = DEFAULT_PAGE_SIZE;

  if (take !== null && take !== undefined) {
    if (!Number.isInteger(take)) {
      throw badUserInput(`"take" must be an integer, got ${take}.`, "take");
    }
    if (take < 1) {
      throw badUserInput(`"take" must be at least 1, got ${take}.`, "take");
    }
    if (take > MAX_PAGE_SIZE) {
      throw badUserInput(`"take" must be at most ${MAX_PAGE_SIZE}, got ${take}.`, "take");
    }
    size = take;
  }

  if (cursor === null || cursor === undefined) {
    return { take: size, cursor: undefined };
  }
  return { take: size, cursor: requireNonBlank(cursor, "cursor") };
}
