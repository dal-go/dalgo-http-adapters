import { describe, expect, it, vi } from "vitest";
import { TabBridge, type BridgeHost, type BridgePort } from "../../src/opfs/tab-bridge.js";
import { ChannelHub, settle } from "./helpers.js";
import { callOverPort, contractProtocol, serveOverPort, type ContractPort } from "./port-harness.js";

/** A leader host whose ports are served by the contract server; `log` records stops. */
function contractHost(log: string[] = []): BridgeHost & { readonly served: BridgePort[] } {
  const served: BridgePort[] = [];
  return {
    served,
    request: () => Promise.resolve(undefined),
    reset: () => Promise.resolve(undefined),
    port: (port) => {
      served.push(port);
      port.addEventListener("close", () => { log.push("served port closed"); });
      const stop = serveOverPort((payload) => (payload === "fail" ? Promise.reject(new TypeError("bad")) : Promise.resolve({ echo: payload })), port);
      return () => { log.push("stopped"); stop(); };
    },
  };
}

function twoTabs(): { readonly leader: TabBridge; readonly follower: TabBridge; readonly third: TabBridge } {
  const hub = new ChannelHub();
  return { leader: new TabBridge(hub.create(), "tab1"), follower: new TabBridge(hub.create(), "tab2"), third: new TabBridge(hub.create(), "tab3") };
}

describe("bridge ports and the FetchPort contract (message + close listeners)", () => {
  it("are assignable to the FetchPort shape", () => {
    const { follower } = twoTabs();
    const port: ContractPort = follower.connect(contractProtocol);
    expect(typeof port.addEventListener).toBe("function");
  });

  it("let a follower make many sequential calls over one port without disposing itself", async () => {
    const { leader, follower } = twoTabs();
    leader.becomeLeader(contractHost(), null);
    await follower.whenLeader();
    const client = callOverPort(follower.connect(contractProtocol));
    for (let index = 0; index < 25; index += 1) expect(await client.call(index)).toEqual({ echo: index });
    await expect(client.call("fail")).rejects.toMatchObject({ name: "TypeError", message: "bad" });
    expect(await client.call("after a failure")).toEqual({ echo: "after a failure" });
    expect(client.disposed).toBe(false);
  });

  it("let the leader's own tab make many sequential calls too", async () => {
    const { leader } = twoTabs();
    leader.becomeLeader(contractHost(), null);
    const client = callOverPort(leader.connect(contractProtocol));
    for (let index = 0; index < 10; index += 1) expect(await client.call(index)).toEqual({ echo: index });
    expect(client.disposed).toBe(false);
  });

  it("dispatch close once when a port is closed, on both sides", async () => {
    const log: string[] = [];
    const { leader, follower } = twoTabs();
    leader.becomeLeader(contractHost(log), null);
    await follower.whenLeader();
    const port = follower.connect(contractProtocol);
    const closes = vi.fn();
    port.addEventListener("close", closes);
    const client = callOverPort(port);
    expect(await client.call("one")).toEqual({ echo: "one" });
    const hanging = client.call("never answered");
    port.close();
    port.close();
    await expect(hanging).rejects.toThrow("the port is closed");
    expect(client.disposed).toBe(true);
    expect(closes).toHaveBeenCalledTimes(1);
    expect(closes.mock.calls[0]?.[0]).toBeInstanceOf(Event);
    await settle();
    expect(log).toEqual(["stopped", "served port closed"]);
  });

  it("close every port when the bridge closes (the session closed or failed)", async () => {
    const { leader, follower } = twoTabs();
    leader.becomeLeader(contractHost(), null);
    await follower.whenLeader();
    const clients = [callOverPort(follower.connect(contractProtocol)), callOverPort(follower.connect())];
    const pending = clients[0]?.call("in flight");
    follower.close();
    // Leaving answers the in-flight call with the protocol's failure first.
    await expect(pending).rejects.toMatchObject({ name: "LeaderChangedError" });
    expect(clients.map((client) => client.disposed)).toEqual([true, true]);
  });

  it("close served ports when their tab leaves or the leader steps down", async () => {
    const log: string[] = [];
    const { leader, follower, third } = twoTabs();
    const host = contractHost(log);
    leader.becomeLeader(host, null);
    await follower.whenLeader();
    await third.whenLeader();
    await callOverPort(follower.connect(contractProtocol)).call(1);
    await callOverPort(third.connect(contractProtocol)).call(2);
    follower.leave();
    await settle();
    expect(log).toEqual(["stopped", "served port closed"]);
    leader.stepDown();
    expect(log).toEqual(["stopped", "served port closed", "stopped", "served port closed"]);
    expect(host.served.every((port) => (port as BridgePort & { readonly closed: boolean }).closed)).toBe(true);
  });

  it("keep a tab's port open across a leader change: in-flight calls fail, later calls reach the new leader", async () => {
    const hub = new ChannelHub();
    const first = new TabBridge(hub.create(), "tab1");
    const second = new TabBridge(hub.create(), "tab2");
    const follower = new TabBridge(hub.create(), "tab3");
    first.becomeLeader({ ...contractHost(), port: () => undefined }, "first");
    await follower.whenLeader();
    const port = follower.connect(contractProtocol);
    const closes = vi.fn();
    port.addEventListener("close", closes);
    const client = callOverPort(port);
    const lost = client.call("lost");
    await settle();
    second.becomeLeader(contractHost(), "second");
    await expect(lost).rejects.toMatchObject({ name: "LeaderChangedError" });
    expect(await client.call("to the new leader")).toEqual({ echo: "to the new leader" });
    expect(closes).not.toHaveBeenCalled();
    expect(client.disposed).toBe(false);
  });

  it("close a port opened after the bridge closed, after listeners could be added", async () => {
    const { follower } = twoTabs();
    follower.close();
    const port = follower.connect(contractProtocol);
    const client = callOverPort(port);
    expect(client.disposed).toBe(false);
    await Promise.resolve();
    expect(client.disposed).toBe(true);
    await expect(client.call("x")).rejects.toThrow("the port is closed");
  });

  it("keep listeners per type with EventTarget options", async () => {
    const { leader } = twoTabs();
    leader.becomeLeader(contractHost(), null);
    const port = leader.connect(contractProtocol);
    const once = vi.fn();
    const aborted = vi.fn();
    const removed = vi.fn();
    const messageError = vi.fn();
    const controller = new AbortController();
    port.addEventListener("message", once, { once: true });
    port.addEventListener("message", aborted, { signal: controller.signal });
    port.addEventListener("message", removed);
    port.removeEventListener("close", removed);
    port.removeEventListener("message", removed);
    port.addEventListener("messageerror", messageError);
    controller.abort();
    const client = callOverPort(port);
    await client.call(1);
    await client.call(2);
    expect(once).toHaveBeenCalledTimes(1);
    expect(aborted).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    port.close();
    expect(messageError).not.toHaveBeenCalled();
    port.removeEventListener("messageerror", messageError);
  });

  it("stop dispatching messages on a served port its handler closed", async () => {
    const { leader, follower } = twoTabs();
    const received = vi.fn();
    leader.becomeLeader({
      ...contractHost(),
      port: (port) => {
        port.addEventListener("message", received);
        port.addEventListener("message", () => { port.close(); }, { once: true });
        return undefined;
      },
    }, null);
    await follower.whenLeader();
    const port = follower.connect();
    port.postMessage("first");
    await settle();
    port.postMessage("second");
    await settle();
    expect(received).toHaveBeenCalledTimes(1);
  });
});
