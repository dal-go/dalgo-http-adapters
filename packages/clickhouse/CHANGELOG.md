# @dalgo/dalgo2clickhouse

## 0.2.0

### Minor Changes

- 7d4cac1: Add an optional anonymous ordinal query contract and the canonical read-only ClickHouse HTTP executor with exact numeric and temporal values, preserving keyed core Database compatibility. Require released @dalgo/core 0.8.1 or newer within 0.8.x for the public ParsedTugQLQuery declaration. The public ClickHouse entry contains only the native ordinal executor; the historical private keyed/append prototype is excluded.
