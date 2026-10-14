import { reviveError, serializeError, type SerializedError } from "./protocol.js";

/** The part of `BroadcastChannel` the bridge uses. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
}

/** The leader changed while a request was in flight. Retry it: the next leader holds every committed write. */
export class LeaderChangedError extends Error {
  public readonly code = "leader_changed" as const;
  public readonly retriable = true as const;

  public constructor(message = "the dataset leader tab changed while the request was in flight; retry it") {
    super(message);
    this.name = "LeaderChangedError";
  }
}

/** A request failed in the leader; carries the leader's error name and message. */
export class RemoteRequestError extends Error {
  public readonly retriable: boolean;

  public constructor(name: string, message: string, retriable: boolean) {
    super(message);
    this.name = name;
    this.retriable = retriable;
  }
}

/**
 * Lets a bridge port fail in-flight requests when the leader changes. A
 * request message has an id (`requestId`), its answer carries the same id
 * (`responseId`), and `failure` builds the answer that reports the error.
 */
export interface PortProtocol {
  requestId(message: unknown): unknown;
  responseId(message: unknown): unknown;
  failure(request: unknown, error: LeaderChangedError): unknown;
}

/** The events a {@link BridgePort} dispatches, by type. */
export interface BridgePortEventMap {
  /** A message from the other side. */
  readonly message: MessageEvent;
  /** Never dispatched (data is copied, not deserialized); accepted so `MessagePort` code can listen for it. */
  readonly messageerror: MessageEvent;
  /** The port closed: see {@link BridgePort}. Dispatched once. */
  readonly close: Event;
}

/**
 * A `MessagePort`-shaped endpoint (the `FetchPort` contract of
 * `@openvaultdb/inprocess`): messages posted on a tab's port reach the port
 * the leader serves for it, wherever the leader runs, and its answers come
 * back as `message` events. Transfer lists are ignored: data is copied.
 *
 * Listeners are kept per event type, as on an `EventTarget` (options such as
 * `once` and `signal` work). `close` is dispatched once, when:
 *
 * - a tab's port: `close()` is called on it, or its session closes or fails
 *   (`TabBridge.close()`). A leader change does not close it: requests in
 *   flight to the previous leader are answered with the protocol's
 *   `failure` (see {@link PortProtocol}) and later messages go to the new
 *   leader.
 * - a served port (in the leader): the tab's port closed, that tab left, or
 *   this tab stopped leading.
 *
 * After `close` no `message` event is dispatched and `postMessage` does nothing.
 */
