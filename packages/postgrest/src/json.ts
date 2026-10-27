/**
 * JSON parsing that refuses numbers JavaScript cannot carry losslessly.
 *
 * `JSON.parse` silently rounds before any reviver sees a value: an integer such
 * as `9007199254740993` becomes `9007199254740992`, and a decimal such as
 * `0.10000000000000001` becomes `0.1`. For a DALgo key, a keyset order value or
 * record data that changes the identity or the value of a row, and for a cursor
 * boundary it can repeat or skip an actual row. The raw text is therefore
 * checked before parsing instead of trying to detect the loss afterwards.
 *
 * The policy is exact: a number token is accepted only when the decimal value
 * it denotes is the same decimal value the adapter would serialize back
 * (`String(Number(token))`), and when it neither underflows to zero, overflows
 * to a non-finite value, becomes -0, nor denotes an integer outside the safe
 * range. Textual spellings of one decimal value are equivalent, so `1`, `1.0`
 * and `1e0` are all accepted, while `0.10000000000000001` and `1e-400` are
 * refused. The thrown error deliberately carries no number or row value.
 */
export class PostgrestJsonNumberError extends TypeError {
  public constructor() {
    super("PostgREST JSON contains a number that JavaScript cannot round-trip without losing precision");
    this.name = "PostgrestJsonNumberError";
  }
}

/** A JSON number literal with its exact decimal meaning, normalised. */
interface DecimalValue {
  readonly negative: boolean;
  /** Significant digits with leading and trailing zeros removed; empty for zero. */
  readonly digits: string;
  /** Power of ten applied to `digits`. Normalised to 0 for zero. */
  readonly exponent: number;
}

const NUMBER = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u;

function decimalValue(token: string): DecimalValue {
  const match = NUMBER.exec(token);
  if (match === null) throw new PostgrestJsonNumberError();
  const [, sign = "", integer = "", fraction = "", exponent = "0"] = match;
  const all = `${integer}${fraction}`;
  const significant = all.replace(/^0+/u, "");
  if (significant.length === 0) {
    // Every digit is zero, so the written exponent cannot change the value.
    return { negative: sign === "-", digits: "", exponent: 0 };
  }
  const digits = significant.replace(/0+$/u, "");
  return {
    negative: sign === "-",
    digits,
    exponent: Number(exponent) - fraction.length + (significant.length - digits.length),
  };
}

function sameDecimal(left: DecimalValue, right: DecimalValue): boolean {
  return left.negative === right.negative
    && left.digits === right.digits
    && left.exponent === right.exponent;
}

function checkNumber(token: string): void {
  const value = Number(token);
  // Non-finite values, underflow to zero, and a negative zero sign all change
  // the literal that would be sent back.
  if (!Number.isFinite(value) || Object.is(value, -0)) throw new PostgrestJsonNumberError();
  // A decimal or exponent token can still denote an integer, e.g. 9007199254740993.0
  // or 1e21; the adapter only carries integers in the safe range.
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new PostgrestJsonNumberError();
  if (!sameDecimal(decimalValue(token), decimalValue(String(value)))) {
    throw new PostgrestJsonNumberError();
  }
}

function assertLosslessNumbers(text: string): void {
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      // Skip a JSON string, including escaped quotes and backslashes, so digits
      // inside a string value are never mistaken for number literals.
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

/** Parses JSON after proving every number literal survives the round trip exactly. */
export function parseLosslessJson(text: string): unknown {
  assertLosslessNumbers(text);
  return JSON.parse(text) as unknown;
}

/** True for a native number the adapter must not emit without losing precision. */
export function isUnsafeNativeNumber(value: number): boolean {
  return Number.isInteger(value) && !Number.isSafeInteger(value);
}
