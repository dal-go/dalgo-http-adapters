/**
 * PostgREST query-string parameters that PostgREST parses as protocol controls
 * rather than as column filters. A filter keyed by one of them would be
 * consumed as a control (for example, a column named `limit` would become the
 * page size) and the predicate would silently disappear.
 *
 * PostgREST's documented identifier quoting marks a key as a field name
 * instead, so a reserved name is rendered as a quoted key rather than refused.
 * See "Reserved characters" in the PostgREST URL grammar: a quoted identifier
 * is a column reference, e.g. `?%22information.cpe%22=like.*MS*`.
 */
export const RESERVED_QUERY_FIELDS: ReadonlySet<string> = new Set([
  "select",
  "columns",
  "on_conflict",
  "order",
  "limit",
  "offset",
  "and",
  "or",
]);

/**
 * Renders a column name as a PostgREST parameter key or field reference.
 *
 * Every name reaching this function has already passed the adapter's simple
 * SQL-identifier check, so a reserved name only needs surrounding double
 * quotes and no escaping.
 */
export function postgrestFieldKey(field: string): string {
  return RESERVED_QUERY_FIELDS.has(field) ? `"${field}"` : field;
}
