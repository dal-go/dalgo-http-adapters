import { describe, expect, it, vi } from "vitest";
import { LeaderChangedError, RemoteRequestError, TabBridge, type BridgeHost, type BridgePort, type PortProtocol } from "../../src/opfs/tab-bridge.js";
import { ChannelHub, settle } from "./helpers.js";

/** Answers `{ id, payload }` port messages with `{ id, echo }`, like serveFetchOverPort. */
function echoHost(log: string[] = []): BridgeHost & { readonly ports: BridgePort[] } {
  const ports: BridgePort[] = [];
  return {
    ports,
    request: (payload) => {
      if (payload === "fail") return Promise.reject(new TypeError("bad payload"));
      if (payload === "retry") return Promise.reject(Object.assign(new Error("busy"), { name: "WorkerUnavailableError", retriable: true }));
      if (payload === "leader-changed") return Promise.reject(new LeaderChangedError("moved"));
      if (payload === "string") return Promise.reject(new Error("text"));
      return Promise.resolve({ answer: payload });
    },
    reset: () => Promise.resolve("reset done"),
    port: (port) => {
      ports.push(port);
      const listener = (event: MessageEvent): void => {
        const message = event.data as { readonly id: number; readonly payload: unknown } | string;
        if (typeof message === "string" || message.payload === "silent") return;
        port.postMessage({ id: message.id, echo: message.payload });
      };
      port.addEventListener("message", listener);
      port.start();
      return () => { log.push("stopped"); port.removeEventListener("message", listener); };
    },
  };
}

const protocol: PortProtocol = {
  requestId: (message) => (message as { readonly id?: number }).id,
  responseId: (message) => (message as { readonly id?: number }).id,
  failure: (request, error) => ({ id: (request as { readonly id: number }).id, failed: error.name }),
};

function receive(port: BridgePort): { readonly messages: unknown[] } {
  const messages: unknown[] = [];
  port.addEventListener("message", (event) => { messages.push(event.data); });
  return { messages };
}

/** Three tabs of one origin (a tab a test does not use never posts). */
function tabs(): { readonly hub: ChannelHub; readonly bridges: readonly [TabBridge, TabBridge, TabBridge] } {
  const hub = new ChannelHub();
  const tab = (index: number): TabBridge => new TabBridge(hub.create(), `tab${String(index)}`);
  return { hub, bridges: [tab(1), tab(2), tab(3)] };
}

