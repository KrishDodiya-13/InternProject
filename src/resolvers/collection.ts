/**
 * Collection resolvers.
 *
 * Ordering is always `createdAt DESC, id DESC`. The id tiebreak matters:
 * timestamps can collide, and without it the order of equal rows is
 * unspecified, which would make pagination skip or repeat records.
 */
import type { CollectionModel, DocumentModel } from "../../generated/prisma/models.ts";
import type { GraphQLContext } from "../context.ts";
import { isUniqueViolation } from "../db/prisma-errors.ts";
import { conflict, notFound } from "../validation/errors.ts";
import { validateCollectionName, validateSlug } from "../validation/validators.ts";
import { NEWEST_FIRST } from "./ordering.ts";

export interface CreateCollectionInput {
  readonly name: string;
  readonly slug: string;
}

/**
 * A Collection parent may arrive with its documents already loaded, when the
 * query that produced it used a Prisma `include`.
 */
type CollectionParent = CollectionModel & { readonly documents?: DocumentModel[] };

export const collectionResolvers = {
  Query: {
    /** Every collection, newest first. */
    collections: (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<CollectionModel[]> =>
      context.prisma.collection.findMany({ orderBy: [...NEWEST_FIRST] }),

    /**
     * One collection with its documents loaded in the same query, so the
     * common "collection with nested documents" request costs a single
     * round trip. Errors with NOT_FOUND when the id is unknown.
     */
    collection: async (
      _parent: unknown,
      args: { readonly id: string },
      context: GraphQLContext,
    ): Promise<CollectionParent> => {
      const collection = await context.prisma.collection.findUnique({
        where: { id: args.id },
        include: { documents: { orderBy: [...NEWEST_FIRST] } },
      });
      if (collection === null) {
        throw notFound("Collection", args.id);
      }
      return collection;
    },
  },

  Mutation: {
    /**
     * Creates a collection.
     *
     * Slug uniqueness is enforced by the database constraint rather than a
     * prior SELECT: a check-then-insert would still let two concurrent
     * requests through. The resulting violation becomes a CONFLICT error.
     */
    createCollection: async (
      _parent: unknown,
      args: { readonly input: CreateCollectionInput },
      context: GraphQLContext,
    ): Promise<CollectionModel> => {
      const name = validateCollectionName(args.input.name);
      const slug = validateSlug(args.input.slug);

      try {
        return await context.prisma.collection.create({ data: { name, slug } });
      } catch (error) {
        if (isUniqueViolation(error, "slug")) {
          throw conflict(`A collection with slug "${slug}" already exists.`, "slug");
        }
        throw error;
      }
    },
  },

  Collection: {
    /**
     * Documents belonging to this collection, newest first.
     *
     * When the parent was loaded with an `include` (as `collection(id)` does)
     * the rows are already present and are returned as-is; otherwise they are
     * fetched for this collection.
     */
    documents: (
      parent: CollectionParent,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): DocumentModel[] | Promise<DocumentModel[]> =>
      parent.documents ??
      context.prisma.document.findMany({
        where: { collectionId: parent.id },
        orderBy: [...NEWEST_FIRST],
      }),
  },
};
