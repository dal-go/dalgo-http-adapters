import { providerEvidenceDigest, type ProviderReadPlan, type SourceRight } from "@dalgo/core";
import { JSDOM } from "jsdom";
import { ECB_DAILY_URL } from "../src/index.js";
export const parser = new JSDOM().window.DOMParser;
export const xml = `<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><gesmes:subject>synthetic</gesmes:subject><gesmes:Sender><gesmes:name>invented</gesmes:name></gesmes:Sender><Cube><Cube time="2037-02-03"><Cube currency="AAA" rate="001.23000"/><Cube currency="ZZZ" rate="0.00001"/></Cube></Cube></gesmes:Envelope>`;
export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
export function response(text = xml): Response { return new Response(text, { headers: { "Content-Type": "text/xml" } }); }
export async function plan(): Promise<ProviderReadPlan> {
  const right: SourceRight = {
    sourceId: "rights:synthetic/daily", source: { serverId: "synthetic", recordset: "daily" },
    declaration: { text: "Synthetic permission\n preserve whitespace" }, declarationScope: "recordset",
    declaredAt: { serverId: "synthetic", recordset: "daily" }, evidenceOrigin: "fixture-only",
    pins: [], transformations: ["ecb-eurofxref/1 XML to native strings"],
  };
  return {
    execution: { id: "synthetic-execution", mode: "direct", executorId: "synthetic-browser" },
    bindings: [{ providerSourceId: "provider:synthetic", rightsSourceId: right.sourceId, resourceId: "daily",
      definitionDigest: "a".repeat(64), decoderDigest: "b".repeat(64),
      rightsDigest: await providerEvidenceDigest({ format: "ovdb-rights-binding/1", right }) }],
    requests: [{ resourceId: "daily", method: "GET", upstreamUrl: ECB_DAILY_URL, params: {} }],
    sourceRights: [right], usedSourceIds: [right.sourceId],
  };
}
