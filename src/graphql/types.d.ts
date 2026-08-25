/**
 * Allows `.graphql` files to be imported as text.
 *
 * Bun inlines the file contents at import time, which keeps the schema in a
 * real `.graphql` file (with editor tooling and syntax highlighting) while
 * still working identically under `bun run` and `bun build`.
 */
declare module "*.graphql" {
  const source: string;
  export default source;
}
