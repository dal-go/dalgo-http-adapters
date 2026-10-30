/** Redacted byte/framing facts, never the nonce or provider exception text. */
export interface ClickHouseFramingEvidence {
  readonly actualFormat: "RowBinaryWithNamesAndTypes";
  readonly tagLength: 16;
  readonly prefixPresent: true;
  readonly bodyBytes: number;
  readonly frameBytes: number;
  readonly completeBody: boolean;
}

/** Never retains SQL, provider text, headers, URL, parameter values or causes. */
export class ClickHouseNativeError extends Error {
  public constructor(public readonly code: "transport" | "response" | "framing" | "unsupported" | "bounds" | "permission", public readonly status?: number, public readonly framing?: ClickHouseFramingEvidence) {
    super(`ClickHouse ${code} failure${status === undefined ? "" : ` (HTTP ${String(status)})`}`);
    this.name = "ClickHouseNativeError";
  }
}
