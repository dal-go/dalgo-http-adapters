import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { CloudflareKvError } from "./types.js";

/** Own standard Node agents: no environment proxy/global fetch dispatcher. */
export function ownedFetch(maxConcurrent: number): { fetch: typeof fetch; close: () => void } {
  const httpsAgent = new HttpsAgent({ keepAlive: false, maxSockets: maxConcurrent, maxTotalSockets: maxConcurrent, rejectUnauthorized: true, minVersion: "TLSv1.2" });
  const httpAgent = new HttpAgent({ keepAlive: false, maxSockets: maxConcurrent, maxTotalSockets: maxConcurrent });
  const fetcher: typeof fetch = (input, init) => new Promise<Response>((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = call(url, { method: "GET", headers, agent: url.protocol === "https:" ? httpsAgent : httpAgent, maxHeaderSize: 65_536, ...(init?.signal === null || init?.signal === undefined ? {} : { signal: init.signal }) }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) { for (const item of value) responseHeaders.append(name, item); }
        else responseHeaders.set(name, value);
      }
      const status = incoming.statusCode ?? 502;
      const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      try { resolve(new Response(body, { status, headers: responseHeaders })); }
      catch { incoming.destroy(); reject(new CloudflareKvError("transport")); }
    });
    request.once("error", () => { reject(new CloudflareKvError("transport")); });
    request.end();
  });
  return { fetch: fetcher, close: () => { httpsAgent.destroy(); httpAgent.destroy(); } };
}
