import { isExactUint64, isLosslessNumber } from "./json.js";
import { isObject, isPlainObject } from "./transport.js";

export interface TypesenseSort {
  readonly field: string;
  readonly direction?: "asc" | "desc";
}

/** One bounded, typed native Typesense search. No arbitrary option bag. */
export interface TypesenseNativeSearchRequest {
  /** Native query text. `*` is the wildcard query. */
  readonly q: string;
  /** Full-text fields. Required unless `q` is `*`. */
  readonly queryBy?: readonly string[];
  /** Bounded native Typesense filter expression; negative filters are retained here. */
  readonly filterBy?: string;
  readonly sortBy?: readonly TypesenseSort[];
  readonly facetBy?: readonly string[];
  readonly maxFacetValues?: number;
  readonly limit: number;
  readonly offset?: number;
}

export interface TypesenseNativeSearchHit {
  readonly id: string;
  /** The complete native document, including its string id. */
  readonly document: Readonly<Record<string, unknown>>;
  /**
   * The server's native full-text ranking score as its **exact decimal
   * string**. Typesense serialises the uint64 `text_match` wrapper, which
   * routinely exceeds Number.MAX_SAFE_INTEGER, so a JavaScript number would
   * silently round the ranking. The string is never converted to a number and
   * is cross-checked against `text_match_info.score` when the server sends it.
   */
  readonly textMatch?: string;
  readonly curated: boolean;
}

export interface TypesenseFacetValue {
  readonly value: string;
  readonly count: number;
  readonly highlighted?: string;
}

export interface TypesenseFacetStats {
  readonly min?: number;
  readonly max?: number;
  readonly sum?: number;
  readonly avg?: number;
  readonly totalValues?: number;
}

export interface TypesenseFacet {
  readonly field: string;
  readonly counts: readonly TypesenseFacetValue[];
  readonly stats?: TypesenseFacetStats;
}

export interface TypesenseNativeSearchResult {
  readonly collection: string;
  readonly hits: readonly TypesenseNativeSearchHit[];
  readonly facets: readonly TypesenseFacet[];
  readonly found: number;
  readonly outOf: number;
  readonly page: number;
  readonly returned: number;
  readonly searchTimeMs: number;
  readonly partial: boolean;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly provenance: "typesense-native-search";
}

export interface DecodedSearch {
  readonly hits: readonly TypesenseNativeSearchHit[];
  readonly facets: readonly TypesenseFacet[];
  readonly found: number;
  readonly outOf: number;
  readonly page: number;
  readonly searchTimeMs: number;
  readonly cutoff: boolean;
}

export interface SearchDecodeOptions {
  readonly limit: number;
  readonly offset: number;
  readonly facetFields: readonly string[];
  readonly maxFacetValues: number;
  readonly maxRowBytes: number;
}

function requiredInteger(value: unknown, label: string, allowZero = true): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`malformed Typesense ${label}`);
  }
  return value;
}

function optionalInteger(value: unknown, label: string, allowZero = true): number | undefined {
  if (value === undefined) return undefined;
  return requiredInteger(value, label, allowZero);
}

function rowBytes(document: Readonly<Record<string, unknown>>, maximum: number): void {
  let text: string;
  try {
    text = JSON.stringify(document);
  } catch {
    throw new TypeError("Typesense document is not JSON-encodable");
  }
  if (new TextEncoder().encode(text).byteLength > maximum) {
    throw new RangeError("Typesense document exceeds maxRowBytes");
  }
}

/**
 * Reads the native score at its known protocol location. An unsafe uint64
 * `text_match` token was already proven to be exactly this path by the raw
 * scanner, so the parsed value is its exact decimal string. A safe integer is
 * normalised to the same string representation. If the server also emits
 * `text_match_info.score`, the two exact decimals must agree.
 */
function nativeTextMatch(raw: Readonly<Record<string, unknown>>): string | undefined {
  let exact: string | undefined;
  const value = raw.text_match;
  if (value !== undefined) {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("malformed Typesense text_match");
      exact = String(value);
    } else if (typeof value === "string") {
      if (!isExactUint64(value)) throw new TypeError("malformed Typesense text_match");
      exact = value;
    } else {
      throw new TypeError("malformed Typesense text_match");
    }
  }
  const info = raw.text_match_info;
  if (info !== undefined) {
    if (!isPlainObject(info)) throw new TypeError("malformed Typesense text_match_info");
    const score = info.score;
    if (score !== undefined) {
      let counterpart: string;
      if (typeof score === "number") {
        if (!Number.isSafeInteger(score) || score < 0) throw new TypeError("malformed Typesense text_match_info.score");
        counterpart = String(score);
      } else if (typeof score === "string") {
        if (!isExactUint64(score)) throw new TypeError("malformed Typesense text_match_info.score");
        counterpart = score;
      } else {
        throw new TypeError("malformed Typesense text_match_info.score");
      }
      if (exact === undefined) exact = counterpart;
      else if (exact !== counterpart) throw new TypeError("Typesense text_match and text_match_info.score disagree");
    }
  }
  return exact;
}

