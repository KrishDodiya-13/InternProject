/**
 * Opaque pagination cursors.
 *
 * A cursor encodes the exact position of a row in the result order, which is
 * `(createdAt DESC, id DESC)`. Both parts are needed: `createdAt` alone is not
 * unique, so two documents created in the same millisecond would make a
 * cursor ambiguous and cause rows to be skipped or repeated between pages.
 *
 * The payload is base64url-encoded so clients treat it as an opaque token
 * rather than parsing it or constructing one by hand. This is encoding, not
 * encryption - it hides no secret, it just discourages clients from depending
 * on a format we may want to change.
 */
import { badUserInput } from "../validation/errors.ts";

const SEPARATOR = "|";

/** The position a cursor points at. */
export interface DocumentCursor {
  readonly createdAt: Date;
  readonly id: string;
}

function invalidCursor(): never {
  throw badUserInput(
    '"cursor" is not a valid pagination cursor. Pass a `nextCursor` returned by a previous page, or omit it to start from the beginning.',
    "cursor",
  );
}

/** Encodes a document's position into an opaque cursor. */
export function encodeCursor(position: DocumentCursor): string {
  const payload = `${position.createdAt.toISOString()}${SEPARATOR}${position.id}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Decodes a cursor produced by {@link encodeCursor}.
 *
 * Anything that does not decode to `<iso-timestamp>|<id>` is rejected as bad
 * user input. Base64 decoding itself is lenient, so the decoded *content* is
 * what gets validated.
 */
export function decodeCursor(cursor: string): DocumentCursor {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");

  const separatorAt = decoded.indexOf(SEPARATOR);
  if (separatorAt <= 0) {
    invalidCursor();
  }

  const timestamp = decoded.slice(0, separatorAt);
  const id = decoded.slice(separatorAt + SEPARATOR.length);
  if (id === "") {
    invalidCursor();
  }

  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== timestamp) {
    invalidCursor();
  }

  return { createdAt, id };
}
