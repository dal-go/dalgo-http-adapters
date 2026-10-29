import { UnsupportedError } from "@dalgo/core";

/** Safe Typesense HTTP status failure. Response headers and bodies are discarded. */
export class TypesenseHttpError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`Typesense request failed with HTTP ${String(status)}`);
    this.name = "TypesenseHttpError";
    this.status = status;
  }
}

/** A redacted failure while resolving headers, following a request, or consuming a body. */
export class TypesenseRequestError extends Error {
  public constructor() {
    super("Typesense request could not be completed");
    this.name = "TypesenseRequestError";
  }
}

/**
 * Adapter-owned response bound failure. A provider-supplied RangeError is never
 * preserved, because its message or cause can contain a credential or row data.
 */
export class TypesenseResponseSizeError extends RangeError {
  public constructor() {
    super("Typesense response exceeds the configured byte budget");
    this.name = "TypesenseResponseSizeError";
  }
}

/**
 * The native candidate filter cannot be reconciled with the exact admitted
 * DALgo predicate. The row is neither silently dropped nor exposed, and no
 * earlier successful prefix survives.
 */
export class TypesenseSemanticError extends UnsupportedError {
  public constructor() {
    super("Typesense native filter candidates cannot satisfy the exact structured predicate");
    this.name = "TypesenseSemanticError";
  }
}

/**
 * A refused adapter-issued continuation. Only the fixed reason is exposed; no
 * token, query value, document or credential is ever included.
 */
export class TypesenseCursorError extends UnsupportedError {
  public readonly reason: "malformed" | "foreign" | "changed-query" | "used";

  public constructor(reason: "malformed" | "foreign" | "changed-query" | "used") {
    super(`Typesense query cursor (${reason})`);
    this.name = "TypesenseCursorError";
    this.reason = reason;
  }
}

/**
 * The current page has more matching rows, but an adapter-issued continuation
 * position would exceed a configured offset/window/page bound. Returning an
 * unusable handle or silently claiming end-of-data would both be dishonest, so
 * the whole page is refused.
 */
export class TypesenseContinuationBoundError extends UnsupportedError {
  public constructor() {
    super("Typesense query continuation exceeds the configured offset, window or page bound");
    this.name = "TypesenseContinuationBoundError";
  }
}

export type TypesenseMetadataFailure =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "unavailable"
  | "malformed";
