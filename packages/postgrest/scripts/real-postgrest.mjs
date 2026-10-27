/* global Buffer, fetch, setTimeout, console, process */
// Owns one disposable PostgREST v16 + PostgreSQL 17 Compose project. It uses
// random loopback host ports, a synthetic JWT role, a read-only role and exact
// CORS origin, then removes only its own project and temporary directory.
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const project = `datatug-postgrest-ts-${stamp}`;
const corsOrigin = "https://datatug.example";
const jwtSecret = `synthetic-postgrest-ts-fixture-secret-${randomBytes(8).toString("hex")}`;
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

-- Control-named columns: PostgREST would read an unquoted filter key such as
-- limit as its own parameter, so these prove the quoted-key rendering.
create table api.reserved_words (
  id bigint primary key,
  "select" text,
  "columns" text,
  "on_conflict" integer,
  "order" integer,
  "limit" integer,
  "offset" integer,
  "and" integer,
  "or" integer,
  ordinary integer
);

insert into api.reserved_words values
  (1, 'alpha', 'c1', 2, 2, 10, null, 3, 4, 5),
  (2, 'beta',  'c2', 1, 1, null, 100, 1, 5, 6);

-- A control name as the configured primary key, exercised through point reads.
create table api.reserved_ids ("offset" bigint primary key, title text not null);
insert into api.reserved_ids values (7, 'seven'), (70, 'seventy');

-- Canonical numeric keys: every literal below survives the JavaScript round
-- trip exactly, so keyset paging must keep working for numeric order values.
create table api.numeric_items (id numeric primary key, title text not null);
insert into api.numeric_items values
  (0.1, 'tenth'),
  (0.2, 'fifth'),
  (0.30000000000000004, 'exact-sum');

-- Two PostgreSQL numeric keys that are distinct in the database but collapse
-- to the same JavaScript double. Paginating these would repeat a row, so the
-- adapter must refuse the response instead of emitting a changed token.
create table api.numeric_precise (id numeric primary key, title text not null);
insert into api.numeric_precise values
  (0.1, 'plain'),
  (0.10000000000000001, 'precise');

grant usage on schema api to anon, app_user;
grant select on api.items, api.items_view, api.reserved_words, api.reserved_ids,
  api.numeric_items, api.numeric_precise to app_user;
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
      # Deliberately below the page sizes used by the test: every response is
      # a short page, so a consumer must continue on a non-empty page.
      PGRST_DB_MAX_ROWS: 2
      PGRST_SERVER_CORS_ALLOWED_ORIGINS: ${corsOrigin}
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

  console.log(`real PostgREST fixture: project=${project} url=${url} origin=${corsOrigin}`);
  const test = spawnSync("pnpm", ["exec", "vitest", "run", "test/real-postgrest.real.test.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: "inherit",
    env: {
      ...process.env,
      POSTGREST_TEST_URL: url,
      POSTGREST_TEST_JWT: jwt,
      POSTGREST_TEST_CORS_ORIGIN: corsOrigin,
      POSTGREST_TEST_SCHEMA: "api",
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
