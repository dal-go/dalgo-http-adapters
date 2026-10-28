import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TeardownResult {
  readonly containerRemoved: boolean;
  readonly volumesVerified: readonly string[];
  readonly volumesRemoved: readonly string[];
}

type Run = (args: readonly string[], options?: Readonly<Record<string, unknown>>) => string;

interface FixtureModule {
  readonly teardownFixtureResources: (options: { readonly name: string; readonly run: Run }) => TeardownResult;
  readonly writePublicKeyMaterial: (work: string, publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]) => string;
}

const fixture = await import(new URL("../scripts/libsql-fixture.mjs", import.meta.url).href) as FixtureModule;

const CONTAINER = "dalgo-libsql-fixture-test";
const OWNED_VOLUME = "a".repeat(64);
const OTHER_VOLUME = "b".repeat(64);

interface FakeDockerOptions {
  readonly containers?: readonly string[];
  readonly volumes?: readonly string[];
  readonly removeFails?: { readonly status?: number; readonly stderr?: string };
  readonly keepVolumeAfterRm?: boolean;
  readonly volumeRemoveFails?: { readonly status?: number; readonly stderr?: string };
}

interface FakeDocker {
  readonly run: Run;
  readonly calls: readonly (readonly string[])[];
  readonly containers: ReadonlyMap<string, readonly string[]>;
  readonly volumes: ReadonlySet<string>;
}

function dockerError(message: string, status: number, stderr: string): Error {
  return Object.assign(new Error(message), { status, stderr });
}

function missingContainer(name: string): Error {
  return dockerError(`Command failed: docker inspect ${name}`, 1, `Error response from daemon: No such container: ${name}`);
}

function missingVolume(volume: string): Error {
  return dockerError(`Command failed: docker volume inspect ${volume}`, 1, `Error response from daemon: get ${volume}: no such volume`);
}

/**
 * A deterministic Docker double: it records the exact argv sequence and
 * exposes only this fixture's container and volumes, so the teardown test can
 * prove that no broad prune or unrelated volume deletion ever happens.
 */
function fakeDocker(options: FakeDockerOptions = {}): FakeDocker {
  const containers = new Map<string, readonly string[]>();
  for (const name of options.containers ?? [CONTAINER]) containers.set(name, [OWNED_VOLUME]);
  const volumes = new Set<string>(options.volumes ?? [OWNED_VOLUME, OTHER_VOLUME]);
  const calls: string[][] = [];
  const run: Run = (args) => {
    calls.push([...args]);
    const command = args[0];
    const action = args[1];
    if (command === "inspect") {
      const name = args[args.length - 1];
      if (name === undefined) throw new Error("docker inspect name missing");
      const mounts = containers.get(name);
      if (mounts === undefined) throw missingContainer(name);
      return JSON.stringify(mounts.map((name) => ({ Type: "volume", Name: name, Destination: "/data" })));
    }
    if (command === "rm") {
      if (options.removeFails !== undefined) {
        throw dockerError(options.removeFails.stderr ?? "permission denied", options.removeFails.status ?? 125, options.removeFails.stderr ?? "permission denied");
      }
      const name = args[args.length - 1];
      if (name === undefined) throw new Error("docker rm name missing");
      const mounts = containers.get(name);
      if (mounts === undefined) throw missingContainer(name);
      containers.delete(name);
      if (args.includes("-v") && options.keepVolumeAfterRm !== true) {
        for (const volume of mounts) volumes.delete(volume);
      }
      return name;
    }
    if (command === "volume" && action === "inspect") {
      const volume = args[2];
      if (volume === undefined) throw new Error("docker volume inspect name missing");
      if (!volumes.has(volume)) throw missingVolume(volume);
      return "[]";
    }
    if (command === "volume" && action === "rm") {
      if (options.volumeRemoveFails !== undefined) {
        throw dockerError(options.volumeRemoveFails.stderr ?? "device or resource busy", options.volumeRemoveFails.status ?? 1, options.volumeRemoveFails.stderr ?? "device or resource busy");
      }
      const volume = args[args.length - 1];
      if (volume === undefined) throw new Error("docker volume rm name missing");
      if (!volumes.has(volume)) throw missingVolume(volume);
      volumes.delete(volume);
      return volume;
    }
    throw new Error(`unexpected docker argv: ${args.join(" ")}`);
  };
  return { run, calls, containers, volumes };
}

