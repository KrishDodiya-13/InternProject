/**
 * Executable schema assembly.
 *
 * The SDL lives in `schema.graphql` and the behaviour lives in `../resolvers`.
 * This module is the only place the two are joined together.
 */
import { makeExecutableSchema } from "@graphql-tools/schema";
import type { GraphQLSchema } from "graphql";

import type { GraphQLContext } from "../context.ts";
import { resolvers } from "../resolvers/index.ts";
import typeDefs from "./schema.graphql" with { type: "text" };

export function buildSchema(): GraphQLSchema {
  return makeExecutableSchema<GraphQLContext>({ typeDefs, resolvers });
}