describe("TabBridge requests", () => {
  it("queues requests until a leader is known, then answers them", async () => {
    const { bridges: [leader, follower] } = tabs();
    const changes: unknown[] = [];
    follower.onLeaderChange = (info) => { changes.push(info); };
    const queued = follower.request("early");
    const known = follower.whenLeader();
    leader.becomeLeader(echoHost(), { version: 1 });
    expect(await queued).toEqual({ answer: "early" });
    expect(await known).toEqual({ id: "tab1", info: { version: 1 } });
    expect(await follower.whenLeader()).toEqual({ id: "tab1", info: { version: 1 } });
    expect(follower.leader).toEqual({ id: "tab1", info: { version: 1 }, local: false });
    expect(leader.leader).toEqual({ id: "tab1", info: { version: 1 }, local: true });
    expect(changes).toEqual([{ id: "tab1", info: { version: 1 }, local: false }]);
    expect(await follower.reset()).toBe("reset done");
    expect(await leader.request("local")).toEqual({ answer: "local" });
    expect(await leader.reset()).toBe("reset done");
  });

  it("carries failures with their name and retriability", async () => {
    const { bridges: [leader, follower] } = tabs();
    leader.becomeLeader(echoHost(), null);
    await follower.whenLeader().catch(() => undefined);
    follower.hello();
    await settle();
    const bad = await follower.request("fail").catch((error: unknown) => error);
    expect(bad).toBeInstanceOf(RemoteRequestError);
    expect(bad).toMatchObject({ name: "TypeError", message: "bad payload", retriable: false });
    await expect(follower.request("retry")).rejects.toMatchObject({ name: "WorkerUnavailableError", retriable: true });
    await expect(follower.request("leader-changed")).rejects.toBeInstanceOf(LeaderChangedError);
    await expect(follower.request("string")).rejects.toMatchObject({ message: "text" });
  });

  it("answers a non-Error rejection as an Error", async () => {
    const { bridges: [leader, follower] } = tabs();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a host may reject with anything
    leader.becomeLeader({ ...echoHost(), request: () => Promise.reject("plain") }, null);
    await follower.whenLeader();
    await expect(follower.request("x")).rejects.toMatchObject({ name: "Error", message: "plain" });
  });

  it("fails requests sent to a leader that steps down, and sends new ones to the next leader", async () => {
    const { hub, bridges: [first, second, follower] } = tabs();
    first.becomeLeader(echoHost(), "first");
    await follower.whenLeader();
    const inFlight = follower.request("lost");
    first.stepDown();
    await expect(inFlight).rejects.toBeInstanceOf(LeaderChangedError);
    expect(follower.leader).toBeUndefined();
    const waiting = follower.request("next");
    second.becomeLeader(echoHost(), "second");
    expect(await waiting).toEqual({ answer: "next" });
    expect(hub.log.filter((message) => (message as { k: string }).k === "bye")).toHaveLength(1);
  });

  it("fails requests to the previous leader when another tab announces itself", async () => {
    const { bridges: [first, second, follower] } = tabs();
    first.becomeLeader({ ...echoHost(), request: () => new Promise(() => undefined) }, "first");
    await follower.whenLeader();
    const inFlight = follower.request("hangs");
    await settle();
    second.becomeLeader(echoHost(), "second");
    await expect(inFlight).rejects.toBeInstanceOf(LeaderChangedError);
    expect(follower.leader?.id).toBe("tab2");
  });

  it("fails a follower's requests when the follower itself becomes the leader", async () => {
    const { bridges: [first, follower] } = tabs();
    first.becomeLeader({ ...echoHost(), request: () => new Promise(() => undefined) }, "first");
    await follower.whenLeader();
    const inFlight = follower.request("hangs");
    follower.becomeLeader(echoHost(), "follower");
    await expect(inFlight).rejects.toBeInstanceOf(LeaderChangedError);
    expect(await follower.request("local")).toEqual({ answer: "local" });
  });

  it("answers a request that reaches a tab that no longer leads with LeaderChangedError", async () => {
    const { hub, bridges: [leader, follower] } = tabs();
    leader.becomeLeader(echoHost(), null);
    await follower.whenLeader();
    void follower.request("late").catch(() => undefined);
    leader.stepDown();
    await settle();
    const answer = hub.log.find((message) => (message as { k: string }).k === "res");
    expect(answer).toMatchObject({ ok: false, error: { name: "LeaderChangedError", retriable: true } });
  });

  it("ignores foreign messages, its own echoes and traffic for other tabs", async () => {
    const hub = new ChannelHub();
    const channel = hub.create();
    const leader = new TabBridge(channel, "tab1");
    const host = echoHost();
    leader.becomeLeader(host, null);
    for (const data of [
      null, "text", { ns: "other" },
      { ns: "demodb-bridge/1", from: "tab1", k: "hello" },
      { ns: "demodb-bridge/1", from: "x", k: "req", to: "other", id: 1, op: "request" },
      { ns: "demodb-bridge/1", from: "x", k: "res", to: "other", id: 1, ok: true },
      { ns: "demodb-bridge/1", from: "x", k: "res", to: "tab1", id: 99, ok: true },
      { ns: "demodb-bridge/1", from: "x", k: "port", to: "other", port: 1, data: 1 },
      { ns: "demodb-bridge/1", from: "x", k: "port-close", to: "other", port: 1 },
      { ns: "demodb-bridge/1", from: "x", k: "leader", info: null },
    ]) channel.deliver(data);
    await settle();
    expect(leader.leader?.id).toBe("tab1");
    expect(host.ports).toHaveLength(0);
  });

  it("ignores hello when it does not lead, and stops after close", async () => {
    const { hub, bridges: [first, second] } = tabs();
    first.hello();
    await settle();
    expect(hub.log).toHaveLength(1);
    const queued = second.request("never");
    second.close();
    second.close();
    await expect(queued).rejects.toThrow("closed");
    await expect(second.request("after")).rejects.toBeInstanceOf(LeaderChangedError);
    second.hello();
    expect(hub.log.at(-1)).toMatchObject({ k: "bye", from: "tab2" });
  });

  it("tells the leader when a follower leaves, and leaders say goodbye once", async () => {
    const { hub, bridges: [leader, follower] } = tabs();
    leader.becomeLeader(echoHost(), null);
    await follower.whenLeader();
    follower.leave();
    expect(follower.leader).toBeUndefined();
    leader.leave();
    leader.leave();
    const byes = hub.log.filter((message) => (message as { k: string }).k === "bye").map((message) => (message as { from: string }).from);
    expect(byes).toEqual(["tab2", "tab1", "tab1"]);
  });
});

