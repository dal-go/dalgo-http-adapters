// One disposable, account-free Typesense 30.2 server fixture for the Node and
// real-Chromium suites. The image is pinned by digest (never `latest`), every
// container/volume/loopback port is run-specific, and teardown removes and
// verifies only the resources this run created.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TYPESENSE_IMAGE = "typesense/typesense:30.2@sha256:610f2d34b1f93d00762869da2c67736775e5798d19a2c8b91b014b8a0cc1e110";
export const TYPESENSE_VERSION = "30.2";
export const TYPESENSE_ARM64_MANIFEST = "sha256:1c5fbc20774aa0edf8d3bec6e5dd9bd6fe7d02f72897d5c1d2253305ba086d4b";

function isMissingDockerObject(error) {
  return typeof error === "object" && error !== null
    && error.status === 1
    && /no such (container|object|volume)/iu.test(String(error.stderr ?? ""));
}

function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

const REQUEST_DEADLINE_MS = 30_000;
const HEALTH_REQUEST_DEADLINE_MS = 10_000;

/**
 * One finite deadline per setup request, attached to the fetch itself so it
 * covers connection, headers and the complete response-body read. The outer
 * health loop deadline alone is not enough: a server that accepts a connection
 * and then stalls must still fail that request.
 */
function fetchWithDeadline(url, init, deadlineMs = REQUEST_DEADLINE_MS) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(deadlineMs) });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`fixture setup ${label} returned an unexpected body`);
  return value;
}

/** Verifies the pinned multi-arch image metadata before starting anything. */
export function verifyPinnedImage() {
  if (TYPESENSE_IMAGE.includes(":latest")) throw new Error("the Typesense fixture must not use a latest tag");
  const index = JSON.parse(docker(["manifest", "inspect", TYPESENSE_IMAGE]));
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests)) throw new Error("unexpected Typesense image index");
  const arm = index.manifests.find((entry) => entry.platform?.architecture === "arm64" && entry.platform?.os === "linux");
  const amd = index.manifests.find((entry) => entry.platform?.architecture === "amd64" && entry.platform?.os === "linux");
  if (arm?.digest !== TYPESENSE_ARM64_MANIFEST) throw new Error(`unexpected Typesense ARM64 manifest ${String(arm?.digest)}`);
  if (amd === undefined) throw new Error("the Typesense image has no amd64 manifest");
  return { image: TYPESENSE_IMAGE, version: TYPESENSE_VERSION, arm64: arm.digest, amd64: amd.digest };
}

function inspectContainer(name) {
  try {
    docker(["inspect", name]);
    return true;
  } catch (error) {
    if (isMissingDockerObject(error)) return false;
    throw error;
  }
}

function volumeExists(volume) {
  try {
    docker(["volume", "inspect", volume]);
    return true;
  } catch (error) {
    if (isMissingDockerObject(error)) return false;
    throw error;
  }
}

/**
 * Removes only this run's container and volume, then verifies both are absent.
 * A real Docker failure is never swallowed; cleanup failure must fail the run.
 */
export function teardownTypesense({ name, volume }) {
  if (inspectContainer(name)) {
    try {
      docker(["rm", "-f", name]);
    } catch (error) {
      if (!isMissingDockerObject(error)) throw error;
    }
  }
  if (inspectContainer(name)) throw new Error(`Typesense fixture container still exists after teardown: ${name}`);
  if (volumeExists(volume)) {
    try {
      docker(["volume", "rm", "-f", volume]);
    } catch (error) {
      if (!isMissingDockerObject(error)) throw error;
    }
  }
  if (volumeExists(volume)) throw new Error(`Typesense fixture volume still exists after teardown: ${volume}`);
  return { containerRemoved: true, volumeRemoved: true };
}

async function waitHealthy(endpoint, key) {
  const deadline = Date.now() + 60_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithDeadline(`${endpoint}/health`, {
        headers: { "X-TYPESENSE-API-KEY": key },
        redirect: "error",
      }, HEALTH_REQUEST_DEADLINE_MS);
      const body = await response.text();
      if (response.ok && body.includes('"ok":true')) return;
      last = `HTTP ${String(response.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Typesense fixture did not become healthy: ${last}`);
}

/**
 * Starts one unique loopback container. Docker publishes a random loopback host
 * port. `staticOrigin` is the exact browser page origin allowed by CORS.
 */
