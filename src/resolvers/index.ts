/**
 * Resolver map.
 *
 * Resolvers are implemented separately from the SDL and are combined into an
 * executable schema in `../graphql/schema.ts`. This module only composes the
 * per-type resolver objects; the behaviour lives in the sibling files.
 */
import type { IResolvers } from "@graphql-tools/utils";

import type { GraphQLContext } from "../context.ts";
import { DateTimeScalar } from "../graphql/scalars.ts";
import { collectionResolvers } from "./collection.ts";
import { documentResolvers } from "./document.ts";

export type Resolvers = IResolvers<unknown, GraphQLContext>;

export const resolvers: Resolvers = {
  DateTime: DateTimeScalar,
  Query: {
    ...collectionResolvers.Query,
    ...documentResolvers.Query,
  },
  Mutation: {
    ...collectionResolvers.Mutation,
    ...documentResolvers.Mutation,
  },
  Collection: collectionResolvers.Collection,
};