/** Decodes one search response strictly. No array, id or count is inferred. */
export function decodeSearchResponse(value: unknown, options: SearchDecodeOptions): DecodedSearch {
  if (!isObject(value)) throw new TypeError("malformed Typesense search response");
  const found = requiredInteger(value.found, "found");
  const outOf = requiredInteger(value.out_of, "out_of");
  const page = optionalInteger(value.page, "page") ?? 0;
  const searchTimeMs = optionalInteger(value.search_time_ms, "search_time_ms") ?? 0;
  let cutoff = false;
  if (value.search_cutoff !== undefined) {
    if (typeof value.search_cutoff !== "boolean") throw new TypeError("malformed Typesense search_cutoff");
    cutoff = value.search_cutoff;
  }
  if (!Array.isArray(value.hits)) throw new TypeError("malformed Typesense hits");
  if (value.hits.length > options.limit) throw new TypeError("Typesense returned more hits than requested");
  const hits: TypesenseNativeSearchHit[] = [];
  const seen = new Set<string>();
  for (const raw of value.hits) {
    if (!isObject(raw) || !isPlainObject(raw.document)) throw new TypeError("malformed Typesense search hit");
    const id = raw.document.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 1_024 || !id.isWellFormed()) {
      throw new TypeError("Typesense search hit document id must be a non-empty bounded string");
    }
    for (let index = 0; index < id.length; index += 1) {
      const code = id.charCodeAt(index);
      if (code < 0x20 || code === 0x7f) throw new TypeError("Typesense search hit document id is not supported");
    }
    if (seen.has(id)) throw new TypeError("Typesense search response contains a duplicate document id");
    seen.add(id);
    rowBytes(raw.document, options.maxRowBytes);
    const textMatch = nativeTextMatch(raw);
    const curated = raw.curated === undefined ? false : raw.curated;
    if (typeof curated !== "boolean") throw new TypeError("malformed Typesense curated flag");
    hits.push(Object.freeze({
      id,
      document: Object.freeze({ ...raw.document }),
      curated,
      ...(textMatch === undefined ? {} : { textMatch }),
    }));
  }
  if ((hits.length > 0 && found < options.offset + hits.length) || outOf < found) {
    throw new TypeError("Typesense search counts are inconsistent with the requested offset");
  }
  const facets = decodeFacets(value.facet_counts, options.facetFields, options.maxFacetValues);
  return Object.freeze({
    hits: Object.freeze(hits),
    facets,
    found,
    outOf,
    page,
    searchTimeMs,
    cutoff,
  });
}

function decodeFacets(value: unknown, requested: readonly string[], maximum: number): readonly TypesenseFacet[] {
  if (value === undefined || value === null) {
    if (requested.length > 0) throw new TypeError("Typesense facet_counts is missing");
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) throw new TypeError("malformed Typesense facet_counts");
  if (requested.length === 0) {
    if (value.length > 0) throw new TypeError("Typesense returned facet_counts that were not requested");
    return Object.freeze([]);
  }
  if (value.length !== requested.length) throw new TypeError("Typesense facet_counts does not match the requested facets");
  const wanted = new Set(requested);
  const seen = new Set<string>();
  const facets: TypesenseFacet[] = [];
  for (const raw of value) {
    if (!isObject(raw) || typeof raw.field_name !== "string" || raw.field_name.length === 0) {
      throw new TypeError("malformed Typesense facet");
    }
    if (!wanted.has(raw.field_name) || seen.has(raw.field_name)) throw new TypeError("Typesense returned an unrequested or duplicate facet");
    seen.add(raw.field_name);
    if (!Array.isArray(raw.counts) || raw.counts.length > maximum) throw new TypeError("malformed Typesense facet counts");
    const counts: TypesenseFacetValue[] = [];
    const values = new Set<string>();
    for (const count of raw.counts) {
      if (!isObject(count) || typeof count.value !== "string") throw new TypeError("malformed Typesense facet value");
      if (values.has(count.value)) throw new TypeError("Typesense facet contains a duplicate value");
      values.add(count.value);
      const amount = requiredInteger(count.count, "facet count");
      const highlighted = count.highlighted === undefined ? undefined : count.highlighted;
      if (highlighted !== undefined && typeof highlighted !== "string") throw new TypeError("malformed Typesense facet highlight");
      counts.push(Object.freeze({
        value: count.value,
        count: amount,
        ...(highlighted === undefined ? {} : { highlighted }),
      }));
    }
    const stats = raw.stats === undefined || raw.stats === null ? undefined : decodeStats(raw.stats);
    facets.push(Object.freeze({
      field: raw.field_name,
      counts: Object.freeze(counts),
      ...(stats === undefined ? {} : { stats }),
    }));
  }
  return Object.freeze(facets);
}

function decodeStats(value: unknown): TypesenseFacetStats {
  if (!isObject(value)) throw new TypeError("malformed Typesense facet stats");
  const numeric = (name: string): number | undefined => {
    const raw = value[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== "number" || !isLosslessNumber(raw)) throw new TypeError("malformed Typesense facet statistic");
    return raw;
  };
  const min = numeric("min");
  const max = numeric("max");
  const sum = numeric("sum");
  const avg = numeric("avg");
  const totalValues = value.total_values === undefined ? undefined : requiredInteger(value.total_values, "facet total_values");
  return Object.freeze({
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(sum === undefined ? {} : { sum }),
    ...(avg === undefined ? {} : { avg }),
    ...(totalValues === undefined ? {} : { totalValues }),
  });
}

export function buildNativeResult(
  collection: string,
  decoded: DecodedSearch,
  limit: number,
  offset: number,
): TypesenseNativeSearchResult {
  const returned = decoded.hits.length;
  const truncated = decoded.found > offset + returned;
  const partial = decoded.cutoff || (returned < limit && decoded.found > offset + returned);
  const complete = !partial && !truncated && !decoded.cutoff;
  return Object.freeze({
    collection,
    hits: decoded.hits,
    facets: decoded.facets,
    found: decoded.found,
    outOf: decoded.outOf,
    page: decoded.page,
    returned,
    searchTimeMs: decoded.searchTimeMs,
    partial,
    complete,
    truncated,
    provenance: "typesense-native-search",
  });
}
