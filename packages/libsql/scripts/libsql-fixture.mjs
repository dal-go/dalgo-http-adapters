// One disposable, account-free libSQL server fixture for both the Node and real
// Chromium suites. The image is commit-pinned by digest (never `latest`), the
// Ed25519 key pair and JWTs are generated per run, and teardown removes only
// this container, its temporary key directory and its own data volume.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LIBSQL_IMAGE = "ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67";
export const LIBSQL_SOURCE_COMMIT = "d6c75af6353bb1c34985399608e37cd272a35aa1";
export const LIBSQL_ARM64_MANIFEST = "sha256:f5fef78e7e927dcad04da5a95cd07b589c1bc6ef174ece71f02582cfbcbbe2a0";

const READER_EXPIRY_SECONDS = 3_600;

function base64url(value) { return Buffer.from(value).toString("base64url"); }

/** Verifies the pinned multi-arch image metadata before starting anything. */
export function verifyPinnedImage() {
  if (LIBSQL_IMAGE.includes(":latest")) throw new Error("the libSQL fixture must not use a latest tag");
  const raw = execFileSync("docker", ["manifest", "inspect", LIBSQL_IMAGE], { encoding: "utf8" });
  const index = JSON.parse(raw);
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests)) throw new Error("unexpected libSQL image index");
  const arm = index.manifests.find((entry) => entry.platform?.architecture === "arm64" && entry.platform?.os === "linux");
  const amd = index.manifests.find((entry) => entry.platform?.architecture === "amd64" && entry.platform?.os === "linux");
  if (arm?.digest !== LIBSQL_ARM64_MANIFEST) throw new Error(`unexpected ARM64 manifest ${String(arm?.digest)}`);
  if (amd === undefined) throw new Error("the libSQL image has no amd64 manifest");
  return {
    image: LIBSQL_IMAGE,
    sourceCommit: LIBSQL_SOURCE_COMMIT,
    arm64: arm.digest,
    amd64: amd.digest,
  };
}

function pipelineBody(sql, args = [], wantRows = false) {
  return JSON.stringify({
    baton: null,
    requests: [
      { type: "execute", stmt: { sql, args, want_rows: wantRows } },
      { type: "close" },
    ],
  });
}

export async function execute(url, token, sql, args = [], wantRows = false) {
  const response = await fetch(`${url}/v3/pipeline`, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: pipelineBody(sql, args, wantRows),
  });
  if (!response.ok) throw new Error(`fixture statement failed with HTTP ${String(response.status)}`);
  const value = await response.json();
  const first = value?.results?.[0];
  if (first?.type !== "ok") throw new Error(`fixture statement failed: ${String(first?.error?.code ?? "unknown")}`);
  return first.response.result;
}

/**
 * Starts one unique loopback container and returns its origin, reader/writer
 * tokens and a cleanup callback. The container listens on 0.0.0.0 inside its
 * own network namespace; Docker publishes a random loopback host port.
 */
