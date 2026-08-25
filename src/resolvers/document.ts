/**
 * Document resolvers.
 *
 * Create validates its inputs and the target collection up front. Update and
 * delete let the database tell us the row is missing (P2025) rather than
 * running a separate existence query, which keeps each mutation to a single
 * write and avoids a check-then-act race.
 */
import type { Prisma } from "../../generated/prisma/client.ts";
import type { DocumentModel } from "../../generated/prisma/models.ts";
import type { GraphQLContext } from "../context.ts";
import { isRecordNotFound } from "../db/prisma-errors.ts";
import { decodeCursor, encodeCursor, type DocumentCursor } from "../graphql/cursor.ts";
import { badUserInput, notFound } from "../validation/errors.ts";
import { requireCollectionExists, requireDocumentExists } from "../validation/lookups.ts";
import {
  validateContent,
  validatePagination,
  validateTags,
  validateTitle,
} from "../validation/validators.ts";
import { NEWEST_FIRST } from "./ordering.ts";

export interface DocumentFilterInput {
  readonly collectionId?: string | null;
  readonly search?: string | null;
  readonly isArchived?: boolean | null;
}

export interface DocumentPage {
  readonly nodes: DocumentModel[];
  readonly nextCursor: string | null;
}

/**
 * The keyset predicate for "strictly after this position" under
 * `(createdAt DESC, id DESC)`.
 *
 * Reads as: an older document, or one created in the same instant whose id
 * sorts lower. The second branch is what makes documents sharing a
 * `createdAt` paginate correctly instead of being skipped or repeated.
 *
 * This is a plain WHERE clause, so the database seeks straight to the
 * position - no OFFSET, and no row count that grows with the page number.
 */
function afterCursor(position: DocumentCursor): Prisma.DocumentWhereInput[] {
  return [
    { createdAt: { lt: position.createdAt } },
    { createdAt: position.createdAt, id: { lt: position.id } },
  ];
}

/**
 * Escapes the characters PostgreSQL treats as LIKE wildcards.
 *
 * Prisma compiles `contains` to `ILIKE '%term%'` with no ESCAPE clause, which
 * leaves PostgreSQL's default backslash escape in force. Without this, a
 * search for "%" would match every document and "50%" would match "50 apples",
 * because the user's text would be read as a pattern rather than as literal
 * characters. The backslash itself is escaped first so it cannot double up.
 */
