import { UnsupportedError, type Codec, type Database, type Key, type QueryPage, type ReadwriteTransaction, type RecordSnapshot, type StructuredQuery, type UpdateData } from "@dalgo/core";
import { encodeNativeCosmosJson, NativeCosmosJsonNumber, type NativeCosmosJson, type NativeCosmosJsonObject } from "./native-json.js";
import { NativeManager, type NativeOperation } from "./native-operation.js";
import { NativeRegistry, type NativeJourney, type NativeRegistration, type NativeSessionState } from "./native-registry.js";
import { nativeBytes, nativeDigest, nativeHeader, nativeResponse, type NativeResponse } from "./native-transport.js";
import { nativeCredentialHeader, nativeHttpFailure, NativeCosmosError, type NativeCosmosAuthorizationProvider, type NativeCosmosBatchResult, type NativeCosmosCursor, type NativeCosmosDocument, type NativeCosmosKey, type NativeCosmosNoSqlOptions, type NativeCosmosPage, type NativeCosmosQuery, type NativeCosmosReadOptions, type NativeCosmosReadResult, type NativeCosmosResponseMetadata, type NativeCosmosSession } from "./native-types.js";

function text(value: unknown, maximum: number, configuration = false): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || nativeBytes(value) > maximum) throw new NativeCosmosError(configuration ? "configuration" : "input");
  // This validates Unicode without invoking any caller serializer.
  encodeNativeCosmosJson(value, 6 * maximum + 2);
  return value;
}
function closedObject(input: unknown): Record<string, PropertyDescriptor> {
  if (typeof input !== "object" || input === null) throw new NativeCosmosError("input");
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new NativeCosmosError("input");
  return Object.getOwnPropertyDescriptors(input);
}
function closedArray(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw new NativeCosmosError("input");
  const length: unknown = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (typeof length !== "number" || length > maximum) throw new NativeCosmosError("bounds");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== length + 1) throw new NativeCosmosError("bounds");
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw new NativeCosmosError("input");
    const value: unknown = descriptor.value; result.push(value);
  }
  return result;
}
function keyValue(input: unknown): NativeCosmosKey {
  const descriptors = closedObject(input);
  const id: unknown = descriptors.id?.value; const partition: unknown = descriptors.partition?.value;
  const checkedId = text(id, 1024); const checkedPartition = text(partition, 2048);
  if (checkedId === "." || checkedId === ".." || /[/\\?#]/u.test(checkedId)) throw new NativeCosmosError("input");
  for (let i = 0; i < checkedId.length; i++) if (checkedId.charCodeAt(i) < 32 || checkedId.charCodeAt(i) === 127) throw new NativeCosmosError("input");
  return Object.freeze({ id: checkedId, partition: checkedPartition });
}
function object(value: NativeCosmosJson | undefined): value is NativeCosmosJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof NativeCosmosJsonNumber);
}
function array(value: NativeCosmosJson | undefined): value is readonly NativeCosmosJson[] { return Array.isArray(value); }
function resource(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new NativeCosmosError("configuration");
  return value;
}
interface PreparedQuery { readonly body: string; readonly partition: string; readonly limit: number; readonly cursor?: NativeCosmosCursor }
interface Observed { readonly response: NativeResponse; readonly fingerprint: string }
interface Stage<T> { readonly value: T; readonly registrations: readonly NativeRegistration[]; readonly consumed?: NativeCosmosCursor }

