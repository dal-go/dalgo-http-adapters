/**
 * JSON parsing that refuses numbers JavaScript cannot carry losslessly.
 *
 * `JSON.parse` silently rounds before any reviver sees a value: an integer such
 * as `9007199254740993` becomes `9007199254740992`. For a Typesense native
 * document, a key, a facet statistic or a verification value that changes the
 * identity or the value of a row is unacceptable. The raw text is therefore
 * checked before parsing.
 *
 * A number token is accepted only when the decimal value it denotes is the same
 * decimal value the adapter would serialize back (`String(Number(token))`), and
 * when it neither underflows to zero, overflows to a non-finite value, becomes
 * `-0`, nor denotes an integer outside the safe range. Textual spellings of one
 * decimal value are equivalent, so `1`, `1.0` and `1e0` are accepted, while
 * `0.10000000000000001` and `9007199254740993` are refused.
 *
 * The thrown error deliberately carries no number or row value.
 */
export class TypesenseJsonNumberError extends TypeError {
  public constructor() {
    super("Typesense JSON contains a number that JavaScript cannot round-trip without losing precision");
    this.name = "TypesenseJsonNumberError";
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
  if (match === null) throw new TypesenseJsonNumberError();
  const [, sign = "", integer = "", fraction = "", exponent = "0"] = match;
  const all = `${integer}${fraction}`;
  const significant = all.replace(/^0+/u, "");
  if (significant.length === 0) {
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
  if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypesenseJsonNumberError();
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new TypesenseJsonNumberError();
  if (!sameDecimal(decimalValue(token), decimalValue(String(value)))) {
    throw new TypesenseJsonNumberError();
  }
}

/** uint64 upper bound of the native `text_match` wrapper. */
export const MAX_UINT64 = 18_446_744_073_709_551_615n;
export const UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/u;

function assertLosslessNumbers(text: string): string {
  let index = 0;
  const frames: Frame[] = [];
  const replacements: Replacement[] = [];

  const path = (): PathSegment[] => frames.map((frame) => (frame.kind === "object" ? (frame.key ?? "") : frame.index));

  const afterValue = (): void => {
    const parent = frames[frames.length - 1];
    if (parent !== undefined) parent.state = "after";
  };

  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      index += 1;
      continue;
    }
    const character = text[index];
    if (character === "\"") {
      const start = index;
      index += 1;
      while (index < text.length) {
        const current = text.charCodeAt(index);
        if (current === 0x5c) {
          index += 2;
          continue;
        }
        index += 1;
        if (current === 0x22) break;
      }
      const frame = frames[frames.length - 1];
      if (frame?.kind === "object" && frame.state === "key") {
        let key: string;
        try {
          key = JSON.parse(text.slice(start, index)) as string;
        } catch {
          // Let the final JSON.parse report the malformed document.
          continue;
        }
        if (frame.seen.has(key)) throw new TypeError("Typesense JSON contains a duplicate object key");
        frame.seen.add(key);
        frame.key = key;
        frame.state = "value";
      } else {
        afterValue();
      }
      continue;
    }
    if (character === "{") {
      frames.push({ kind: "object", seen: new Set<string>(), key: null, state: "key" });
      index += 1;
      continue;
    }
    if (character === "[") {
      frames.push({ kind: "array", index: 0, state: "value" });
      index += 1;
      continue;
    }
    if (character === "}") {
      frames.pop();
      index += 1;
      afterValue();
      continue;
    }
    if (character === "]") {
      frames.pop();
      index += 1;
      afterValue();
      continue;
    }
    if (character === ":") {
      const frame = frames[frames.length - 1];
      if (frame?.kind === "object") frame.state = "value";
      index += 1;
      continue;
    }
    if (character === ",") {
      const frame = frames[frames.length - 1];
      if (frame?.kind === "object") frame.state = "key";
      else if (frame?.kind === "array") frame.index += 1;
      index += 1;
      continue;
    }
    if (character === "-" || (code >= 0x30 && code <= 0x39)) {
      const start = index;
      index += 1;
      while (index < text.length) {
        const current = text.charCodeAt(index);
        if ((current >= 0x30 && current <= 0x39)
          || current === 0x2b
          || current === 0x2d
          || current === 0x2e
          || current === 0x45
          || current === 0x65) {
          index += 1;
          continue;
        }
        break;
      }
      const token = text.slice(start, index);
      // The only unsafe integer the adapter accepts is the server's native
      // ranking score at its exact protocol path. It is carried through as its
      // exact decimal string; every application document, facet or other value
      // still has to round-trip losslessly.
      if (isTextMatchPath(path()) && token.length <= 20 && UNSIGNED_INTEGER.test(token) && BigInt(token) <= MAX_UINT64) {
        replacements.push({ start, end: index, token });
      } else {
        checkNumber(token);
      }
      afterValue();
      continue;
    }
    if (character === "t" || character === "f" || character === "n") {
      index += character === "f" ? 5 : 4;
      afterValue();
      continue;
    }
    index += 1;
  }

  if (replacements.length === 0) return text;
  let transformed = "";
  let last = 0;
  for (const replacement of replacements) {
    transformed += text.slice(last, replacement.start) + JSON.stringify(replacement.token);
    last = replacement.end;
  }
  transformed += text.slice(last);
  return transformed;
}

type PathSegment = string | number;

interface ObjectFrame {
  readonly kind: "object";
  readonly seen: Set<string>;
  key: string | null;
  state: "key" | "value" | "after";
}

interface ArrayFrame {
  readonly kind: "array";
  index: number;
  state: "value" | "after";
}

type Frame = ObjectFrame | ArrayFrame;

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly token: string;
}

/**
 * The one score location in a native search response. A document field named
 * `text_match` lives under `hits[].document`, which is deliberately not this
 * path and therefore cannot obtain an unsafe-number exemption.
 */
function isTextMatchPath(path: readonly PathSegment[]): boolean {
  return path.length === 3 && path[0] === "hits" && typeof path[1] === "number" && path[2] === "text_match";
}

/** Parses JSON after proving every number literal survives the round trip exactly. */
export function parseLosslessJson(text: string): unknown {
  return JSON.parse(assertLosslessNumbers(text)) as unknown;
}

/** True when a value is an exact unsigned uint64 decimal string. */
export function isExactUint64(value: string): boolean {
  return value.length <= 20 && UNSIGNED_INTEGER.test(value) && BigInt(value) <= MAX_UINT64;
}

/** True for a native number the adapter must not emit without losing precision. */
export function isUnsafeNativeNumber(value: number): boolean {
  return Number.isInteger(value) && !Number.isSafeInteger(value);
}

/** True when a number is acceptable in a native document, facet or filter. */
export function isLosslessNumber(value: number): boolean {
  return Number.isFinite(value) && !Object.is(value, -0) && !isUnsafeNativeNumber(value);
}
