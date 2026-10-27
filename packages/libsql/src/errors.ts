import { UnsupportedError } from "@dalgo/core";

/** A redacted HTTP transport failure: the provider body and headers are never exposed. */
export class LibSQLHttpError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`libSQL pipeline request failed with HTTP ${String(status)}`);
    this.name = "LibSQLHttpError";
    this.status = status;
  }
}

/** A server-side statement failure with a bounded machine code but no echoed SQL, headers, or error body. */
export class LibSQLPipelineError extends Error {
  public readonly code: string | undefined;
  public readonly extendedCode: string | undefined;

  public constructor(code: string | undefined, extendedCode?: string) {
    const visibleCode = extendedCode ?? code;
    super(visibleCode === undefined ? "libSQL pipeline statement failed" : `libSQL pipeline statement failed (${visibleCode})`);
    this.name = "LibSQLPipelineError";
    this.code = code;
    this.extendedCode = extendedCode;
  }
}

/**
 * A redacted failure while obtaining headers, following a request, or reading a
 * response. The message never contains a token, cookie, URL, provider body, or
 * an underlying transport error.
 */
export class LibSQLRequestError extends Error {
  public constructor() {
    super("libSQL request could not be completed");
    this.name = "LibSQLRequestError";
  }
}

export type LibSQLCursorErrorReason = "malformed" | "foreign" | "changed-query" | "replayed";

/**
 * A refused adapter-issued cursor. It extends `UnsupportedError` so callers that
 * already guard deliberate adapter refusals keep working. The message and
 * `cause` never contain row values, headers, or tokens.
 */
export class LibSQLCursorError extends UnsupportedError {
  public readonly reason: LibSQLCursorErrorReason;

  public constructor(reason: LibSQLCursorErrorReason) {
    super(`libSQL query cursor (${reason})`);
    this.name = "LibSQLCursorError";
    this.reason = reason;
  }
}

/** A cumulative `getMany` response budget failure with no partial result. */
export class LibSQLBatchSizeError extends RangeError {
  public constructor() {
    super("libSQL getMany responses exceed maxGetManyBytes");
    this.name = "LibSQLBatchSizeError";
  }
}