describe("TabBridge ports", () => {
  it("connects a follower's port to the leader's port handler", async () => {
    const log: string[] = [];
    const { bridges: [leader, follower] } = tabs();
    const host = echoHost(log);
    const port = follower.connect(protocol);
    const { messages } = receive(port);
    port.start();
    port.postMessage({ id: 1, payload: "queued" });
    leader.becomeLeader(host, null);
    await settle();
    port.postMessage({ id: 2, payload: "direct" }, []);
    await settle();
    expect(messages).toEqual([{ id: 1, echo: "queued" }, { id: 2, echo: "direct" }]);
    expect(host.ports).toHaveLength(1);
    port.close();
    port.close();
    port.postMessage({ id: 3, payload: "after close" });
    await settle();
    expect(log).toEqual(["stopped"]);
    expect(messages).toHaveLength(2);
  });

  it("connects the leader's own port without the channel", async () => {
    const log: string[] = [];
    const { hub, bridges: [leader] } = tabs();
    leader.becomeLeader(echoHost(log), null);
    const port = leader.connect(protocol);
    const listener = vi.fn();
    port.addEventListener("message", listener);
    const { messages } = receive(port);
    port.removeEventListener("message", listener);
    port.postMessage({ id: 7, payload: "local" });
    await settle();
    expect(messages).toEqual([{ id: 7, echo: "local" }]);
    expect(listener).not.toHaveBeenCalled();
    port.close();
    expect(log).toEqual(["stopped"]);
    expect(hub.log.filter((message) => (message as { k: string }).k === "port")).toHaveLength(0);
  });

  it("answers in-flight port requests with the protocol's failure when the leader changes", async () => {
    const { bridges: [first, second, follower] } = tabs();
    first.becomeLeader(echoHost(), null);
    await follower.whenLeader();
    const port = follower.connect(protocol);
    const plain = follower.connect();
    const { messages } = receive(port);
    const plainMessages = receive(plain).messages;
    port.postMessage({ id: 1, payload: "silent" });
    port.postMessage("no id");
    plain.postMessage({ id: 1, payload: "silent" });
    await settle();
    second.becomeLeader(echoHost(), null);
    await settle();
    expect(messages).toEqual([{ id: 1, failed: "LeaderChangedError" }]);
    expect(plainMessages).toEqual([]);
    port.postMessage({ id: 2, payload: "to the new leader" });
    await settle();
    expect(messages.at(-1)).toEqual({ id: 2, echo: "to the new leader" });
  });

  it("stops serving a follower's ports when it leaves or the leader steps down", async () => {
    const log: string[] = [];
    const { bridges: [leader, follower, other] } = tabs();
    leader.becomeLeader({ ...echoHost(log), port: (port) => { echoHost(log).port(port); return undefined; } }, null);
    await follower.whenLeader();
    await other.whenLeader();
    follower.connect().postMessage({ id: 1, payload: "a" });
    other.connect().postMessage({ id: 1, payload: "b" });
    await settle();
    follower.leave();
    await settle();
    leader.stepDown();
    expect(log).toEqual([]);
  });

  it("drops port traffic that arrives after the roles changed", async () => {
    const { bridges: [leader, follower, stranger] } = tabs();
    const host = echoHost();
    leader.becomeLeader(host, null);
    await follower.whenLeader();
    const port = follower.connect(protocol);
    const { messages } = receive(port);
    port.postMessage({ id: 1, payload: "x" });
    await settle();
    // A served port answering after its follower's endpoint closed, or for an unknown endpoint.
    port.close();
    host.ports[0]?.postMessage({ id: 9, echo: "late" });
    await settle();
    expect(messages).toEqual([{ id: 1, echo: "x" }]);
    // Port traffic from a tab that is not the leader is ignored by followers.
    stranger.connect().postMessage({ id: 1, payload: "stranger" });
    await settle();
    const local = leader.connect(protocol);
    local.postMessage({ id: 5, payload: "silent" });
    leader.stepDown();
    await settle();
    expect(receive(local).messages).toEqual([]);
  });

  it("drops a local reply for an endpoint that closed", async () => {
    const { bridges: [leader] } = tabs();
    const host = echoHost();
    leader.becomeLeader(host, null);
    const port = leader.connect(protocol);
    const { messages } = receive(port);
    port.postMessage({ id: 1, payload: "x" });
    await settle();
    port.close();
    host.ports[0]?.postMessage({ id: 2, echo: "late" });
    await settle();
    expect(messages).toEqual([{ id: 1, echo: "x" }]);
  });

  it("does not tell anyone about closing a port that never reached a leader", () => {
    const { hub, bridges: [tab] } = tabs();
    tab.connect().close();
    expect(hub.log).toEqual([]);
  });
});

