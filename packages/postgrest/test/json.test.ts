import { describe, expect, it } from "vitest";

import { PostgrestJsonNumberError, parseLosslessJson } from "../src/json.js";

function rejected(text: string): unknown {
  return (() => {
    try {
      return parseLosslessJson(text);
    } catch (error) {
      return error;
    }
  })();
}

describe("parseLosslessJson", () => {
  it("accepts decimal and exponent spellings whose serialized literal preserves the same value", () => {
    const text = "[0.1,0.30000000000000004,-2.5,1.0,1,1e0,1E+0,10.0,1e-7,0.0000001,0,0.0,0e-400,5e-324,1.0000000000000001e2,1.2345678901234567e2]";
    expect(parseLosslessJson(text)).toEqual([
      0.1,
      0.30000000000000004,
      -2.5,
      1,
      1,
      1,
      1,
      10,
      1e-7,
      0.0000001,
      0,
      0,
      0,
      5e-324,
      100.00000000000001,
      123.45678901234567,
    ]);
  });

  it("accepts the safe integer boundaries and their exact decimal spellings", () => {
    expect(parseLosslessJson("[9007199254740991,-9007199254740991,9007199254740991.0]"))
      .toEqual([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
  });

  it("refuses a high-precision decimal whose value changes through Number serialization", () => {
    for (const token of ["0.10000000000000001", "-0.10000000000000001", "0.1234567890123456789", "1.0000000000000001", "2.0000000000000001"]) {
      const error = rejected(`[${token}]`);
      expect(error, token).toBeInstanceOf(PostgrestJsonNumberError);
      expect(String(error)).not.toContain(token.replace(/^-/u, ""));
    }
  });

  it("refuses exponent forms that overflow, underflow, or shift the decimal value", () => {
    for (const token of [
      "1e400",
      "-1e400",
      "1e-400",
      "-1e-400",
      "2e-324",
      "2.4703282292062327e-324",
      "4.9406564584124654e-324",
      "1.0000000000000001e1",
      "1.23456789012345678e2",
      "9007199254740993e0",
      "1.7976931348623157e308",
    ]) {
      expect(rejected(`{"v":${token}}`), token).toBeInstanceOf(PostgrestJsonNumberError);
    }
  });

  it("refuses unsafe integers written as decimals or exponents", () => {
    for (const token of ["9007199254740993", "9007199254740993.0", "9007199254740994", "1e21", "-1e21", "9223372036854775808"]) {
      expect(rejected(`[${token}]`), token).toBeInstanceOf(PostgrestJsonNumberError);
    }
  });

  it("refuses negative zero in every spelling", () => {
    for (const token of ["-0", "-0.0", "-0e5", "-0.000"]) {
      expect(rejected(`[${token}]`), token).toBeInstanceOf(PostgrestJsonNumberError);
    }
  });

  it("never treats digits inside a string as a number literal", () => {
    const text = `{"a":"0.10000000000000001","b":"9007199254740993","c":"1e400","d":0.1,"e":"quote:\\"1e400\\"","f":"backslash:\\\\0.1"}`;
    expect(parseLosslessJson(text)).toEqual({
      a: "0.10000000000000001",
      b: "9007199254740993",
      c: "1e400",
      d: 0.1,
      e: 'quote:"1e400"',
      f: "backslash:\\0.1",
    });
  });

  it("keeps the failure redacted even when the refused literal is nested", () => {
    const error = rejected('{"rows":[{"id":"a","score":[0.10000000000000001]}]}');
    expect(error).toBeInstanceOf(PostgrestJsonNumberError);
    const text = String(error);
    expect(text).not.toContain("0.10000000000000001");
    expect(text).not.toContain("rows");
    expect(text).not.toContain("score");
  });
});
