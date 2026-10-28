import { TypesenseHttpError, TypesenseRequestError, TypesenseResponseSizeError, type TypesenseMetadataFailure } from "./errors.js";
import { isObject } from "./transport.js";

export interface TypesenseFieldDefinition {
  readonly name: string;
  /** Real Typesense declared type, including array suffixes such as `string[]`. */
  readonly type: string;
  readonly facet: boolean;
  /** Typesense `optional`; the implicit `id` is always reported non-null. */
  readonly optional: boolean;
  readonly index: boolean;
  readonly sort: boolean;
  readonly infix: boolean;
}

export interface TypesenseCollectionSchema {
  readonly name: string;
  readonly fields: readonly TypesenseFieldDefinition[];
  readonly defaultSortingField?: string;
  readonly numDocuments?: number;
}

export type TypesenseSchemaDiscovery =
  | { readonly status: "available"; readonly schema: TypesenseCollectionSchema }
  | { readonly status: "unavailable"; readonly reason: TypesenseMetadataFailure; readonly httpStatus?: number };

export type TypesenseCollectionDiscovery =
  | { readonly status: "available"; readonly collections: readonly string[]; readonly truncated: boolean }
  | { readonly status: "unavailable"; readonly reason: TypesenseMetadataFailure; readonly httpStatus?: number };

const FIELD_TYPE = /^[A-Za-z][A-Za-z0-9[\]_]*$/u;

function failureFor(error: unknown): { readonly reason: TypesenseMetadataFailure; readonly httpStatus?: number } {
  if (error instanceof TypesenseHttpError) {
    return {
      reason: error.status === 401 ? "unauthorized" : error.status === 403 ? "forbidden" : error.status === 404 ? "not-found" : "unavailable",
      httpStatus: error.status,
    };
  }
  if (error instanceof TypesenseRequestError || error instanceof TypesenseResponseSizeError) return { reason: "unavailable" };
  if (error instanceof TypeError) return { reason: "malformed" };
  return { reason: "unavailable" };
}

export function metadataFailure(error: unknown): { readonly reason: TypesenseMetadataFailure; readonly httpStatus?: number } {
  return failureFor(error);
}

export function supportedDeclaredType(type: string): boolean {
  return type === "string" || type === "string[]"
    || type === "int32" || type === "int32[]"
    || type === "int64" || type === "int64[]"
    || type === "float" || type === "float[]"
    || type === "bool" || type === "bool[]"
    || type === "object" || type === "object[]"
    || type === "geopoint" || type === "geopoint[]"
    || type === "geopolygon" || type === "auto";
}

function requiredString(value: unknown, label: string, maximum = 1_024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !value.isWellFormed()) {
    throw new TypeError(`malformed Typesense ${label}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) throw new TypeError(`malformed Typesense ${label}`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`malformed Typesense ${label}`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`malformed Typesense ${label}`);
  }
  return value;
}

/** Parses the real collection schema. Arrays keep their declared native type. */
export function parseCollectionSchema(value: unknown, expectedName: string, maxFields: number): TypesenseCollectionSchema {
  if (!isObject(value)) throw new TypeError("malformed Typesense collection schema");
  const name = requiredString(value.name, "collection name", 256);
  if (name !== expectedName) throw new TypeError("Typesense collection schema name does not match the configured collection");
  if (!Array.isArray(value.fields)) throw new TypeError("malformed Typesense collection fields");
  if (value.fields.length > maxFields) throw new RangeError("Typesense collection fields exceed maxColumns");
  const seen = new Set<string>();
  const fields: TypesenseFieldDefinition[] = [];
  for (const raw of value.fields) {
    if (!isObject(raw)) throw new TypeError("malformed Typesense collection field");
    const fieldName = requiredString(raw.name, "field name", 256);
    if (fieldName.startsWith("$") || /[,\t\r\n]/u.test(fieldName)) throw new TypeError("unsupported Typesense field name");
    if (seen.has(fieldName)) throw new TypeError("duplicate Typesense field name");
    seen.add(fieldName);
    const type = requiredString(raw.type, "field type", 64);
    if (!FIELD_TYPE.test(type) || !supportedDeclaredType(type)) throw new TypeError("unsupported Typesense field type");
    if (fieldName === "id" && type !== "string") throw new TypeError("explicit Typesense id field type must be string");
    fields.push(Object.freeze({
      name: fieldName,
      type,
      facet: optionalBoolean(raw.facet, "field facet", false),
      // Typesense always returns the id string and assigns one when omitted, so
      // an explicitly optional id is normalised to non-null. It is not invented
      // twice when declared.
      optional: fieldName === "id" ? false : optionalBoolean(raw.optional, "field optional", false),
      index: optionalBoolean(raw.index, "field index", true),
      sort: optionalBoolean(raw.sort, "field sort", false),
      infix: optionalBoolean(raw.infix, "field infix", false),
    }));
  }
  if (!seen.has("id")) {
    fields.push(Object.freeze({
      name: "id",
      type: "string",
      facet: false,
      optional: false,
      index: true,
      sort: false,
      infix: false,
    }));
  }
  const defaultSortingField = value.default_sorting_field === undefined
    ? undefined
    : requiredString(value.default_sorting_field, "default_sorting_field", 256);
  const numDocuments = optionalNumber(value.num_documents, "num_documents");
  return Object.freeze({
    name,
    fields: Object.freeze(fields),
    ...(defaultSortingField === undefined ? {} : { defaultSortingField }),
    ...(numDocuments === undefined ? {} : { numDocuments }),
  });
}

/** Parses `GET /collections` and never turns a denial into an empty list. */
export function parseCollectionList(value: unknown, maximum: number): { readonly collections: readonly string[]; readonly truncated: boolean } {
  if (!Array.isArray(value)) throw new TypeError("malformed Typesense collection list");
  const truncated = value.length > maximum;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, maximum)) {
    if (!isObject(entry)) throw new TypeError("malformed Typesense collection entry");
    const name = requiredString(entry.name, "collection name", 256);
    if (seen.has(name)) throw new TypeError("duplicate Typesense collection name");
    seen.add(name);
    names.push(name);
  }
  return { collections: Object.freeze(names.sort()), truncated };
}

export function schemaFieldTypes(schema: TypesenseCollectionSchema): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const field of schema.fields) result.set(field.name, field.type);
  return result;
}