export async function startLibSQLFixture() {
  const metadata = verifyPinnedImage();
  const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const name = `dalgo-libsql-fixture-${stamp}`;
  const work = mkdtempSync(join(tmpdir(), `${name}-`));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(work, "public.pem"), publicKey.export({ type: "spki", format: "pem" }));

  const token = (permission) => {
    const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
    const payload = base64url(JSON.stringify({
      a: permission,
      exp: Math.floor(Date.now() / 1000) + READER_EXPIRY_SECONDS,
    }));
    return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
  };
  const readerToken = token("ro");
  const writerToken = token("rw");

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      // The container may already be gone after a failed start.
    }
  };
  const onSignal = () => {
    stop();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    execFileSync("docker", [
      "run", "-d", "--name", name,
      "-p", "127.0.0.1::8080",
      "-v", `${work}:/keys:ro`,
      "-e", "SQLD_DB_PATH=/data/fixture",
      "-e", "SQLD_HTTP_LISTEN_ADDR=0.0.0.0:8080",
      "-e", "SQLD_AUTH_JWT_KEY_FILE=/keys/public.pem",
      LIBSQL_IMAGE,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const portOutput = execFileSync("docker", ["port", name, "8080"], { encoding: "utf8" }).trim();
    const match = /:(\d+)$/u.exec(portOutput);
    if (match === null || match[1] === undefined) throw new Error(`could not read the fixture port from: ${portOutput}`);
    const url = `http://127.0.0.1:${match[1]}`;
    const deadline = Date.now() + 60_000;
    let last = "no response";
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${url}/health`, { redirect: "error" });
        if (response.ok) { ready = true; break; }
        last = `HTTP ${String(response.status)}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`libSQL fixture did not become healthy: ${last}`);
    return {
      ...metadata,
      name,
      url,
      work,
      readerToken,
      writerToken,
      stop,
      discardWork() { rmSync(work, { recursive: true, force: true }); },
      keepWork() { process.stderr.write(`fixture work kept for diagnosis: ${work}\n`); },
      detachSignalHandlers() {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      },
    };
  } catch (error) {
    stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    throw error;
  }
}

/** Seeds native tables with duplicate sort values, NULLs, text and numeric IDs. */
export async function seedLibSQL(url, writerToken) {
  const statements = [
    "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, rank INTEGER, score REAL, done INTEGER, code TEXT)",
    `INSERT INTO items (id, title, rank, score, done, code) VALUES
      (1, 'Alpha', 2, 9.5, 0, 'a'),
      (2, 'Beta', 2, NULL, 0, 'b'),
      (3, 'Gamma', 1, 3.5, 0, 'c'),
      (4, 'Delta', NULL, NULL, 0, 'd'),
      (5, 'Epsilon', 3, 4.25, 0, 'e'),
      (6, 'Zeta', 1, 7, 1, 'f'),
      (7, 'Eta', 2, NULL, 1, 'g'),
      (8, 'Theta', NULL, 0.5, 0, 'h'),
      (9, 'Iota', 3, 1.25, 0, 'i'),
      (10, 'Kappa', 1, NULL, 0, 'j'),
      (11, 'Lambda', 2, 2.5, 1, 'k'),
      (12, 'Mu', 3, NULL, 0, 'l')`,
    "CREATE TABLE labels (code TEXT PRIMARY KEY, label TEXT)",
    "INSERT INTO labels (code, label) VALUES ('a1', 'Alpha'), ('b2', 'Beta'), ('c3', 'Gamma')",
    "CREATE UNIQUE INDEX labels_label_u ON labels(label)",
    "CREATE TABLE metrics (ratio REAL PRIMARY KEY, label TEXT)",
    "INSERT INTO metrics (ratio, label) VALUES (0.1, 'tenth'), (0.2, 'fifth'), (0.30000000000000004, 'sum'), (1.5, 'half')",
    "CREATE TABLE composite (a TEXT NOT NULL, b TEXT NOT NULL, value TEXT, PRIMARY KEY (a, b))",
    "INSERT INTO composite (a, b, value) VALUES ('x', '1', 'first'), ('x', '2', 'second')",
    "CREATE TABLE nullable_pk (code TEXT PRIMARY KEY, label TEXT)",
    "INSERT INTO nullable_pk (code, label) VALUES ('n1', 'explicit'), (NULL, 'null-code')",
    "CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB)",
    "INSERT INTO blobs (id, payload) VALUES (1, x'00ff10')",
    "CREATE TABLE bigints (id INTEGER PRIMARY KEY, label TEXT)",
    "INSERT INTO bigints (id, label) VALUES (9223372036854775807, 'too-large')",
    "CREATE VIEW items_view AS SELECT id, title, rank FROM items",
  ];
  for (const sql of statements) await execute(url, writerToken, sql);
}
