import { fail, isObject, JsonNumber, MAX_RESPONSE_BYTES, parseJSON, type JsonValue } from "./wire.js";

const encoder = new TextEncoder();

function canonical(value: JsonValue): string {
  if (value instanceof JsonNumber) {
    // Digest payloads deliberately permit integer tokens only, never exponents.
    if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value.text)) fail("unsupported_value");
    const integer = BigInt(value.text);
    if (integer < -9007199254740991n || integer > 9007199254740991n) fail("unsupported_value");
    return integer.toString();
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    // Array.sort compares UTF-16 code units. Build text directly: JSON.stringify
    // on a sorted object would reorder integer-like property names numerically.
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** RFC8785 bytes for adapter-owned safe-integer payloads, without normalization. */
export function canonicalJSON(raw: Uint8Array): Uint8Array {
  return encoder.encode(canonical(parseJSON(raw, MAX_RESPONSE_BYTES)));
}

export type HashPayloadName = "ReadPlan" | "SourceProfile" | "Observation" | "Approval";
export interface HashedPayload { readonly digest: string; readonly canonical: Uint8Array }

const payloads: Record<HashPayloadName, { fields: readonly string[]; optional: readonly string[] }> = {
  ReadPlan: { fields: "version sourceDigest projection where order limit parameters sql".split(" "), optional: ["digest"] },
  SourceProfile: { fields: "version sourceId descriptorDigest logicalCollection sourceProject datasetId tableId location schema publisherReviewRef rightsReviewRef use".split(" "), optional: [] },
  Observation: { fields: "table location type config schema".split(" "), optional: "digest observedAt etag lastModified".split(" ") },
  Approval: { fields: "effectivePlanDigest observationDigest policyDigest principal jobProject location maximumBytesBilled sessionBudgetBytes bounds estimatedBytes".split(" "), optional: "digest createdAt expiresAt nonce".split(" ") },
};

/** Explicit top-level projections retain nested digest properties as bound data. */
export async function hashPayload(name: HashPayloadName, raw: Uint8Array): Promise<HashedPayload> {
  const input = parseJSON(raw, MAX_RESPONSE_BYTES);
  if (!isObject(input) || !Object.hasOwn(payloads, name)) fail("invalid_input");
  const { fields, optional } = payloads[name];
  const allowed = new Set([...fields, ...optional]);
  const projection: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
  for (const key of fields) {
    if (!Object.hasOwn(input, key)) fail("invalid_input");
    projection[key] = input[key] as JsonValue;
  }
  if (Object.keys(input).some((key) => !allowed.has(key))) fail("invalid_input");
  const bytes = encoder.encode(canonical(projection));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return { canonical: bytes, digest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") };
}
