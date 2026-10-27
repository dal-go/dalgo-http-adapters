/* global Buffer, fetch, console, process, setTimeout */
// Owns one disposable PostgREST v16 + PostgreSQL 17 Compose project for the
// real-browser suite. The fixture allows exactly the static page's origin, so
// Chromium itself proves CORS and header handling; nothing is routed or faked.
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const project = `datatug-postgrest-ts-r2-${stamp}`;
const jwtSecret = `synthetic-postgrest-browser-fixture-secret-${randomBytes(8).toString("hex")}`;
const work = mkdtempSync(join(tmpdir(), `${project}-`));

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function token(role, expiresInSeconds = 3_600) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + expiresInSeconds }));
  const signature = createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      probe.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

const staticPort = await freePort();
const staticOrigin = `http://127.0.0.1:${String(staticPort)}`;

const seed = `
create role anon nologin;
create role app_user nologin;
create role authenticator noinherit login password 'fixture-auth-password';
grant anon, app_user to authenticator;

create schema api;

create table api.items (
  id text primary key,
  title text not null,
  priority integer not null,
  done boolean not null default false,
  score numeric,
  tags text[]
);

insert into api.items (id, title, priority, done, score, tags) values
  ('i1', 'Alpha',   2, false, 9.5, '{red,blue}'),
  ('i2', 'Beta',    3, false, null, null),
  ('i3', 'Gamma',   1, false, 3,   '{green}'),
  ('i4', 'Delta',   2, false, null, null),
  ('i5', 'Epsilon', 3, false, 4.25, '{}'),
  ('i6', 'Zeta',    1, true,  7,   null),
  ('i7', 'Eta',     2, true,  null, null);

create view api.items_view as select id, title from api.items;

grant usage on schema api to anon, app_user;
grant select on api.items, api.items_view to app_user;
`;

const compose = `
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: fixture-postgres-password
    volumes:
      - ./seed.sql:/docker-entrypoint-initdb.d/seed.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 1s
      timeout: 5s
      retries: 40
  postgrest:
    image: postgrest/postgrest:v16.5
    depends_on:
      db:
        condition: service_healthy
    environment:
      PGRST_DB_URI: postgres://authenticator:fixture-auth-password@db:5432/postgres
      PGRST_DB_SCHEMAS: api
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: ${jwtSecret}
      PGRST_OPENAPI_MODE: follow-privileges
      PGRST_DB_MAX_ROWS: 2
      PGRST_SERVER_CORS_ALLOWED_ORIGINS: ${staticOrigin}
    ports:
      - "127.0.0.1::3000"
`;

const composeFile = join(work, "compose.yml");
writeFileSync(join(work, "seed.sql"), seed);
writeFileSync(composeFile, compose);

function composeCommand(args, options = {}) {
  return execFileSync("docker", ["compose", "-p", project, "-f", composeFile, ...args], {
    cwd: work,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function port() {
  const output = composeCommand(["port", "postgrest", "3000"]).trim();
  const match = /:(\d+)$/u.exec(output);
  if (match === null) throw new Error(`could not read the PostgREST host port from: ${output}`);
  return Number(match[1]);
}

async function waitForService(url, jwt) {
  const deadline = Date.now() + 90_000;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/`, { headers: { authorization: `Bearer ${jwt}` } });
      if (response.status === 200) return;
      last = `HTTP ${String(response.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`PostgREST did not become ready: ${last ?? "no response"}`);
}

let exitCode = 0;
try {
  composeCommand(["up", "-d", "--wait", "--wait-timeout", "120"]);
  const hostPort = port();
  const url = `http://127.0.0.1:${String(hostPort)}`;
  const jwt = token("app_user");
  await waitForService(url, jwt);

  console.log(`real PostgREST browser fixture: project=${project} url=${url} allowedOrigin=${staticOrigin}`);
  const test = spawnSync("pnpm", ["exec", "playwright", "test", "test/browser/postgrest-browser.spec.ts", "--project=chromium"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(staticPort),
      POSTGREST_BROWSER_URL: url,
      POSTGREST_BROWSER_ALLOWED_ORIGIN: staticOrigin,
      POSTGREST_BROWSER_JWT: jwt,
    },
  });
  exitCode = test.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  try {
    composeCommand(["down", "-v", "--remove-orphans"]);
  } catch (error) {
    console.error(`fixture teardown failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
  if (existsSync(work) && exitCode === 0) rmSync(work, { recursive: true, force: true });
  else console.error(`fixture files kept for diagnosis: ${work}`);
}
process.exitCode = exitCode;
