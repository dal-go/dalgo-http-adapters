/**
 * JSON parsing that refuses numbers which JavaScript cannot represent exactly.
 *
 * `JSON.parse` silently rounds an integer such as `9007199254740993` to
 * `9007199254740992` before any reviver sees it. For a DALgo key or keyset
 * order value that changes the identity of a row and a cursor boundary, so the
 * raw text is checked before parsing instead of trying to detect the loss
 * afterwards. The throw deliberately carries no number or row values.
 */
export class PostgrestJsonNumberError extends TypeError {
  public constructor() {
    super("PostgREST JSON contains a number outside the lossless JavaScript range");
    this.name = "PostgrestJsonNumberError";
  }
}

const INTEGER = /^-?(?:0|[1-9]\d*)$/u;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

function checkNumber(token: string): void {
  if (INTEGER.test(token)) {
    if (token === "-0") throw new PostgrestJsonNumberError();
    const integer = BigInt(token);
    if (integer > MAX_SAFE || integer < MIN_SAFE) throw new PostgrestJsonNumberError();
    return;
  }
  const value = Number(token);
  if (!Number.isFinite(value) || Object.is(value, -0)) throw new PostgrestJsonNumberError();
  // A decimal or exponent token can still denote an unsafe integer, e.g.
  // 9007199254740993.0 or 1e20.
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new PostgrestJsonNumberError();
}

function assertLosslessNumbers(text: string): void {
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      // Skip a JSON string, including escaped quotes and backslashes.
      index += 1;
      while (index < text.length) {
        const character = text.charCodeAt(index);
        if (character === 0x5c) {
          index += 2;
          continue;
        }
        index += 1;
        if (character === 0x22) break;
      }
      continue;
    }
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
      const start = index;
      index += 1;
      while (index < text.length) {
        const character = text.charCodeAt(index);
        if ((character >= 0x30 && character <= 0x39)
          || character === 0x2b // +
          || character === 0x2d // -
          || character === 0x2e // .
          || character === 0x45 // E
          || character === 0x65) { // e
          index += 1;
          continue;
        }
        break;
      }
      checkNumber(text.slice(start, index));
      continue;
    }
    index += 1;
  }
}

/** Parses JSON after proving every number literal is exactly representable. */
export function parseLosslessJson(text: string): unknown {
  assertLosslessNumbers(text);
  return JSON.parse(text) as unknown;
}

/** True for a native number an adapter must not emit without losing precision. */
export function isUnsafeNativeNumber(value: number): boolean {
  return Number.isInteger(value) && !Number.isSafeInteger(value);
}