export function escapeLikeWildcards(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Translates the GraphQL filter into a Prisma `where` clause.
 *
 * Each filter is independent and they compose by conjunction, so any
 * combination of the three narrows the result set as expected. All of it runs
 * in PostgreSQL - nothing is filtered in JavaScript.
 *
 * A blank or whitespace-only `search` is treated as no search at all rather
 * than as a match-nothing filter: "search for nothing" sensibly means
 * "everything", and it keeps a cleared search box from emptying the list.
 */
export function buildDocumentWhere(
  filter: DocumentFilterInput | null | undefined,
): Prisma.DocumentWhereInput {
  const where: Prisma.DocumentWhereInput = {};

  const collectionId = filter?.collectionId;
  if (isProvided(collectionId)) {
    where.collectionId = collectionId;
  }

  const isArchived = filter?.isArchived;
  if (isProvided(isArchived)) {
    where.isArchived = isArchived;
  }

  const search = filter?.search?.trim();
  if (search !== undefined && search !== "") {
    // Case-insensitive substring match on either column. Prisma compiles
    // `contains` + `insensitive` to PostgreSQL ILIKE '%term%'.
    const term = escapeLikeWildcards(search);
    where.OR = [
      { title: { contains: term, mode: "insensitive" } },
      { content: { contains: term, mode: "insensitive" } },
    ];
  }

  return where;
}

export interface CreateDocumentInput {
  readonly title: string;
  readonly content: string;
  readonly collectionId: string;
  readonly tags?: readonly string[] | null;
  readonly isArchived?: boolean | null;
}

export interface UpdateDocumentInput {
  readonly title?: string | null;
  readonly content?: string | null;
  readonly tags?: readonly string[] | null;
  readonly isArchived?: boolean | null;
}

export interface DeleteDocumentPayload {
  readonly id: string;
  readonly deleted: boolean;
}

/** The fields an update may set, all optional. */
interface DocumentUpdateData {
  title?: string;
  content?: string;
  tags?: string[];
  isArchived?: boolean;
}

/** GraphQL sends omitted fields as `undefined` and may send an explicit `null`. */
function isProvided<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

export const documentResolvers = {
  Query: {
    /**
     * Documents matching the supplied filters, newest first.
     *
     * Filtering and searching happen entirely in PostgreSQL. When a
     * `collectionId` filter is given it is checked first, so filtering by a
     * collection that does not exist reports NOT_FOUND rather than silently
     * returning an empty page.
     *
     * Pagination is keyset-based: the cursor carries the position of the last
     * row of the previous page, and the query seeks past it. `nextCursor` is
     * null on the final page.
     */
    documents: async (
      _parent: unknown,
      args: {
        readonly filter?: DocumentFilterInput | null;
        readonly take?: number | null;
        readonly cursor?: string | null;
      },
      context: GraphQLContext,
    ): Promise<DocumentPage> => {
      const { take, cursor } = validatePagination(args.take, args.cursor);
      const where = buildDocumentWhere(args.filter);

      if (cursor !== undefined) {
        // Keyset predicate, ANDed with the filters above. `AND` is used rather
        // than a top-level `OR` so it cannot collide with the search `OR`.
        where.AND = [{ OR: afterCursor(decodeCursor(cursor)) }];
      }

      const collectionId = args.filter?.collectionId;
      if (isProvided(collectionId)) {
        await requireCollectionExists(context.prisma, collectionId);
      }

      // One extra row reveals whether a further page exists, without a
      // second COUNT query.
      const rows = await context.prisma.document.findMany({
        where,
        orderBy: [...NEWEST_FIRST],
        take: take + 1,
      });

      const hasMore = rows.length > take;
      const nodes = hasMore ? rows.slice(0, take) : rows;
      const last = nodes.at(-1);

      return {
        nodes,
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      };
    },
  },

  Mutation: {
    /**
     * Creates a document in an existing collection.
     *
     * The collection is checked first so a bad id produces NOT_FOUND naming
     * the field, rather than a foreign key violation surfacing from the write.
     */
    createDocument: async (
      _parent: unknown,
      args: { readonly input: CreateDocumentInput },
      context: GraphQLContext,
    ): Promise<DocumentModel> => {
      const { input } = args;
      const title = validateTitle(input.title);
      const content = validateContent(input.content);
      const tags = validateTags(input.tags ?? []);

      await requireCollectionExists(context.prisma, input.collectionId);

      return context.prisma.document.create({
        data: {
          title,
          content,
          tags,
          collectionId: input.collectionId,
          isArchived: input.isArchived ?? false,
        },
      });
    },

    /**
     * Updates only the supplied fields. An omitted field - or an explicit
     * null, which cannot be stored in these non-null columns - leaves the
     * existing value untouched. Supplying nothing at all is rejected, since
     * it is almost always a client bug rather than an intentional no-op.
     */
    updateDocument: async (
      _parent: unknown,
      args: { readonly id: string; readonly input: UpdateDocumentInput },
      context: GraphQLContext,
    ): Promise<DocumentModel> => {
      const { id, input } = args;
      const data: DocumentUpdateData = {};

      if (isProvided(input.title)) {
        data.title = validateTitle(input.title);
      }
      if (isProvided(input.content)) {
        data.content = validateContent(input.content);
      }
      if (isProvided(input.tags)) {
        data.tags = validateTags(input.tags);
      }
      if (isProvided(input.isArchived)) {
        data.isArchived = input.isArchived;
      }

      if (Object.keys(data).length === 0) {
        throw badUserInput(
          "Provide at least one field to update: title, content, tags or isArchived.",
          "input",
        );
      }

      try {
        return await context.prisma.document.update({ where: { id }, data });
      } catch (error) {
        if (isRecordNotFound(error)) {
          throw notFound("Document", id);
        }
        throw error;
      }
    },

    /**
     * Moves a document into a different collection.
     *
     * Both records are checked and the write happens inside one transaction,
     * so the collection cannot disappear between the check and the update.
     * Nothing is ever created implicitly: an unknown target collection is a
     * NOT_FOUND error, never a new collection.
     *
     * Moving a document to the collection it is already in is accepted as a
     * no-op rather than an error - it is idempotent and a client retrying a
     * move should not be punished for it.
     */
    moveDocument: async (
      _parent: unknown,
      args: { readonly id: string; readonly collectionId: string },
      context: GraphQLContext,
    ): Promise<DocumentModel> =>
      context.prisma.$transaction(async (tx) => {
        await requireDocumentExists(tx, args.id);
        await requireCollectionExists(tx, args.collectionId);

        return tx.document.update({
          where: { id: args.id },
          data: { collectionId: args.collectionId },
        });
      }),

    /** Permanently deletes a document and echoes its id back. */
    deleteDocument: async (
      _parent: unknown,
      args: { readonly id: string },
      context: GraphQLContext,
    ): Promise<DeleteDocumentPayload> => {
      try {
        const deleted = await context.prisma.document.delete({ where: { id: args.id } });
        return { id: deleted.id, deleted: true };
      } catch (error) {
        if (isRecordNotFound(error)) {
          throw notFound("Document", args.id);
        }
        throw error;
      }
    },
  },
};