export async function startTypesenseFixture({ staticOrigin } = {}) {
  const metadata = verifyPinnedImage();
  if (typeof staticOrigin !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(staticOrigin)) {
    throw new Error("staticOrigin must be one explicit loopback HTTP origin");
  }
  const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const name = `dalgo-typesense-ts-${stamp}`;
  const volume = `${name}-data`;
  const work = mkdtempSync(join(tmpdir(), `${name}-`));
  const bootstrapKey = `bootstrap-${randomBytes(18).toString("base64url")}`;

  let stopped = false;
  const stop = () => {
    if (stopped) return undefined;
    const result = teardownTypesense({ name, volume });
    stopped = true;
    return result;
  };
  const onSignal = () => {
    try {
      stop();
    } catch (error) {
      process.stderr.write(`fixture teardown failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    docker(["volume", "create", volume]);
    docker([
      "run", "-d", "--name", name,
      "--label", "dalgo2typesense.fixture=1",
      "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "256",
      "-p", "127.0.0.1::8108",
      "-v", `${volume}:/data`,
      TYPESENSE_IMAGE,
      "--data-dir=/data",
      `--api-key=${bootstrapKey}`,
      "--listen-port=8108",
      "--enable-cors",
      `--cors-domains=${staticOrigin}`,
    ]);
    const portOutput = docker(["port", name, "8108"]).trim();
    const match = /:(\d+)$/u.exec(portOutput);
    if (match === null || match[1] === undefined) throw new Error(`could not read the fixture port from: ${portOutput}`);
    const endpoint = `http://127.0.0.1:${match[1]}`;
    await waitHealthy(endpoint, bootstrapKey);
    const debug = await fetchWithDeadline(`${endpoint}/debug`, { headers: { "X-TYPESENSE-API-KEY": bootstrapKey }, redirect: "error" });
    const debugBody = await debug.json();
    if (!debug.ok || typeof debugBody.version !== "string" || !debugBody.version.startsWith(TYPESENSE_VERSION)) {
      throw new Error("the Typesense fixture is not the pinned 30.2 version");
    }
    return {
      ...metadata,
      name,
      volume,
      work,
      endpoint,
      bootstrapKey,
      staticOrigin,
      stop,
      discardWork() { rmSync(work, { recursive: true, force: true }); },
      keepWork() { process.stderr.write(`fixture work kept for diagnosis: ${work}\n`); },
      detachSignalHandlers() {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      },
    };
  } catch (error) {
    try {
      stop();
    } catch (cleanupError) {
      process.stderr.write(`fixture teardown failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
    }
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    throw error;
  }
}

async function adminText(fixture, method, path, body) {
  const response = await fetchWithDeadline(`${fixture.endpoint}${path}`, {
    method,
    redirect: "error",
    headers: {
      "X-TYPESENSE-API-KEY": fixture.bootstrapKey,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`fixture setup ${method} ${path} failed with HTTP ${String(response.status)}`);
  return text;
}

async function adminJSON(fixture, method, path, body) {
  const text = await adminText(fixture, method, path, body);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`fixture setup ${method} ${path} returned malformed JSON`);
  }
  return parsed;
}

async function createKey(fixture, description, actions, collections) {
  const value = requireRecord(await adminJSON(fixture, "POST", "/keys", { description, actions, collections }), "create key");
  if (typeof value.value !== "string" || value.value.length === 0) throw new Error("fixture key creation returned no value");
  return value.value;
}

/** Seeds the real collections, native documents, curation and scoped keys. */
export async function seedTypesense(fixture) {
  const books = {
    name: "books",
    fields: [
      { name: "title", type: "string" },
      { name: "author", type: "string", facet: true },
      { name: "genre", type: "string", facet: true },
      { name: "year", type: "int32", facet: true },
      { name: "rank", type: "int64" },
      { name: "seq", type: "int64", sort: true },
      { name: "big", type: "int64" },
      { name: "ratio", type: "float" },
      { name: "active", type: "bool", facet: true },
      { name: "tags", type: "string[]", facet: true },
      { name: "note", type: "string", optional: true },
    ],
    default_sorting_field: "rank",
  };
  const semantics = {
    name: "semantics",
    fields: [
      { name: "label", type: "string", facet: true },
      { name: "tags", type: "string[]", facet: true, optional: true },
      { name: "n", type: "float" },
      { name: "m", type: "int32", sort: true },
    ],
  };
  const bulk = {
    name: "bulk",
    fields: [
      { name: "label", type: "string", facet: true },
      { name: "rank", type: "int32", sort: true },
    ],
  };
  const unsafe = { name: "unsafe", fields: [{ name: "value", type: "int64" }] };
  // Deliberately created WITHOUT default_sorting_field: official 30.2 always
  // returns the summary field and uses the empty string as its sentinel.
  const nodesort = { name: "nodesort", fields: [{ name: "label", type: "string", facet: true }] };
  const createCollection = async (schema) => {
    const created = requireRecord(await adminJSON(fixture, "POST", "/collections", schema), `create collection ${schema.name}`);
    if (created.name !== schema.name || !Array.isArray(created.fields)) {
      throw new Error(`fixture setup create collection ${schema.name} did not return the created schema`);
    }
    return created;
  };
  await createCollection(books);
  await createCollection(semantics);
  await createCollection(bulk);
  await createCollection(unsafe);
  await createCollection(nodesort);

  const bookDocuments = [
    { id: "001", title: "Dune", author: "Frank Herbert", genre: "science fiction", year: 1965, rank: 10, seq: 1, big: 1, ratio: 1.5, active: true, tags: ["classic", "desert"] },
    { id: "1", title: "Numeric One", author: "Fixture Author", genre: "fixture", year: 2000, rank: 5, seq: 0, big: 1, ratio: 0.5, active: true, tags: ["fixture"] },
    { id: "002", title: "Dune Messiah", author: "Frank Herbert", genre: "science fiction", year: 1969, rank: 10, seq: 2, big: 2, ratio: 2.25, active: false, tags: ["sequel"] },
    { id: "003", title: "Children of Dune", author: "Frank Herbert", genre: "science fiction", year: 1976, rank: 20, seq: 3, big: 3, ratio: 3.5, active: true, tags: ["sequel"], note: "a b (c) && d" },
    { id: "004", title: "Neuromancer", author: "William Gibson", genre: "cyberpunk", year: 1984, rank: 20, seq: 4, big: 0, ratio: 4.5, active: true, tags: ["classic"] },
    { id: "005", title: "Foundation", author: "Isaac Asimov", genre: "science fiction", year: 1951, rank: 30, seq: 5, big: 42, ratio: 1.0, active: false, tags: ["classic"], note: null },
    { id: "006", title: "Snow Crash", author: "Neal Stephenson", genre: "cyberpunk", year: 1992, rank: 40, seq: 6, big: 84, ratio: 2.0, active: true, tags: ["classic"] },
    { id: "007", title: "The Left Hand of Darkness", author: "Ursula K. Le Guin", genre: "science fiction", year: 1969, rank: 50, seq: 7, big: 7, ratio: 0.5, active: true, tags: ["classic"] },
    { id: "008", title: "Hyperion", author: "Dan Simmons", genre: "science fiction", year: 1989, rank: 60, seq: 8, big: 8, ratio: 0.25, active: true, tags: ["classic"] },
    { id: "009", title: "The Dispossessed", author: "Ursula K. Le Guin", genre: "science fiction", year: 1974, rank: 70, seq: 9, big: 9, ratio: 0.125, active: true, tags: ["classic"] },
    { id: "010", title: "Ender's Game", author: "Orson Scott Card", genre: "science fiction", year: 1985, rank: 80, seq: 10, big: 10, ratio: 0.0625, active: true, tags: ["classic"] },
    { id: "011", title: "The Stars My Destination", author: "Alfred Bester", genre: "science fiction", year: 1956, rank: 90, seq: 11, big: 11, ratio: 0.03125, active: true, tags: ["classic"] },
    { id: "012", title: "A Canticle for Leibowitz", author: "Walter M. Miller Jr.", genre: "science fiction", year: 1959, rank: 100, seq: 12, big: 12, ratio: 0.015625, active: true, tags: ["classic"] },
  ];
  const seededID = (collection, document, index) => {
    if (typeof document === "string") {
      try {
        const parsed = JSON.parse(document);
        if (isRecord(parsed) && typeof parsed.id === "string") return parsed.id;
      } catch {
        // One fixed message below; never echo a malformed seed row.
      }
    } else if (isRecord(document) && typeof document.id === "string") {
      return document.id;
    }
    throw new Error(`fixture seed for ${collection} row ${index + 1} requires a string id`);
  };
  const importDocuments = async (collection, documents) => {
    // A string entry is already-serialised raw JSON. The unsafe-int64 seed
    // must use this path: a JavaScript numeric literal would be rounded before
    // JSON.stringify and would no longer prove the adapter's refusal.
    const body = documents
      .map((document) => typeof document === "string" ? document : JSON.stringify(document))
      .join("\n");
    // `return_id=true` is required: without it the import acknowledgement rows
    // carry no `id`, so the per-row seeded-id assertion below cannot pass.
    const text = await adminText(fixture, "POST", `/collections/${collection}/documents/import?action=upsert&return_id=true`, body);
    // The import endpoint returns one NDJSON row per input document. Every row
    // is parsed and checked, so a malformed, false or missing acknowledgement
    // can never be inferred away by a later read-only test.
    const rows = text.split(/\r?\n/u).filter((row) => row.length > 0);
    if (rows.length !== documents.length) {
      throw new Error(`fixture import into ${collection} returned ${String(rows.length)} rows for ${String(documents.length)} documents`);
    }
    for (let index = 0; index < rows.length; index += 1) {
      let row;
      try {
        row = JSON.parse(rows[index]);
      } catch {
        throw new Error(`fixture import into ${collection} row ${index + 1} is malformed JSON`);
      }
      if (!isRecord(row)) throw new Error(`fixture import into ${collection} row ${index + 1} is not an object`);
      if (row.id !== seededID(collection, documents[index], index)) {
        throw new Error(`fixture import into ${collection} row ${index + 1} did not acknowledge the seeded id`);
      }
      if (row.success !== true) throw new Error(`fixture import into ${collection} row ${index + 1} did not report success`);
    }
  };
  await importDocuments("books", bookDocuments);

  const semanticsDocuments = [
    { id: "f0", label: "classic", tags: ["classic", "desert"], n: 0.1, m: 4 },
    { id: "f1", label: "Classic", tags: ["sequel"], n: 0.1000000001, m: 6 },
    { id: "f2", label: "CLASSIC", tags: ["classic"], n: 0.10000000149, m: 7 },
    { id: "f3", label: "red-blue", tags: ["a_b"], n: 100000001, m: 9 },
    { id: "f4", label: "redblue", tags: ["ab"], n: 100000000, m: 10 },
    { id: "f5", label: "café", n: 1.5, m: 12 },
    { id: "f6", label: "cafe", n: 2.5, m: 13 },
    { id: "f7", label: "a.b", tags: ["ab"], n: 3.5, m: 14 },
    { id: "f8", label: "ab", tags: ["a_b"], n: 4.5, m: 15 },
    { id: "f9", label: "hello world", n: 5.5, m: 16 },
    { id: "f10", label: "hello  world", n: 6.5, m: 17 },
  ];
  await importDocuments("semantics", semanticsDocuments);

  const bulkDocuments = Array.from({ length: 1_200 }, (_, index) => ({
    id: `b${String(index).padStart(4, "0")}`,
    label: index % 2 === 0 ? "even" : "odd",
    rank: index,
  }));
  await importDocuments("bulk", bulkDocuments);
  await importDocuments("nodesort", [{ id: "n1", label: "a" }, { id: "n2", label: "b" }]);
  // Exact raw JSON token: 9007199254740993 is unsafe for a JS number and must
  // reach the server unrounded so the real adapter has to refuse it.
  await importDocuments("unsafe", ['{"id":"u1","value":9007199254740993}']);

  const curation = requireRecord(await adminJSON(fixture, "PUT", "/curation_sets/books_curations", {
    items: [{ id: "pin-scifi-doc", rule: { filter_by: "genre:=cyberpunk" }, includes: [{ id: "001", position: 1 }] }],
  }), "create books curations");
  if (curation.name !== "books_curations" || !Array.isArray(curation.items)) {
    throw new Error("fixture setup create books curations did not return the created curation set");
  }
  // PATCH /collections/:name echoes the request document (30.2 core_api.cpp),
  // so its acknowledgement carries curation_sets but no collection name; the
  // persisted state is therefore read back independently with GET.
  const attachAck = requireRecord(await adminJSON(fixture, "PATCH", "/collections/books", { curation_sets: ["books_curations"] }), "attach books curations");
  if (!Array.isArray(attachAck.curation_sets) || !attachAck.curation_sets.includes("books_curations")) {
    throw new Error("fixture setup attach books curations did not acknowledge the curation set");
  }
  const attached = requireRecord(await adminJSON(fixture, "GET", "/collections/books"), "read back books curations");
  if (attached.name !== "books" || !Array.isArray(attached.curation_sets) || !attached.curation_sets.includes("books_curations")) {
    throw new Error("fixture setup attach books curations did not persist the curation set");
  }

  const searchKey = await createKey(fixture, "fixture-pure-search", ["documents:search"], ["books", "semantics", "bulk", "unsafe", "nodesort"]);
  const metadataKey = await createKey(fixture, "fixture-search-and-metadata", ["documents:search", "collections:get", "collections:list"], ["books", "semantics", "bulk", "unsafe", "nodesort"]);
  return { searchKey, metadataKey };
}

/** A direct raw search with the bootstrap key, used to prove the curation premise. */
export async function rawSearch(fixture, collection, parameters) {
  const query = new URLSearchParams(parameters).toString();
  const response = await fetchWithDeadline(`${fixture.endpoint}/collections/${encodeURIComponent(collection)}/documents/search?${query}`, {
    redirect: "error",
    headers: { "X-TYPESENSE-API-KEY": fixture.bootstrapKey },
  });
  if (!response.ok) throw new Error(`fixture raw search failed with HTTP ${String(response.status)}`);
  return await response.json();
}