export interface BridgePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener<K extends keyof BridgePortEventMap>(type: K, listener: (event: BridgePortEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof BridgePortEventMap>(type: K, listener: (event: BridgePortEventMap[K]) => void, options?: boolean | EventListenerOptions): void;
  start(): void;
  close(): void;
}

/** What the leader tab serves to every tab, itself included. */
export interface BridgeHost {
  /** Answers a generic request. */
  request(payload: unknown): Promise<unknown>;
  /** Resets the dataset. */
  reset(): Promise<unknown>;
  /** Serves one connected port; returns a function that stops serving. */
  port(port: BridgePort): (() => void) | undefined;
}

const ns = "demodb-bridge/1";

/** The dataset errors a follower gets back as their own class; anything else is a {@link RemoteRequestError}. */
const typedRemoteErrors = new Set(["CanonicalFetchError", "CanonicalIntegrityError", "CorruptDatabaseError", "DatasetStorageError", "PoolUnavailableError", "DemoDbConfigError"]);

function remoteError(error: SerializedError): Error {
  if (error.name === "LeaderChangedError") return new LeaderChangedError(error.message);
  if (typedRemoteErrors.has(error.name)) return reviveError(error);
  const remote = new RemoteRequestError(error.name, error.message, error.retriable === true);
  const fields = remote as unknown as Record<string, unknown>;
  if (error.code !== undefined) fields.code = error.code;
  if (error.reason !== undefined) fields.reason = error.reason;
  if (error.operation !== undefined) fields.operation = error.operation;
  if (error.status !== undefined) fields.status = error.status;
  if (error.resultCode !== undefined) fields.resultCode = error.resultCode;
  return remote;
}

type Envelope = { readonly ns: typeof ns; readonly from: string } & (
  | { readonly k: "hello" }
  | { readonly k: "leader"; readonly info: unknown }
  | { readonly k: "bye" }
  | { readonly k: "req"; readonly to: string; readonly id: number; readonly op: "request" | "reset"; readonly payload?: unknown }
  | ({ readonly k: "res"; readonly to: string; readonly id: number } & ({ readonly ok: true; readonly payload: unknown } | { readonly ok: false; readonly error: SerializedError }))
  | { readonly k: "port"; readonly to: string; readonly port: number; readonly data: unknown }
  | { readonly k: "port-close"; readonly to: string; readonly port: number }
);

type Outgoing = Envelope extends infer E ? E extends unknown ? Omit<E, "ns" | "from"> : never : never;

function isEnvelope(data: unknown): data is Envelope {
  return typeof data === "object" && data !== null && (data as { ns?: unknown }).ns === ns;
}

/** Event listeners per type, and the one-time `close`. */
abstract class PortEvents {
  readonly #target = new EventTarget();
  public closed = false;

  public addEventListener<K extends keyof BridgePortEventMap>(type: K, listener: (event: BridgePortEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void {
    this.#target.addEventListener(type, listener as EventListener, options);
  }

  public removeEventListener<K extends keyof BridgePortEventMap>(type: K, listener: (event: BridgePortEventMap[K]) => void, options?: boolean | EventListenerOptions): void {
    this.#target.removeEventListener(type, listener as EventListener, options);
  }

  public start(): void { /* messages flow from the first postMessage */ }

  protected dispatchMessage(data: unknown): void {
    if (!this.closed) this.#target.dispatchEvent(new MessageEvent("message", { data }));
  }

  /** Marks the port closed; true the first time. */
  protected markClosed(): boolean {
    if (this.closed) return false;
    this.closed = true;
    return true;
  }

  protected dispatchClose(): void { this.#target.dispatchEvent(new Event("close")); }
}

interface Pending {
  readonly op: "request" | "reset";
  readonly payload: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  /** The leader it was sent to; undefined while queued. */
  sentTo: string | undefined;
}

class Endpoint extends PortEvents implements BridgePort {
  readonly #bridge: TabBridge;
  public readonly id: number;
  readonly #protocol: PortProtocol | undefined;
  /** Requests sent to a leader and not answered yet, by request id. */
  readonly inFlight = new Map<unknown, unknown>();
  /** Messages posted while no leader was known. */
  readonly queued: unknown[] = [];

  public constructor(bridge: TabBridge, id: number, protocol: PortProtocol | undefined) {
    super();
    this.#bridge = bridge;
    this.id = id;
    this.#protocol = protocol;
  }

  public postMessage(message: unknown): void {
    if (this.closed) return;
    this.#bridge.sendPort(this, message);
  }

  public track(message: unknown): void {
    const id = this.#protocol?.requestId(message);
    if (id !== undefined) this.inFlight.set(id, message);
  }

  public deliver(data: unknown): void {
    const id = this.#protocol?.responseId(data);
    if (id !== undefined) this.inFlight.delete(id);
    this.dispatchMessage(data);
  }

  /** Answers every in-flight request with the protocol's failure message. */
  public failInFlight(): void {
    const protocol = this.#protocol;
    if (protocol === undefined) return;
    const requests = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const request of requests) this.deliver(protocol.failure(request, new LeaderChangedError()));
  }

  public close(): void {
    if (!this.markClosed()) return;
    this.#bridge.closePort(this);
    this.dispatchClose();
  }
}

class ServedPort extends PortEvents implements BridgePort {
  readonly #send: (data: unknown) => void;
  public stop: (() => void) | undefined;

  public constructor(send: (data: unknown) => void) {
    super();
    this.#send = send;
  }

  public postMessage(message: unknown): void { if (!this.closed) this.#send(message); }

  public receive(data: unknown): void { this.dispatchMessage(data); }

  public close(): void {
    if (!this.markClosed()) return;
    this.stop?.();
    this.dispatchClose();
  }
}

/**
 * Carries requests from every tab to the dataset's leader tab over a
 * `BroadcastChannel`. The leader answers its own tab directly. When the
 * leader changes, requests sent to the previous one fail with
 * {@link LeaderChangedError}; requests made while no leader is known wait
 * for the next one.
 */
export class TabBridge {
  readonly #channel: BroadcastChannelLike;
  public readonly tabId: string;
  #host: BridgeHost | undefined;
  #leader: { readonly id: string; readonly info: unknown } | undefined;
  #nextId = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #endpoints = new Set<Endpoint>();
  #nextPort = 0;
  readonly #served = new Map<string, ServedPort>();
  #leaderWaiters: ((leader: { readonly id: string; readonly info: unknown }) => void)[] = [];
  #closed = false;
  /** Called when the known leader changes (undefined: none known). */
  public onLeaderChange: ((leader: { readonly id: string; readonly info: unknown; readonly local: boolean } | undefined) => void) | undefined;
  readonly #listener = (event: MessageEvent): void => { this.#receive(event.data); };

  public constructor(channel: BroadcastChannelLike, tabId: string) {
    this.#channel = channel;
    this.tabId = tabId;
    channel.addEventListener("message", this.#listener);
  }

  /** The known leader and the info it announced; `local` when it is this tab. */
  public get leader(): { readonly id: string; readonly info: unknown; readonly local: boolean } | undefined {
    return this.#leader === undefined ? undefined : { ...this.#leader, local: this.#leader.id === this.tabId };
  }

  #post(message: Outgoing): void {
    if (this.#closed) return;
    this.#channel.postMessage({ ...message, ns, from: this.tabId });
  }

  /** Asks the current leader to announce itself. */
  public hello(): void { this.#post({ k: "hello" }); }

  /** Resolves once a leader is known. */
  public whenLeader(): Promise<{ readonly id: string; readonly info: unknown }> {
    if (this.#leader !== undefined) return Promise.resolve(this.#leader);
    return new Promise((resolve) => { this.#leaderWaiters.push(resolve); });
  }

  /** This tab now leads: it serves `host` and announces `info` to the other tabs. */
  public becomeLeader(host: BridgeHost, info: unknown): void {
    this.#host = host;
    this.#setLeader({ id: this.tabId, info });
    this.#post({ k: "leader", info });
  }

  /** This tab stops leading (or leaves): followers are told, served ports stop. */
  public stepDown(): void {
    const wasLeader = this.#host !== undefined;
    this.#host = undefined;
    for (const served of this.#served.values()) served.close();
    this.#served.clear();
    if (wasLeader) this.#post({ k: "bye" });
    if (this.#leader?.id === this.tabId) this.#setLeader(undefined);
  }

  /**
   * Stops taking part until the next `hello()` or leader announcement (for
   * example while the page sits in the back/forward cache): steps down, tells
   * the leader this tab left, and fails requests sent to it. Requests made
   * meanwhile wait for a leader.
   */
  public leave(): void {
    const leading = this.#host !== undefined;
    this.stepDown();
    if (!leading) this.#post({ k: "bye" });
    if (this.#leader !== undefined) this.#setLeader(undefined);
  }

  /** Leaves for good: also rejects waiting requests, closes every port (they dispatch `close`) and the channel. */
  public close(): void {
    if (this.#closed) return;
    this.leave();
    this.#closed = true;
    this.#channel.removeEventListener("message", this.#listener);
    this.#channel.close();
    for (const pending of this.#pending.values()) pending.reject(new LeaderChangedError("the dataset session was closed"));
    this.#pending.clear();
    for (const endpoint of [...this.#endpoints]) endpoint.close();
  }

  /** Sends a generic request to the leader's host and resolves with its answer. */
  public request(payload: unknown): Promise<unknown> { return this.#call("request", payload); }

  /** Asks the leader to reset the dataset. */
  public reset(): Promise<unknown> { return this.#call("reset", undefined); }

  #call(op: "request" | "reset", payload: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new LeaderChangedError("the dataset session was closed"));
    this.#nextId += 1;
    const id = this.#nextId;
    return new Promise((resolve, reject) => {
      const pending: Pending = { op, payload, resolve, reject, sentTo: undefined };
      this.#pending.set(id, pending);
      if (this.#leader !== undefined) this.#dispatch(id, pending);
    });
  }

  #dispatch(id: number, pending: Pending): void {
    const leader = this.#leader as { readonly id: string };
    pending.sentTo = leader.id;
    if (leader.id !== this.tabId) {
      this.#post({ k: "req", to: leader.id, id, op: pending.op, payload: pending.payload });
      return;
    }
    this.#pending.delete(id);
    this.#serve(pending.op, pending.payload).then(pending.resolve, pending.reject);
  }

  #serve(op: "request" | "reset", payload: unknown): Promise<unknown> {
    const host = this.#host;
    if (host === undefined) return Promise.reject(new LeaderChangedError());
    return op === "reset" ? host.reset() : host.request(payload);
  }

  /** Opens a port to the leader's `host.port`, see {@link BridgePort}. After `close()` the port closes right away (in a microtask, so listeners added now see `close`). */
  public connect(protocol?: PortProtocol): BridgePort {
    this.#nextPort += 1;
    const endpoint = new Endpoint(this, this.#nextPort, protocol);
    if (this.#closed) queueMicrotask(() => { endpoint.close(); });
    else this.#endpoints.add(endpoint);
    return endpoint;
  }

  /** @internal */
  public sendPort(endpoint: Endpoint, data: unknown): void {
    const leader = this.#leader;
    if (leader === undefined) {
      endpoint.queued.push(data);
      return;
    }
    endpoint.track(data);
    if (leader.id === this.tabId) {
      queueMicrotask(() => { this.#servedPort(this.tabId, endpoint.id)?.receive(data); });
      return;
    }
    this.#post({ k: "port", to: leader.id, port: endpoint.id, data });
  }

  /** @internal */
  public closePort(endpoint: Endpoint): void {
    this.#endpoints.delete(endpoint);
    const leader = this.#leader;
    if (leader === undefined) return;
    if (leader.id === this.tabId) this.#closeServed(`${this.tabId}:${String(endpoint.id)}`);
    else this.#post({ k: "port-close", to: leader.id, port: endpoint.id });
  }

  #servedPort(tab: string, port: number): ServedPort | undefined {
    const host = this.#host;
    if (host === undefined) return undefined;
    const key = `${tab}:${String(port)}`;
    let served = this.#served.get(key);
    if (served === undefined) {
      served = new ServedPort((data) => {
        if (tab !== this.tabId) {
          this.#post({ k: "port", to: tab, port, data });
          return;
        }
        queueMicrotask(() => { this.#endpointById(port)?.deliver(data); });
      });
      this.#served.set(key, served);
      served.stop = host.port(served);
    }
    return served;
  }

  #endpointById(id: number): Endpoint | undefined {
    for (const endpoint of this.#endpoints) if (endpoint.id === id) return endpoint;
    return undefined;
  }

  #closeServed(key: string): void {
    this.#served.get(key)?.close();
    this.#served.delete(key);
  }

  #setLeader(leader: { readonly id: string; readonly info: unknown } | undefined): void {
    const previous = this.#leader;
    this.#leader = leader;
    if (previous?.id !== leader?.id) {
      // Requests sent to the previous leader can no longer be answered.
      for (const [id, pending] of this.#pending) {
        if (pending.sentTo === undefined) continue;
        this.#pending.delete(id);
        pending.reject(new LeaderChangedError());
      }
      for (const endpoint of this.#endpoints) endpoint.failInFlight();
    }
    if (leader !== undefined) {
      for (const [id, pending] of this.#pending) if (pending.sentTo === undefined) this.#dispatch(id, pending);
      for (const endpoint of this.#endpoints) for (const data of endpoint.queued.splice(0)) this.sendPort(endpoint, data);
      const waiters = this.#leaderWaiters;
      this.#leaderWaiters = [];
      for (const resolve of waiters) resolve(leader);
    }
    this.onLeaderChange?.(this.leader);
  }

  #receive(data: unknown): void {
    if (!isEnvelope(data) || data.from === this.tabId) return;
    switch (data.k) {
      case "hello":
        if (this.#host !== undefined && this.#leader !== undefined) this.#post({ k: "leader", info: this.#leader.info });
        return;
      case "leader":
        if (this.#host !== undefined) return; // this tab holds the lock; a stale announcement
        this.#setLeader({ id: data.from, info: data.info });
        return;
      case "bye":
        if (this.#leader?.id === data.from) this.#setLeader(undefined);
        for (const key of [...this.#served.keys()]) if (key.startsWith(`${data.from}:`)) this.#closeServed(key);
        return;
      case "req":
        if (data.to === this.tabId) this.#answer(data.from, data.id, data.op, data.payload);
        return;
      case "res":
        if (data.to === this.tabId) this.#settle(data);
        return;
      case "port":
        if (data.to !== this.tabId) return;
        if (this.#host !== undefined) this.#servedPort(data.from, data.port)?.receive(data.data);
        else if (this.#leader?.id === data.from) this.#endpointById(data.port)?.deliver(data.data);
        return;
      case "port-close":
        if (data.to === this.tabId) this.#closeServed(`${data.from}:${String(data.port)}`);
        return;
    }
  }

  #answer(from: string, id: number, op: "request" | "reset", payload: unknown): void {
    this.#serve(op, payload).then(
      (result) => { this.#post({ k: "res", to: from, id, ok: true, payload: result }); },
      (error: unknown) => { this.#post({ k: "res", to: from, id, ok: false, error: serializeError(error) }); },
    );
  }

  #settle(response: Extract<Envelope, { readonly k: "res" }>): void {
    const pending = this.#pending.get(response.id);
    if (pending?.sentTo !== response.from) return;
    this.#pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.payload);
      return;
    }
    pending.reject(remoteError(response.error));
  }
}