describe("libSQL fixture public key material", () => {
  it("makes only the public key traversable and readable by the unprivileged container user under a restrictive umask", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const work = mkdtempSync(join(tmpdir(), "dalgo-libsql-public-key-"));
    const previousUmask = process.umask(0o077);
    try {
      fixture.writePublicKeyMaterial(work, publicKey);
      // mkdtemp creates the directory 0755-or-tighter and the key write is
      // masked by the caller's umask, so under 0077 the bind mount would be
      // untraversable and unreadable for the container's own uid on Linux.
      // The expected post-conditions are the real filesystem modes, not a
      // record of chmod being called.
      expect(statSync(work).mode & 0o777).toBe(0o755);
      expect(statSync(join(work, "public.pem")).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(previousUmask);
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("writes only the public PEM and never a private key or JWT file", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const work = mkdtempSync(join(tmpdir(), "dalgo-libsql-public-key-"));
    try {
      fixture.writePublicKeyMaterial(work, publicKey);
      expect(readdirSync(work)).toEqual(["public.pem"]);
      const pem = readFileSync(join(work, "public.pem"), "utf8");
      expect(pem).toContain("-----BEGIN PUBLIC KEY-----");
      expect(pem).not.toContain("PRIVATE KEY");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("libSQL fixture teardown", () => {
  it("captures mounts before removal, removes the container with -v and verifies only its own volume", () => {
    const docker = fakeDocker();
    const result = fixture.teardownFixtureResources({ name: CONTAINER, run: docker.run });

    expect(result).toMatchObject({ containerRemoved: true, volumesVerified: [OWNED_VOLUME], volumesRemoved: [] });
    expect(docker.containers.has(CONTAINER)).toBe(false);
    expect(docker.volumes.has(OWNED_VOLUME)).toBe(false);
    expect(docker.volumes.has(OTHER_VOLUME)).toBe(true);
    expect(docker.calls.map((call) => call[0] === "volume" ? `${call[0]} ${call[1] ?? ""}` : call[0])).toEqual([
      "inspect",
      "rm",
      "inspect",
      "volume inspect",
      "volume inspect",
    ]);
    expect(docker.calls.find((call) => call[0] === "rm")).toEqual(["rm", "-f", "-v", CONTAINER]);
    expect(docker.calls.some((call) => call[0] === "system" || call[0] === "prune")).toBe(false);
  });

  it("is idempotent after a complete teardown and never invents an owned resource", () => {
    const docker = fakeDocker({ containers: [], volumes: [OTHER_VOLUME] });
    const first = fixture.teardownFixtureResources({ name: CONTAINER, run: docker.run });
    const second = fixture.teardownFixtureResources({ name: CONTAINER, run: docker.run });
    expect(first).toEqual({ containerRemoved: false, volumesVerified: [], volumesRemoved: [] });
    expect(second).toEqual(first);
    expect(docker.volumes.has(OTHER_VOLUME)).toBe(true);
  });

  it("propagates a real container removal failure instead of marking teardown complete", () => {
    const docker = fakeDocker({ removeFails: { stderr: "permission denied while removing container" } });
    expect(() => fixture.teardownFixtureResources({ name: CONTAINER, run: docker.run }))
      .toThrow("permission denied while removing container");
    expect(docker.containers.has(CONTAINER)).toBe(true);
    expect(docker.calls.some((call) => call[0] === "volume")).toBe(false);
  });

  it("removes and verifies a recorded anonymous volume that survived rm -v by exact ID", () => {
    const docker = fakeDocker({ keepVolumeAfterRm: true });
    const result = fixture.teardownFixtureResources({ name: CONTAINER, run: docker.run });
    expect(result.volumesRemoved).toEqual([OWNED_VOLUME]);
    expect(docker.volumes.has(OWNED_VOLUME)).toBe(false);
    expect(docker.calls.filter((call) => call[0] === "volume" && call[1] === "rm"))
      .toEqual([["volume", "rm", "-f", OWNED_VOLUME]]);
    expect(docker.volumes.has(OTHER_VOLUME)).toBe(true);
  });

  it("fails the suite when a recorded owned volume still exists after cleanup", () => {
    const docker = fakeDocker({ keepVolumeAfterRm: true, volumeRemoveFails: { stderr: "device or resource busy" } });
    expect(() => fixture.teardownFixtureResources({ name: CONTAINER, run: docker.run }))
      .toThrow("device or resource busy");
    expect(docker.volumes.has(OWNED_VOLUME)).toBe(true);
  });

  it("reports a volume that would still remain after a successful removal command", () => {
    // A Docker daemon that accepted volume rm but did not remove it.
    const stubborn = fakeDocker({ keepVolumeAfterRm: true });
    const stubbornRun: Run = (args, runOptions) => {
      if (args[0] === "volume" && args[1] === "rm") return "accepted";
      return stubborn.run(args, runOptions);
    };
    expect(() => fixture.teardownFixtureResources({ name: CONTAINER, run: stubbornRun }))
      .toThrow(`libSQL fixture volumes still exist after teardown: ${OWNED_VOLUME}`);
    expect(stubborn.volumes.has(OWNED_VOLUME)).toBe(true);
  });
});
