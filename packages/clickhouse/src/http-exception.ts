import { ClickHouseNativeError } from "./native-errors.js";

const MAX_EXCEPTION_BYTES = 16_384;
const encoder = new TextEncoder();

/** The server's per-response nonce is required, including through browser CORS. */
export function requireExceptionTag(value: string | null): string {
  if (value === null || !/^[a-z]{16}$/u.test(value)) throw new ClickHouseNativeError("unsupported");
  return value;
}

/**
 * Recognize the server's reserved, nonce-bound exception framing, never error
 * message text. Upstream 26.10 writes a CRLF marker/tag prefix, message bytes,
 * decimal message byte count and the same tag/footer, at most 16 KiB total.
 *
 * Reject the exact header-tag prefix even if its footer/length is malformed
 * or truncated: UInt8 would otherwise accept every exception byte as a row.
 * The unpredictable per-response nonce distinguishes framing from ordinary
 * binary values, including text that merely resembles a ClickHouse error or
 * a complete frame bearing a different tag. Buffering/HTTP200 is insufficient.
 */
export function assertNoExceptionTrailer(bytes: Uint8Array, tag: string, completeBody = true): void {
  const prefix = encoder.encode(`\r\n__exception__\r\n${tag}\r\n`);
  const start = Math.max(0, bytes.length - MAX_EXCEPTION_BYTES);
  for (let offset = start; offset <= bytes.length - prefix.length; offset += 1) {
    if (prefix.every((byte, index) => bytes[offset + index] === byte)) {
      // Provider message bytes, values and causes never leave the transport.
      throw new ClickHouseNativeError("framing", undefined, Object.freeze({
        actualFormat: "RowBinaryWithNamesAndTypes", tagLength: 16, prefixPresent: true,
        bodyBytes: bytes.length, frameBytes: bytes.length - offset, completeBody,
      }));
    }
  }
}