/** Read existing whole native documents; never creates a managed envelope. */
export class NativeCosmosNoSqlDatabase implements Database {
  readonly #manager: NativeManager;
  readonly #registry: NativeRegistry;
  readonly #endpoint: string;
  readonly #databaseId: string;
  readonly #containerId: string;
  readonly #partitionField: string;
  readonly #authScope: string;
  readonly #authorization: NativeCosmosAuthorizationProvider;
  readonly #fetch: typeof globalThis.fetch;
  readonly #collections = new Map<string, string>();
  public constructor(options: NativeCosmosNoSqlOptions) {
    this.#manager = new NativeManager(options); this.#registry = new NativeRegistry(this.#manager.limits);
    let url: URL;
    try { url = new URL(options.endpoint); } catch { throw new NativeCosmosError("configuration"); }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(loopback && url.protocol === "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") throw new NativeCosmosError("configuration");
    this.#endpoint = url.origin; this.#databaseId = resource(options.databaseId); this.#containerId = resource(options.containerId);
    this.#partitionField = text(options.partitionKeyField, 128, true);
    if (!/^[_A-Za-z][_0-9A-Za-z]*$/u.test(this.#partitionField) || ["id", "_etag", "_ts", "_rid", "_self", "_attachments"].includes(this.#partitionField)) throw new NativeCosmosError("configuration");
    this.#authScope = text(options.authScopeId, 4096, true);
    if (typeof options.authorization !== "function") throw new NativeCosmosError("configuration");
    this.#authorization = options.authorization; this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new NativeCosmosError("configuration");
    for (const [path, binding] of Object.entries(options.collections ?? {})) {
      this.#collections.set(text(path, 4096, true), text(binding.partition, 2048, true));
    }
  }
  public close(): void { this.#manager.close(); this.#registry.close(); }
  public configuredMetadata(): Readonly<{ databaseId: string; containerId: string; partitionKeyField: string; collections: Readonly<Record<string, { readonly partition: string }>>; provenance: "trusted configuration"; discovery: false; readOnly: true }> {
    return Object.freeze({ databaseId: this.#databaseId, containerId: this.#containerId, partitionKeyField: this.#partitionField, collections: Object.freeze(Object.fromEntries(Array.from(this.#collections, ([name, partition]) => [name, Object.freeze({ partition })]))), provenance: "trusted configuration", discovery: false, readOnly: true });
  }
  public getNative<T = NativeCosmosJsonObject>(key: NativeCosmosKey, options: NativeCosmosReadOptions<T> = {}): Promise<NativeCosmosReadResult<T>> {
    return this.operation(options.signal, async op => this.point(op, keyValue(key), options));
  }
  public existsNative(key: NativeCosmosKey, options: NativeCosmosReadOptions = {}): Promise<boolean> {
    return this.operation(options.signal, async op => {
      const staged = await this.point(op, keyValue(key), { ...(options.session === undefined ? {} : { session: options.session }) });
      return { ...staged, value: staged.value.document !== null };
    });
  }
  public getManyNative<T = NativeCosmosJsonObject>(keys: readonly NativeCosmosKey[], options: NativeCosmosReadOptions<T> = {}): Promise<NativeCosmosBatchResult<T>> {
    return this.operation(options.signal, async op => {
      const copied = closedArray(keys, Math.min(op.limits.maxKeys, op.limits.maxRows)).map(key => { op.check(); return keyValue(key); });
      // Validate every session/partition before the first authorization callback.
      for (const key of copied) this.#registry.session(options.session, key.partition);
      const documents: (NativeCosmosDocument<T> | null)[] = []; const metadata: NativeCosmosResponseMetadata[] = []; const registrations: NativeRegistration[] = [];
      for (const key of copied) {
        op.check(); const staged = await this.point(op, key, options);
        documents.push(staged.value.document); metadata.push(staged.value.metadata); registrations.push(...staged.registrations);
      }
      return { value: { documents, metadata }, registrations };
    });
  }
  public queryNative<T = NativeCosmosJsonObject>(query: NativeCosmosQuery, options: NativeCosmosReadOptions<T> = {}): Promise<NativeCosmosPage<T>> {
    return this.operation(options.signal, async op => this.queryStage(op, this.prepareQuery(op, query), options));
  }
  public get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return this.getWithSignal(key, undefined, codec); }
  public getWithSignal<T>(key: Key, signal: AbortSignal | undefined, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    return this.operation(signal, async op => {
      const native = this.bridgeKey(key);
      const staged = await this.point<T>(op, native, codec === undefined ? {} : { codec });
      const document = staged.value.document;
      const value: RecordSnapshot<T> = document === null ? { key, exists: false } : { key, exists: true, data: document.data, metadata: { ...document.metadata } };
      return { ...staged, value };
    });
  }
  public getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { return this.getManyWithSignal(keys, undefined, codec); }
  public getManyWithSignal<T>(keys: readonly Key[], signal: AbortSignal | undefined, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return this.operation(signal, async op => {
      if (keys.length > op.limits.maxKeys || keys.length > op.limits.maxRows) throw new NativeCosmosError("bounds");
      const copied = Array.from(keys); const natives = copied.map(key => { op.check(); return this.bridgeKey(key); });
      const value: RecordSnapshot<T>[] = []; const registrations: NativeRegistration[] = [];
      for (const [index, key] of copied.entries()) {
        const native = natives[index]; if (native === undefined) throw new NativeCosmosError("input");
        const staged = await this.point<T>(op, native, codec === undefined ? {} : { codec }); const document = staged.value.document;
        value.push(document === null ? { key, exists: false } : { key, exists: true, data: document.data, metadata: { ...document.metadata } }); registrations.push(...staged.registrations);
      }
      return { value, registrations };
    });
  }
  public insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void>;
  public insert(): Promise<void> { return this.notImplemented("native writes"); }
  public set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void>;
  public set(): Promise<void> { return this.notImplemented("native writes"); }
  public update(key: Key, data: UpdateData): Promise<void>;
  public update(): Promise<void> { return this.notImplemented("native writes"); }
  public delete(key: Key): Promise<void>;
  public delete(): Promise<void> { return this.notImplemented("native writes"); }
  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>>;
  public query(): Promise<unknown> { return this.notImplemented("native generic query compiler; use parameterized queryNative"); }
  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result>;
  public runReadwriteTransaction(): Promise<unknown> { return this.notImplemented("native callback transactions"); }
  private notImplemented<T>(feature: string): Promise<T> { return Promise.reject(new UnsupportedError(`Cosmos adapter ${feature} not implemented; provider capability is separate`)); }
  private bridgeKey(key: Key): NativeCosmosKey {
    const partition = this.#collections.get(key.collectionPath);
    if (partition === undefined || typeof key.id !== "string") throw new NativeCosmosError("input");
    return keyValue({ id: key.id, partition });
  }
  private async operation<T>(signal: AbortSignal | undefined, effect: (op: NativeOperation) => Promise<Stage<T>>): Promise<T> {
    const op = this.#manager.begin(signal);
    try {
      const staged = await effect(op);
      this.#registry.commit(op, staged.consumed, staged.registrations);
      return staged.value; // No foreign callback/await/check after ACK.
    } catch (error: unknown) { throw op.failure(error); }
    finally { op.finish(); }
  }
  private async request(op: NativeOperation, path: string, partition: string, body: string | undefined, session: NativeSessionState | undefined, fingerprint?: string, continuation?: string, count?: number, latestSession?: string): Promise<Observed> {
    op.request(body === undefined ? 0 : nativeBytes(body));
    const method = body === undefined ? "GET" : "POST"; const date = new Date().toUTCString();
    const resourceLink = method === "POST" ? path.slice(0, -5) : path;
    const credential = await op.io(() => this.#authorization({ method, resourcePath: path, resourceLink, resourceType: "docs", date, authScopeId: this.#authScope, signal: op.signal }));
    const authorization = nativeCredentialHeader(credential);
    const digest = await nativeDigest(op, ["cosmos-native-credential-v1", authorization]);
    if (fingerprint !== undefined && fingerprint !== digest) throw new NativeCosmosError("cursor");
    if (session !== undefined && session.fingerprint !== digest) throw new NativeCosmosError("session");
    const token = session === undefined ? undefined : latestSession ?? session.token;
    const response = await nativeResponse(op, () => this.#fetch(`${this.#endpoint}/${path}`, {
      method, redirect: "error", signal: op.signal,
      headers: {
        accept: "application/json", authorization, "x-ms-date": date, "x-ms-version": "2018-12-31",
        "x-ms-documentdb-partitionkey": encodeNativeCosmosJson([partition], 16_384),
        ...(body === undefined ? {} : { "content-type": "application/query+json", "x-ms-documentdb-isquery": "True", "x-ms-max-item-count": String(count) }),
        ...(token === undefined ? {} : { "x-ms-session-token": token, "x-ms-consistency-level": "Session" }),
        ...(continuation === undefined ? {} : { "x-ms-continuation": continuation }),
      }, ...(body === undefined ? {} : { body }),
    }));
    return { response, fingerprint: digest };
  }
  private path(id?: string): string {
    const parent = `dbs/${encodeURIComponent(this.#databaseId)}/colls/${encodeURIComponent(this.#containerId)}/docs`;
    return id === undefined ? parent : `${parent}/${encodeURIComponent(id)}`;
  }
  private observation(observed: Observed, partition: string, registrations: NativeRegistration[]): NativeCosmosResponseMetadata {
    const token = observed.response.sessionToken;
    if (token === undefined) return observed.response.metadata;
    const staged = this.#registry.observeSession(token, partition, observed.fingerprint); registrations.push(staged);
    return { ...observed.response.metadata, session: staged.handle as NativeCosmosSession };
  }
  private document<T>(op: NativeOperation, value: NativeCosmosJson | undefined, partition: string, metadata: NativeCosmosResponseMetadata, codec: Codec<T> | undefined, expectedId?: string): NativeCosmosDocument<T> {
    if (!object(value) || typeof value.id !== "string" || value[this.#partitionField] !== partition) throw new NativeCosmosError("protocol");
    const key = keyValue({ id: value.id, partition });
    if (expectedId !== undefined && key.id !== expectedId) throw new NativeCosmosError("protocol");
    const revision = value._etag;
    if (revision !== undefined && typeof revision !== "string") throw new NativeCosmosError("protocol");
    const etag = revision === undefined ? undefined : nativeHeader(revision);
    const snapshot = { ...metadata, ...(etag === undefined ? {} : { etag }) };
    const data = codec === undefined ? value as T : op.call(() => codec.decode(value));
    op.check(); return { key, data, metadata: snapshot };
  }
  private async point<T = NativeCosmosJsonObject>(op: NativeOperation, key: NativeCosmosKey, options: NativeCosmosReadOptions<T>): Promise<Stage<NativeCosmosReadResult<T>>> {
    const session = this.#registry.session(options.session, key.partition);
    const observed = await this.request(op, this.path(key.id), key.partition, undefined, session);
    op.rows(1); const registrations: NativeRegistration[] = [];
    const metadata = this.observation(observed, key.partition, registrations);
    const document = observed.response.status === 404 ? null : this.document(op, observed.response.body, key.partition, metadata, options.codec, key.id);
    return { value: { document, metadata }, registrations };
  }
  private prepareQuery(op: NativeOperation, query: NativeCosmosQuery): PreparedQuery {
    const partition = text(query.partition, 2048); const sql = text(query.sql, op.limits.maxRequestBytes);
    const limit = query.limit ?? op.limits.pageSize;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > op.limits.maxRows) throw new NativeCosmosError("input");
    const parameters = closedArray(query.parameters ?? [], 256);
    const names = new Set<string>();
    const copied = parameters.map(parameter => {
      op.check();
      const descriptor = closedObject(parameter);
      const name: unknown = descriptor.name?.value; const value: unknown = descriptor.value?.value;
      if (typeof name !== "string" || name.length > 128 || !/^@[A-Za-z][_A-Za-z0-9]*$/u.test(name) || names.has(name) || !Object.hasOwn(descriptor.value ?? {}, "value")) throw new NativeCosmosError("input");
      names.add(name); return { name, value };
    });
    const body = encodeNativeCosmosJson({ query: sql, parameters: copied }, op.limits.maxRequestBytes, () => { op.check(); });
    return { body, partition, limit, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) };
  }
  private async queryStage<T>(op: NativeOperation, query: PreparedQuery, options: NativeCosmosReadOptions<T>): Promise<Stage<NativeCosmosPage<T>>> {
    const session = this.#registry.session(options.session, query.partition);
    const scope = await nativeDigest(op, ["cosmos-native-query-v1", this.#endpoint, this.#databaseId, this.#containerId, this.#partitionField, this.#authScope, query.partition, query.body, String(query.limit), String(op.limits.pageSize), session?.token ?? ""]);
    const previous = this.#registry.cursor(query.cursor, scope, op);
    if (previous !== undefined) op.budget = previous.budget;
    const seenIds = new Set(previous?.seenIds); const seenTokens = new Set(previous?.seenTokens);
    const documents: NativeCosmosDocument<T>[] = []; const metadata: NativeCosmosResponseMetadata[] = []; const registrations: NativeRegistration[] = [];
    let continuation = previous?.continuation; let fingerprint = previous?.fingerprint; let latestSession = previous?.sessionToken;
    let pages = 0;
    for (;;) {
      op.check(); if (op.budget.failed || ++op.budget.pages > op.limits.maxPages) op.exhaust();
      const count = Math.min(op.limits.pageSize, query.limit - documents.length, op.limits.maxRows - op.budget.rows);
      if (count < 1) op.exhaust();
      const observed = await this.request(op, this.path(), query.partition, query.body, session, fingerprint, continuation, count, latestSession);
      if (observed.response.status !== 200) throw nativeHttpFailure(observed.response.status, observed.response.metadata);
      fingerprint = observed.fingerprint; pages++;
      const body = observed.response.body;
      if (!object(body) || !array(body.Documents) || body.Documents.length > count) throw new NativeCosmosError("protocol");
      if (body._count !== undefined && (!(body._count instanceof NativeCosmosJsonNumber) || !/^\d+$/u.test(body._count.lexeme) || Number(body._count.lexeme) !== body.Documents.length)) throw new NativeCosmosError("protocol");
      if (observed.response.count !== undefined && observed.response.count !== body.Documents.length) throw new NativeCosmosError("protocol");
      op.rows(body.Documents.length);
      const next = observed.response.continuation;
      if (next !== undefined && seenTokens.has(next)) throw new NativeCosmosError("protocol");
      // Validate all source identities before invoking any caller codec.
      for (const item of body.Documents) {
        if (!object(item) || typeof item.id !== "string" || item[this.#partitionField] !== query.partition || seenIds.has(item.id)) throw new NativeCosmosError("protocol");
        keyValue({ id: item.id, partition: query.partition }); seenIds.add(item.id);
      }
      const observedMetadata = this.observation(observed, query.partition, registrations); metadata.push(observedMetadata);
      for (const item of body.Documents) documents.push(this.document(op, item, query.partition, observedMetadata, options.codec));
      if (session !== undefined && observed.response.sessionToken !== undefined) latestSession = observed.response.sessionToken;
      continuation = next;
      if (next !== undefined) seenTokens.add(next);
      if (next === undefined || documents.length === query.limit) break;
    }
    let nextCursor;
    if (continuation !== undefined) {
      const state: NativeJourney = { scope, partition: query.partition, expires: previous?.expires ?? Math.min(op.expires, performance.now() + op.limits.cursorTtlMs), budget: op.budget, seenIds, seenTokens, continuation, fingerprint, ...(latestSession === undefined ? {} : { sessionToken: latestSession }) };
      const successor = this.#registry.successor(state); registrations.push(successor); nextCursor = successor.handle as NativeCosmosCursor;
    }
    return { value: { documents, metadata, pages, ...(nextCursor === undefined ? {} : { nextCursor }) }, registrations, ...(query.cursor === undefined ? {} : { consumed: query.cursor }) };
  }
}
