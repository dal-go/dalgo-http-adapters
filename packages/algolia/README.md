# @dal-go/dalgo2algolia

`@dal-go/dalgo2algolia` maps the semantically safe subset of DALgo to the [Algolia Search REST API](https://www.algolia.com/doc/rest-api/search/). It uses browser-native `fetch`; no vendor SDK is required.

```ts
const database = new AlgoliaDatabase({
  applicationId: "YOUR_APP_ID",
  apiKey: "RESTRICTED_SEARCH_KEY",
  indexes: { products: "products_public" },
});
```

## Supported surface

- Search-key reads: `get`, `getMany`, and bounded, top-level `query`.
- Write-key operations: full replacement `set` and idempotent `delete`, only with `access: "write"`.
- Query filters: scalar equality/inequality, numeric comparisons, `in`/`not-in`, `DOCUMENT_ID`, `limit`, and offsets that are whole pages. Non-`objectID` filters require matching [Algolia attributes-for-faceting configuration](https://www.algolia.com/doc/api-reference/api-parameters/attributesForFaceting/).

The adapter maps each DALgo collection explicitly to an Algolia index and owns the `objectID` field. DALgo IDs are non-empty strings, matching Algolia object IDs. `getMany` uses Algolia's [multiple object retrieval](https://www.algolia.com/doc/libraries/sdk/v1/methods/get-objects), whose response order and missing-item representation map directly to DALgo.

`set` uses Algolia's documented [add-or-replace operation](https://www.algolia.com/doc/libraries/sdk/methods/search/add-or-update-object), and `delete` uses [delete object](https://www.algolia.com/doc/rest-api/search/delete-object). Search requests use Algolia's DSN search host; mutations use the application API host. Successful write responses only confirm that Algolia queued an indexing task: writes are not guaranteed searchable until that task completes.

## Deliberate limitations

Algolia does not offer atomic create-only or DALgo-style conditional patch operations, so `insert` and `update` are rejected. Transactions, aggregations, streaming/realtime, cursors, nested/collection-group queries, generic ordering, full-text query input, and array filters are also rejected rather than approximated. Map a configured Algolia replica as a separate DALgo collection when its ranking order is needed.

The adapter sends only a blank Algolia text query plus DALgo filters. Therefore it is a records/filter adapter, not a full arbitrary-search wrapper.

## Browser security and CORS

Algolia's [search keys are designed to be public](https://support.algolia.com/hc/en-us/articles/18966776061329-Can-the-search-API-key-be-public), but only after restrictions limit indices, filters, rate, and expiration to the intended browser use. `access` defaults to `"search"`, so browser code cannot accidentally use this adapter's mutation methods. Algolia's HTTPS endpoints are CORS-enabled for normal browser Search API use.

Never put an Admin or write-capable API key in browser JavaScript. Writes require `access: "write"` and must run in a trusted server/worker, with a narrowly scoped write key. The adapter redacts response bodies and transport causes, rejects redirects, bounds request/response sizes, and never accepts credentials in a URL.

Official SDKs exist for [JavaScript](https://www.algolia.com/doc/libraries/javascript/), but this package deliberately implements DALgo contracts over the documented HTTP data plane.
