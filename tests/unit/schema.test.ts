import { describe, expect, test } from "bun:test";
import {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLScalarType,
  isNonNullType,
  printType,
  validateSchema,
} from "graphql";

import { buildSchema } from "../../src/graphql/schema.ts";

const schema = buildSchema();

/** Renders a field's type as SDL, e.g. `[Document!]!`. */
function fieldType(typeName: string, fieldName: string): string {
  const type = schema.getType(typeName);
  if (!(type instanceof GraphQLObjectType)) {
    throw new Error(`${typeName} is not an object type`);
  }
  const field = type.getFields()[fieldName];
  if (field === undefined) {
    throw new Error(`${typeName}.${fieldName} is not defined`);
  }
  return field.type.toString();
}

function inputFieldType(typeName: string, fieldName: string): string {
  const type = schema.getType(typeName);
  if (!(type instanceof GraphQLInputObjectType)) {
    throw new Error(`${typeName} is not an input object type`);
  }
  const field = type.getFields()[fieldName];
  if (field === undefined) {
    throw new Error(`${typeName}.${fieldName} is not defined`);
  }
  return field.type.toString();
}

function argType(typeName: string, fieldName: string, argName: string): string {
  const type = schema.getType(typeName);
  if (!(type instanceof GraphQLObjectType)) {
    throw new Error(`${typeName} is not an object type`);
  }
  const field = type.getFields()[fieldName];
  if (field === undefined) {
    throw new Error(`${typeName}.${fieldName} is not defined`);
  }
  const arg = field.args.find((candidate) => candidate.name === argName);
  if (arg === undefined) {
    throw new Error(`${typeName}.${fieldName}(${argName}:) is not defined`);
  }
  return arg.type.toString();
}

describe("schema", () => {
  test("parses and is a valid GraphQL schema", () => {
    expect(validateSchema(schema)).toEqual([]);
  });

  test("defines a DateTime scalar", () => {
    expect(schema.getType("DateTime")).toBeInstanceOf(GraphQLScalarType);
  });
});

describe("Collection type", () => {
  test("exposes the required fields with correct nullability", () => {
    expect(fieldType("Collection", "id")).toBe("ID!");
    expect(fieldType("Collection", "name")).toBe("String!");
    expect(fieldType("Collection", "slug")).toBe("String!");
    expect(fieldType("Collection", "createdAt")).toBe("DateTime!");
    expect(fieldType("Collection", "documents")).toBe("[Document!]!");
  });
});

describe("Document type", () => {
  test("exposes the required fields with correct nullability", () => {
    expect(fieldType("Document", "id")).toBe("ID!");
    expect(fieldType("Document", "title")).toBe("String!");
    expect(fieldType("Document", "content")).toBe("String!");
    expect(fieldType("Document", "tags")).toBe("[String!]!");
    expect(fieldType("Document", "collectionId")).toBe("ID!");
    expect(fieldType("Document", "isArchived")).toBe("Boolean!");
    expect(fieldType("Document", "createdAt")).toBe("DateTime!");
  });
});

describe("DocumentPage", () => {
  test("nodes is always present and nextCursor is nullable", () => {
    expect(fieldType("DocumentPage", "nodes")).toBe("[Document!]!");
    // Nullable on purpose: null means "no further pages".
    expect(fieldType("DocumentPage", "nextCursor")).toBe("String");
  });
});

describe("Query", () => {
  test("collections returns a non-null list", () => {
    expect(fieldType("Query", "collections")).toBe("[Collection!]!");
  });

  test("collection takes a required id", () => {
    expect(argType("Query", "collection", "id")).toBe("ID!");
    expect(fieldType("Query", "collection")).toBe("Collection!");
  });

  test("documents exposes filtering and cursor pagination", () => {
    expect(fieldType("Query", "documents")).toBe("DocumentPage!");
    expect(argType("Query", "documents", "filter")).toBe("DocumentFilterInput");
    expect(argType("Query", "documents", "take")).toBe("Int");
    expect(argType("Query", "documents", "cursor")).toBe("String");
  });

  test("all document filters are optional", () => {
    expect(inputFieldType("DocumentFilterInput", "collectionId")).toBe("ID");
    expect(inputFieldType("DocumentFilterInput", "search")).toBe("String");
    expect(inputFieldType("DocumentFilterInput", "isArchived")).toBe("Boolean");
  });
});

describe("Mutation", () => {
  test("defines every required mutation", () => {
    const mutation = schema.getMutationType();
    expect(mutation).toBeDefined();
    expect(Object.keys(mutation?.getFields() ?? {}).sort()).toEqual([
      "createCollection",
      "createDocument",
      "deleteDocument",
      "moveDocument",
      "updateDocument",
    ]);
  });

  test("createCollection requires name and slug", () => {
    expect(argType("Mutation", "createCollection", "input")).toBe("CreateCollectionInput!");
    expect(inputFieldType("CreateCollectionInput", "name")).toBe("String!");
    expect(inputFieldType("CreateCollectionInput", "slug")).toBe("String!");
  });

  test("createDocument requires title, content and a collection", () => {
    expect(inputFieldType("CreateDocumentInput", "title")).toBe("String!");
    expect(inputFieldType("CreateDocumentInput", "content")).toBe("String!");
    expect(inputFieldType("CreateDocumentInput", "collectionId")).toBe("ID!");
    // Optional: defaulted by the server.
    expect(inputFieldType("CreateDocumentInput", "tags")).toBe("[String!]");
    expect(inputFieldType("CreateDocumentInput", "isArchived")).toBe("Boolean");
  });

  test("updateDocument treats every field as optional", () => {
    expect(argType("Mutation", "updateDocument", "id")).toBe("ID!");
    for (const field of ["title", "content", "tags", "isArchived"]) {
      expect(isNonNullType(schema.getType("UpdateDocumentInput"))).toBe(false);
      expect(inputFieldType("UpdateDocumentInput", field).endsWith("!")).toBe(false);
    }
  });

  test("deleteDocument returns an echo payload", () => {
    expect(argType("Mutation", "deleteDocument", "id")).toBe("ID!");
    expect(fieldType("Mutation", "deleteDocument")).toBe("DeleteDocumentPayload!");
    expect(fieldType("DeleteDocumentPayload", "id")).toBe("ID!");
    expect(fieldType("DeleteDocumentPayload", "deleted")).toBe("Boolean!");
  });

  test("moveDocument takes the document and target collection", () => {
    expect(argType("Mutation", "moveDocument", "id")).toBe("ID!");
    expect(argType("Mutation", "moveDocument", "collectionId")).toBe("ID!");
    expect(fieldType("Mutation", "moveDocument")).toBe("Document!");
  });
});

describe("printed SDL", () => {
  test("Collection prints as expected", () => {
    expect(printType(schema.getType("Collection") as GraphQLObjectType)).toContain("slug: String!");
  });
});