describe("TabBridge edge cases", () => {
  it("lets a port handler close its own port", async () => {
    const { bridges: [leader, follower] } = tabs();
    let closes = 0;
    leader.becomeLeader({
      ...echoHost(),
      port: (port) => () => {
        closes += 1;
        port.close();
      },
    }, null);
    await follower.whenLeader();
    const port = follower.connect();
    follower.connect().postMessage("first endpoint");
    port.postMessage("second endpoint");
    await settle();
    port.close();
    await settle();
    expect(closes).toBe(1);
  });

  it("keeps in-flight requests when the same leader announces itself again", async () => {
    const { bridges: [leader, follower] } = tabs();
    let answer: ((value: unknown) => void) | undefined;
    leader.becomeLeader({ ...echoHost(), request: () => new Promise((resolve) => { answer = resolve; }) }, null);
    await follower.whenLeader();
    const inFlight = follower.request("slow");
    follower.hello();
    await settle();
    answer?.("done");
    expect(await inFlight).toBe("done");
  });

  it("ignores port messages from tabs that do not lead", async () => {
    const hub = new ChannelHub();
    const channel = hub.create();
    const follower = new TabBridge(channel, "tab2");
    const port = follower.connect();
    const { messages } = receive(port);
    const stray = { ns: "demodb-bridge/1", from: "x", k: "port", to: "tab2", port: 1, data: "stray" };
    channel.deliver(stray);
    new TabBridge(hub.create(), "tab1").becomeLeader(echoHost(), null);
    await follower.whenLeader();
    channel.deliver(stray);
    channel.deliver({ ...stray, from: "tab1", port: 42 });
    await settle();
    expect(messages).toEqual([]);
  });
});
