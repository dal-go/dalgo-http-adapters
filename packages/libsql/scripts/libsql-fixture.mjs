// One disposable, account-free libSQL server fixture for both the Node and real
// Chromium suites. The image is commit-pinned by digest (never `latest`), the
// Ed25519 key pair and JWTs are generated per run, and teardown removes only
// this container, its temporary key directory and its own data volume.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LIBSQL_IMAGE = "ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67";
export const LIBSQL_SOURCE_COMMIT = "d6c75af6353bb1c34985399608e37cd272a35aa1";
export const LIBSQL_ARM64_MANIFEST = "sha256:f5fef78e7e927dcad04da5a95cd07b589c1bc6ef174ece71f02582cfbcbbe2a0";

const READER_EXPIRY_SECONDS = 3_600;

function base64url(value) { return Buffer.from(value).toString("base64url"); }

/**
 * Writes the *public* verification key into the fixture's own directory and
 * makes that directory and key readable by the unprivileged user the container
 * runs as. `mkdtemp` creates the directory 0700 and a plain write is masked by
 * the caller's umask, so through a bind mount the server's own uid could not
 * traverse or read it on Linux: the container exits before serving /health and
 * the host sees only a refused fetch. Only the public key is ever written to
 * disk — the private key and every JWT signed with it stay in process memory —
 * so widening exactly this directory and this file leaks nothing.
 */
export function writePublicKeyMaterial(work, publicKey) {
  const file = join(work, "public.pem");
  writeFileSync(file, publicKey.export({ type: "spki", format: "pem" }));
  chmodSync(work, 0o755);
  chmodSync(file, 0o644);
  return file;
}

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

function isMissingDockerObject(error) {
  return typeof error === "object" && error !== null
    && error.status === 1
    && /no such (container|object|volume)/iu.test(String(error.stderr ?? ""));
}

function dockerRun(run, args, options = {}) {
  return run(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

/**
 * Captures the exact volume mounts this container owns. Anonymous volumes
 * declared by the image arrive as 64-hex names attached to our own container;
 * only those are ever removed. The mounts are read while the container still
 * exists, before `docker rm`, so ownership is recorded rather than guessed.
 */
function inspectOwnedVolumes(run, name) {
  let output;
  try {
    output = dockerRun(run, ["inspect", "--format", "{{json .Mounts}}", name]);
  } catch (error) {
    if (isMissingDockerObject(error)) return null;
    throw error;
  }
  const mounts = JSON.parse(output);
  if (mounts === null) return [];
  if (!Array.isArray(mounts)) throw new Error("unexpected docker inspect mounts for the libSQL fixture");
  return mounts
    .filter((mount) => mount?.Type === "volume" && typeof mount.Name === "string")
    .map((mount) => mount.Name);
}

function volumeExists(run, volume) {
  try {
    dockerRun(run, ["volume", "inspect", volume]);
    return true;
  } catch (error) {
    if (isMissingDockerObject(error)) return false;
    throw error;
  }
}

/**
 * Removes only this fixture's own container and the exact anonymous volumes
 * recorded from that container. It verifies the real Docker state after each
 * step and throws if anything it owns remains, so a caller can fail the suite
 * instead of silently marking teardown complete. Repeating it is idempotent:
 * an already-absent container/volume is success, but a real Docker failure is
 * never swallowed.
 */
export function teardownFixtureResources({ name, run }) {
  const ownedVolumes = inspectOwnedVolumes(run, name);
  if (ownedVolumes !== null) {
    try {
      dockerRun(run, ["rm", "-f", "-v", name]);
    } catch (error) {
      if (!isMissingDockerObject(error)) throw error;
    }
  }
  if (inspectOwnedVolumes(run, name) !== null) {
    throw new Error(`libSQL fixture container still exists after teardown: ${name}`);
  }

  const removed = [];
  const remaining = [];
  for (const volume of ownedVolumes ?? []) {
    const anonymous = /^[0-9a-f]{64}$/u.test(volume);
    if (anonymous && volumeExists(run, volume)) {
      try {
        dockerRun(run, ["volume", "rm", "-f", volume]);
      } catch (error) {
        if (!isMissingDockerObject(error)) throw error;
      }
      removed.push(volume);
    }
    if (volumeExists(run, volume)) remaining.push(volume);
  }
  if (remaining.length > 0) {
    throw new Error(`libSQL fixture volumes still exist after teardown: ${remaining.join(", ")}`);
  }
  return {
    containerRemoved: ownedVolumes !== null,
    volumesVerified: ownedVolumes ?? [],
    volumesRemoved: removed,
  };
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
  writePublicKeyMaterial(work, publicKey);

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
    if (stopped) return undefined;
    const result = teardownFixtureResources({
      name,
      run: (args, options) => execFileSync("docker", args, options),
    });
    // Marked complete only after every owned resource was removed and verified.
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
    // No PRIMARY KEY at all: only a real single-column UNIQUE index proves the key.
    "CREATE TABLE indexed_only (slug TEXT NOT NULL, label TEXT)",
    "CREATE UNIQUE INDEX indexed_only_slug_u ON indexed_only(slug)",
    "INSERT INTO indexed_only (slug, label) VALUES ('alpha', 'one'), ('beta', 'two'), ('gamma', 'three')",
    // INTEGER PRIMARY KEY DESC is SQLite's documented exception: it is not a
    // rowid alias, creates a pk index and permits NULL (including repeated NULLs).
    "CREATE TABLE pk_desc (id INTEGER PRIMARY KEY DESC, label TEXT)",
    "INSERT INTO pk_desc (id, label) VALUES (NULL, 'null-first'), (NULL, 'null-second'), (1, 'one'), (2, 'two')",
    // WITHOUT ROWID has a pk index and a non-null primary key, never a rowid alias.
    "CREATE TABLE wr_items (code TEXT NOT NULL PRIMARY KEY, label TEXT) WITHOUT ROWID",
    "INSERT INTO wr_items (code, label) VALUES ('wa', 'A'), ('wb', 'B')",
    "CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB)",
    "INSERT INTO blobs (id, payload) VALUES (1, x'00ff10')",
    "CREATE TABLE bigints (id INTEGER PRIMARY KEY, label TEXT)",
    "INSERT INTO bigints (id, label) VALUES (9223372036854775807, 'too-large')",
    "CREATE VIEW items_view AS SELECT id, title, rank FROM items",
  ];
  for (const sql of statements) await execute(url, writerToken, sql);
}
