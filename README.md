# DALgo TypeScript HTTP adapter catalog

Qualification matrix and delivery catalog for database data planes that can be used over HTTP/HTTPS from JavaScript.

The reference implementation is [`@dal-go/dalgo2firestore`](packages/firestore). Every adapter targets the contracts from [`dalgo-js`](https://github.com/dal-go/dalgo-js), exposes only DALgo semantics it can preserve, and fails explicitly for unsupported operations. The complete qualification evidence is in [`qualification-matrix.md`](qualification-matrix.md).

## Packages

| Adapter | Local package |
|---|---|
| Algolia | [`@dal-go/dalgo2algolia`](packages/algolia) |
| Appwrite | [`@dal-go/dalgo2appwrite`](packages/appwrite) |
| BigQuery | [`@dal-go/dalgo2bigquery`](packages/bigquery) |
| ClickHouse | [`@dal-go/dalgo2clickhouse`](packages/clickhouse) |
| Cosmos DB | [`@dal-go/dalgo2cosmosdb`](packages/cosmosdb) |
| Couchbase | [`@dal-go/dalgo2couchbase`](packages/couchbase) |
| CouchDB | [`@dal-go/dalgo2couchdb`](packages/couchdb) |
| Databricks | [`@dal-go/dalgo2databricks`](packages/databricks) |
| DynamoDB | [`@dal-go/dalgo2dynamodb`](packages/dynamodb) |
| Elasticsearch | [`@dal-go/dalgo2elasticsearch`](packages/elasticsearch) |
| Firebase Realtime Database | [`@dal-go/dalgo2firebase-rtdb`](packages/firebase-rtdb) |
| Firestore | [`@dal-go/dalgo2firestore`](packages/firestore) |
| IndexedDB | [`@dal-go/dalgo2indexeddb`](packages/indexeddb) |
| InfluxDB | [`@dal-go/dalgo2influxdb`](packages/influxdb) |
| libSQL | [`@dal-go/dalgo2libsql`](packages/libsql) |
| Neo4j | [`@dal-go/dalgo2neo4j`](packages/neo4j) |
| OpenSearch | [`@dal-go/dalgo2opensearch`](packages/opensearch) |
| OpenVaultDB | [`@dal-go/dalgo2ovdb`](packages/ovdb) |
| PostgREST | [`@dal-go/dalgo2postgrest`](packages/postgrest) |
| Qdrant | [`@dal-go/dalgo2qdrant`](packages/qdrant) |
| Redshift | [`@dal-go/dalgo2redshift`](packages/redshift) |
| Snowflake | [`@dal-go/dalgo2snowflake`](packages/snowflake) |
| Solr | [`@dal-go/dalgo2solr`](packages/solr) |

Import revisions and the completed standalone-repository cutover are recorded in [LEGACY_REPOSITORIES.md](LEGACY_REPOSITORIES.md).

## Development

The workspace uses Node.js 24 and pnpm 11.20. Install once at the repository
root, then run the complete adapter gate or select one package:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @dal-go/dalgo2firestore check
```

All packages use the same pinned DALgo contract revision. No adapter is
published to npm by this repository yet.

## Classification

- **Browser-ready** — direct browser use is practical with a public-client authentication model and suitable CORS support. This does not permit account keys, service-account keys, admin keys, or unrestricted database tokens.
- **Browser + ephemeral token** — direct browser HTTP is possible only with a backend-issued, narrowly scoped, short-lived token or SAS. The token broker is part of the deployment contract; this is not browser-native authentication.
- **HTTP-capable** — the application data plane is useful over HTTP, but credentials, CORS, private networking, or product semantics normally require a trusted JavaScript runtime or proxy.
- **Not applicable** — HTTP is management-only, the supported data plane uses another wire protocol, or the HTTP surface is not useful enough for a DALgo adapter.

An official SDK using HTTP internally does not by itself make a product browser-ready. Long-lived database, service-account, account-key, private-key, or cloud access-key credentials must not be shipped to browsers.

## Capability legend

| Mark | Meaning |
|---|---|
| Yes | Supported by the qualified data plane. |
| Limited | Available with a product-specific scope or important mismatch. |
| No | Not provided by that data plane. |
| N/A | No qualifying HTTP data plane. |

## Priority qualification matrix

| Priority | Product / reusable protocol | Class | Read | Insert | Update | Delete | Query / filter | Aggregation | Transactions | Streaming / realtime | Browser and authentication | DALgo decision |
|---:|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | MongoDB Atlas | Not applicable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | The former browser-capable Data API reached EOL on 2025-09-30; Atlas Administration API is management-only. | No adapter for the retired API. MongoDB wire-protocol drivers are a separate server-side concern. |
| 2 | Snowflake SQL API | HTTP-capable | Yes | Yes | Yes | Yes | SQL | Yes | Yes | Async result polling, not CDC | OAuth, key-pair JWT, PAT, or workload identity; no documented public-browser credential/CORS model. | `dalgo2snowflake-js`; warehouse/table mapping and explicit unsupported semantics. |
| 3 | Databricks SQL Statement Execution API | HTTP-capable | Yes | Yes | Yes | Yes | SQL | Yes | Limited | Async statements and chunks, not a change feed | PAT/OAuth/service principal; trusted runtime or proxy. | `dalgo2databricks-js`; warehouse/table mapping. |
| 4 | Redis / Redis Cloud | Not applicable | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | Redis Cloud REST manages subscriptions and databases; the data plane is RESP/TLS. | Do not confuse the management API with Redis commands. |
| 5 | Elasticsearch-compatible REST | HTTP-capable | Yes | Yes | Yes | Yes | Query DSL | Yes | No multi-document ACID | No generic CDC | CORS is configurable but cluster credentials belong behind a proxy; restricted Search Applications can be browser-facing. | `dalgo2elasticsearch-js`; share protocol support with compatible deployments where behavior matches. |
| 6 | Amazon DynamoDB | Browser-ready | Yes | Yes | Yes | Yes | Query, Scan, PartiQL | Limited | TransactGet / TransactWrite | DynamoDB Streams | AWS SDK v3 works in browsers with temporary, narrowly scoped Cognito credentials; never embed long-lived keys. | `dalgo2dynamodb-js`; preserve partition/sort-key and consistency semantics. |
| 7 | Google BigQuery REST | HTTP-capable | Yes | DML / streaming insert | DML | DML | GoogleSQL jobs | Yes | SQL scripts, limited | Streaming writes, not row CDC | User OAuth can work in browsers; service-account credentials are server-only. | `dalgo2bigquery-js`; analytical query adapter, not OLTP parity. |
| 8 | Neo4j Query API | HTTP-capable | Cypher | Cypher | Cypher | Cypher | Cypher | Yes | Explicit HTTP transactions on Aura and single-instance self-managed deployments | Result streaming, not CDC | Basic/token credentials and deployment CORS normally require a trusted proxy; the browser-capable JS driver uses Bolt/WebSocket, not this HTTP API. | `dalgo2neo4j-js`; graph-specific key and relationship mapping. |
| 9 | Apache Solr JSON/HTTP APIs | HTTP-capable | Yes | Yes | Yes | Yes | Solr query APIs | Yes | No general ACID | Streaming Expressions, not CDC | CORS/auth deployment-specific; admin credentials are not browser-safe. | `dalgo2solr-js`; search semantics only. |
| 10 | ClickHouse HTTP interface | HTTP-capable | Yes | Yes | Limited | Limited | SQL | Yes | Limited | Streaming request/results | Credentials and CORS deployment-specific; normally trusted runtime. | `dalgo2clickhouse-js`; analytical SQL semantics. |
| 11 | InfluxDB HTTP API | HTTP-capable | Yes | Yes | Limited | Limited | Flux/SQL/InfluxQL by version | Yes | No general ACID | Request/result streaming, not CDC | Tokens should normally remain server-side. | `dalgo2influxdb-js`; time-series-specific adapter. |
| 12 | OpenSearch-compatible REST | HTTP-capable | Yes | Yes | Yes | Yes | Query DSL, SQL/PPL | Yes | No multi-document ACID | No generic CDC | SigV4 or fine-grained credentials plus CORS/VPC constraints normally require a proxy. | `dalgo2opensearch-js`; reuse Elasticsearch protocol code only where verified compatible. |
| 13 | Azure Cosmos DB for NoSQL REST | HTTP-capable / ephemeral-token browser | Yes | Yes | Yes | Yes | Cosmos SQL | Yes | Partition-scoped batch / stored procedures | Change feed | Master/account keys are never browser-safe; browser use requires a backend-issued resource token or carefully designed Entra/network setup. | `dalgo2cosmosdb-js`; partition key is explicit; do not claim browser-native auth. |
| 14 | Amazon Redshift Data API | HTTP-capable | Yes | Yes | Yes | Yes | SQL | Yes | Transactional batch | Async statements, not CDC | IAM/Secrets Manager; server-side. | `dalgo2redshift-js`; analytical SQL semantics. |
| 15 | Couchbase HTTP data services | HTTP-capable | Yes | Yes | Yes | Yes | SQL++ / search | Yes | Limited | Eventing/change mechanisms vary | Cluster/service credentials and CORS need deployment review. | Separate SQL++ and key-value capability mapping; do not wrap management REST. |
| 16 | Google Firestore | Browser-ready | Yes | Yes | Yes | Yes | Structured query | Count/sum/average | Batched writes / transactions | Realtime listeners | Firebase Auth and Security Rules are designed for public clients. | Implemented: [`@dal-go/dalgo2firestore`](packages/firestore). |
| 17 | Firebase Realtime Database REST/Web SDK | Browser-ready | Yes | Yes | Yes | Yes | Key/range query | No server aggregation | Atomic updates / client transaction retries | SSE/WebSocket | Firebase Auth and Security Rules; browser-first. | `dalgo2firebase-rtdb-js`; tree/path semantics and limited query composition. |
| 18 | Apache CouchDB HTTP | Browser-ready | Yes | Yes | Yes | Yes | Mango / views | Views | Per-document MVCC, bulk is not ACID | `_changes` feeds | CORS configurable; use scoped users/proxy as appropriate. | `dalgo2couchdb-js`; expose revision/conflict semantics. |
| 19 | PostgREST protocol / Supabase | Browser-ready | Yes | Yes | Yes | Yes | URL filters / embedding / RPC | Yes | One request; multi-step logic via PostgreSQL functions | Provider-specific realtime is separate | CORS plus JWT/RLS enables public clients when policies are correct. | [`@dal-go/dalgo2postgrest`](packages/postgrest), not a Supabase-only adapter. |
| 20 | libSQL protocol / Turso | HTTP-capable | Yes | Yes | Yes | Yes | SQL | Yes | Hrana batches and batons; DALgo callback transactions unsupported | Replication/watch capabilities vary | Hrana v3 uses HTTP, but broad database tokens are not browser-safe; use a trusted runtime or narrowly scoped token broker. | Implemented: [`@dal-go/dalgo2libsql`](packages/libsql), a provider-neutral Hrana v3 adapter rather than a Turso-only wrapper. |
| 21 | Qdrant REST | HTTP-capable | Yes | Upsert only; atomic insert unsupported | Atomic update unsupported | Yes | Vector/filter search | Vector/search aggregation features | No DALgo-equivalent transactions | Updates/streaming are not general CDC | CORS may be deployment-specific and API keys normally require a trusted runtime or proxy. | Implemented: [`@dal-go/dalgo2qdrant`](packages/qdrant), with explicit vector search and no fake conditional-write semantics. |
| 22 | Pinecone data API | HTTP-capable | Yes | Upsert | Update | Delete | Vector/filter search | Limited | No | No generic CDC | API keys are server credentials; use a proxy. | `dalgo2pinecone-js`; vector semantics only. |
| 23 | Algolia Search/Records APIs | Browser-ready for search; trusted-runtime writes | Yes | Upsert only; atomic insert unsupported | Atomic update unsupported | Yes | Search/filter | Facets | No | Async indexing task receipts, not CDC | Restricted search-only keys are browser-safe; writes require an explicit trusted mode and a write-capable key. | Implemented: [`@dal-go/dalgo2algolia`](packages/algolia), with separate DSN read and write hosts. |
| 24 | Appwrite TablesDB rows API | Browser-ready | Yes | Yes | Yes | Yes | JSON queries | Limited | No DALgo callback transactions | Realtime is a separate API | Browser sessions/JWT and row permissions are public-client-oriented; API keys require explicit trusted-server mode. | Implemented: [`@dal-go/dalgo2appwrite`](packages/appwrite), against the current TablesDB rows HTTP API. |
| 25 | PocketBase records API | Browser-ready | Yes | Yes | Yes | Yes | Filter/sort/expand | Limited | No public multi-operation transaction | Realtime subscriptions | Browser SDK, collection rules, and user tokens. | `dalgo2pocketbase-js`. |

## Hyperscaler coverage

### Google Cloud

| Product | Class | Qualifying data plane and decision |
|---|---|---|
| Firestore native mode | Browser-ready | Existing Firestore Web SDK adapter; REST provides CRUD, queries, aggregation, transactions, and a streaming Listen RPC, while normal browser realtime listeners use the Firebase Web SDK. |
| Firestore in Datastore mode | HTTP-capable | REST lookup/commit/query/aggregation and transactions; candidate `dalgo2datastore-js`. Browser use needs user OAuth or a token broker, never a service-account key. |
| Firebase Realtime Database | Browser-ready | REST and Web SDK; candidate `dalgo2firebase-rtdb-js`. |
| Firebase Data Connect | Not applicable | Generated, typed application GraphQL operations are not a generic database data plane for arbitrary DALgo collections. |
| BigQuery | HTTP-capable | REST jobs/query/table data; candidate analytical adapter. |
| Spanner | HTTP-capable | REST read, SQL, mutations, sessions and read-write transactions; candidate `dalgo2spanner-js`. |
| Bigtable | Not applicable | Useful data API is gRPC rather than a general browser JSON/HTTP surface. |
| AlloyDB | Not applicable | Administration is REST; data plane is PostgreSQL wire protocol. |
| Cloud SQL PostgreSQL / MySQL / SQL Server | Not applicable | Administration is REST; data plane uses native database protocols/connectors. |
| Memorystore Redis / Valkey | Not applicable | Administration is REST; data plane uses RESP in private networking. |

### Amazon Web Services

| Product | Class | Qualifying data plane and decision |
|---|---|---|
| DynamoDB | Browser-ready | HTTPS JSON API and browser-capable AWS SDK with temporary IAM credentials; high-priority adapter. |
| Redshift | HTTP-capable | Redshift Data API; server-oriented analytical adapter. |
| Aurora PostgreSQL / MySQL | HTTP-capable where Data API is enabled | RDS Data API provides SQL, batches, and explicit transactions using IAM plus Secrets Manager; candidate trusted-runtime adapter. |
| RDS PostgreSQL / MySQL / MariaDB / SQL Server / Oracle | Not applicable | RDS HTTP APIs manage instances; data uses native wire protocols. |
| DocumentDB | Not applicable | MongoDB wire protocol; no generic HTTP data API. |
| Neptune | HTTP-capable | HTTPS openCypher, SPARQL, and Neptune data APIs; specialized graph adapter with SigV4/VPC constraints. |
| Timestream | HTTP-capable | HTTPS WriteRecords and Query; specialized time-series adapter. |
| Keyspaces for Apache Cassandra | Not applicable | The HTTPS AWS API manages keyspaces/tables; row CRUD uses CQL over TLS on port 9142, so there is no qualifying HTTP data plane. |
| MemoryDB / ElastiCache Redis or Valkey | Not applicable | Data plane uses RESP in a VPC; HTTP APIs are management-only. |
| OpenSearch Service | HTTP-capable | Signed REST search/document data plane; normally proxy/server. |
| S3 Select | Not applicable | Querying one object is useful but is not a database CRUD data plane. |

### Microsoft Azure

| Product | Class | Qualifying data plane and decision |
|---|---|---|
| Cosmos DB for NoSQL | HTTP-capable / ephemeral-token browser | HTTPS document CRUD, SQL query, change feed, and partition-scoped transactions; browser use requires a backend-issued resource token or carefully designed Entra/network setup; candidate `dalgo2cosmosdb-js`. |
| Cosmos DB MongoDB / Cassandra / Gremlin APIs | Not applicable to generic HTTP DALgo | Data uses MongoDB, CQL, or Gremlin driver protocols; keep separate protocol adapters if pursued. |
| Cosmos DB Table API / Azure Table Storage | Browser + ephemeral SAS | Table REST/OData CRUD and query, same-partition entity-group transactions, documented CORS; only narrowly scoped short-lived SAS is suitable for browser use, never account keys; candidate `dalgo2azure-table-js`. |
| Azure SQL Database / Managed Instance | Not applicable | ARM is management-only; data plane is TDS unless a separate application gateway is introduced. |
| Azure Database for PostgreSQL / MySQL | Not applicable | ARM is management-only; data uses native protocols. |
| Azure Managed Redis | Not applicable | ARM is management-only; data uses RESP. |
| Azure Data Explorer / Kusto | HTTP-capable | Query/management HTTP endpoint and SDKs; analytical, trusted-runtime adapter rather than CRUD parity. |
| Microsoft Fabric databases / warehouses | Not applicable directly | REST manages Fabric items; data access is SQL connectivity or a separately deployed gateway. |

## Primary official sources

- [MongoDB Atlas App Services EOL notice](https://www.mongodb.com/docs/api/doc/atlas-app-services-admin-api-v3)
- [Snowflake SQL API](https://docs.snowflake.com/en/developer-guide/sql-api)
- [Databricks SQL Statement Execution API](https://docs.databricks.com/aws/en/dev-tools/sql-execution-tutorial)
- [Redis Cloud REST API](https://redis.io/docs/latest/operate/rc/api/get-started/use-rest-api/)
- [Elasticsearch REST conventions](https://www.elastic.co/guide/en/elasticsearch/reference/current/api-conventions.html)
- [DynamoDB low-level API](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.LowLevelAPI.html)
- [BigQuery REST API](https://cloud.google.com/bigquery/docs/reference/rest/v2)
- [Neo4j Query API](https://neo4j.com/docs/query-api/current/)
- [Firestore REST API](https://firebase.google.com/docs/firestore/reference/rest)
- [Firebase Realtime Database REST API](https://firebase.google.com/docs/reference/rest/database)
- [Cosmos DB REST API](https://learn.microsoft.com/rest/api/cosmos-db/)
- [Azure Table Service REST API](https://learn.microsoft.com/rest/api/storageservices/table-service-rest-api)
- [CouchDB changes feed](https://docs.couchdb.org/en/stable/api/database/changes.html)
- [PostgREST API](https://docs.postgrest.org/en/stable/references/api.html)
- [libSQL Hrana over HTTP v3 specification](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md)
- [Qdrant interfaces](https://qdrant.tech/documentation/interfaces/)
- [Algolia JavaScript API](https://www.algolia.com/developers/search-api-javascript)
- [Appwrite TablesDB rows API](https://appwrite.io/docs/references/cloud/client-web/tablesDB)

## Delivery status

| Adapter | Status |
|---|---|
| [`@dal-go/dalgo2firestore`](packages/firestore) | Existing reference adapter validated at its current main: Firestore Web SDK CRUD, structured queries, multi-document reads, and transactions with mocked contract tests and a separate emulator integration test. |
| [`@dal-go/dalgo2indexeddb`](packages/indexeddb) | Implemented local browser adapter. |
| [`@dal-go/dalgo2ovdb`](packages/ovdb) | Implemented OpenVaultDB HTTP adapter. |
| [`@dal-go/dalgo2snowflake`](packages/snowflake) | Implemented read/query SQL API adapter; writes and DALgo callback transactions remain explicitly unsupported. |
| [`@dal-go/dalgo2databricks`](packages/databricks) | Implemented read/query Statement Execution API adapter with complete inline chunk validation; writes and DALgo callback transactions remain explicitly unsupported. |
| [`@dal-go/dalgo2elasticsearch`](packages/elasticsearch) | Implemented HTTP document CRUD/query adapter; DALgo callback transactions remain explicitly unsupported. |
| [`@dal-go/dalgo2dynamodb`](packages/dynamodb) | Implemented browser-capable AWS SDK v3 adapter for the documented two-key table layout; requires temporary scoped credentials. |
| [`@dal-go/dalgo2bigquery`](packages/bigquery) | Implemented bounded read/query REST adapter with parameterized GoogleSQL; mutations and callback transactions remain explicitly unsupported. |
| [`@dal-go/dalgo2neo4j`](packages/neo4j) | Implemented configured-label CRUD/query adapter over Query API v2, with explicit transactions limited to Aura affinity or declared single-instance deployments. |
| [`@dal-go/dalgo2solr`](packages/solr) | Implemented bounded document CRUD/query adapter over Solr JSON Request and Update APIs; deployments must keep Solr behind a trusted proxy or equivalent access control. |
| [`@dal-go/dalgo2clickhouse`](packages/clickhouse) | Implemented bounded parameterized read/query support over the ClickHouse HTTP interface plus an explicit append-only JSONEachRow helper; OLTP-style DALgo mutations and callback transactions remain unsupported. |
| [`@dal-go/dalgo2influxdb`](packages/influxdb) | Implemented bounded InfluxDB 3 SQL reads/queries plus an explicit line-protocol append helper; point replacement, update, delete, and callback transactions remain unsupported. |
| [`@dal-go/dalgo2opensearch`](packages/opensearch) | Implemented bounded provider-neutral OpenSearch REST CRUD/query adapter with direct-index and string-ID contracts; AWS SigV4 signing remains an injected trusted-runtime responsibility. |
| [`@dal-go/dalgo2redshift`](packages/redshift) | Implemented bounded read/query adapter over the asynchronous Redshift Data API with explicit table/key/projection mappings; writes and DALgo callback transactions remain unsupported. |
| [`@dal-go/dalgo2cosmosdb`](packages/cosmosdb) | Implemented bounded, partition-scoped Cosmos DB for NoSQL REST CRUD/query adapter with opaque continuation cursors and an explicit ephemeral-token/trusted-proxy authentication boundary. |
| [`@dal-go/dalgo2libsql`](packages/libsql) | Implemented provider-neutral CRUD/query adapter over the libSQL Hrana v3 HTTP pipeline, with explicit table/key/projection mappings, bounded response handling, and no claim of DALgo callback-transaction support. |
| [`@dal-go/dalgo2postgrest`](packages/postgrest) | Implemented bounded top-level CRUD/query adapter for the provider-neutral PostgREST protocol; callback transactions, cursors, embedding, and RPC remain explicitly unsupported. |
| [`@dal-go/dalgo2qdrant`](packages/qdrant) | Implemented bounded point get/upsert/delete, filtered reads, and explicit vector search over Qdrant REST; atomic insert/update, transactions, generic ordering, and DALgo cursors remain explicitly unsupported. |
| [`@dal-go/dalgo2appwrite`](packages/appwrite) | Implemented bounded TablesDB row CRUD/query with current JSON query encoding, explicit browser-session and trusted-server credential modes, and no claim of DALgo callback-transaction support. |
| [`@dal-go/dalgo2algolia`](packages/algolia) | Implemented bounded object reads/search plus explicit trusted-runtime upsert/delete; atomic conditional writes, DALgo cursors, generic ordering, nesting, and transactions remain unsupported. |

## Adapter acceptance bar

Every implemented adapter must:

1. Cite the official data-plane contract it targets.
2. Map that contract to DALgo keys, records, structured queries, codecs, and transactions.
3. Reject unsupported DALgo semantics before making a request.
4. Keep secrets out of URLs, logs, analytics, metadata, and persisted browser state.
5. Include deterministic contract tests, a minimal example, packaged type declarations, and CI.
6. State whether verification used mocks/emulators or a live service.
7. Receive an independent consistency/security review before being marked implemented here.
