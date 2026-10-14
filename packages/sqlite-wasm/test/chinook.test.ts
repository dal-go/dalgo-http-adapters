import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Key } from "@dalgo/core";
import { ConstraintViolationError, createSqliteDatabase, enableForeignKeys } from "../src/index.js";
import { fileCopyDriver } from "./sqlite.js";

// The real Chinook sample, when CHINOOK_SQLITE names a local copy (for example
// demo-db/chinook/artifacts/data/chinook.sqlite). The file is loaded into a
// private in-memory copy and never modified. Skipped when absent.
const chinookPath = process.env.CHINOOK_SQLITE ?? "";

describe.skipIf(chinookPath === "" || !existsSync(chinookPath))("Chinook sample database", () => {
  async function open() {
    const { driver } = fileCopyDriver(chinookPath);
    await enableForeignKeys(driver);
    return createSqliteDatabase(driver);
  }

  it("counts rows and exposes declared NUMERIC types", async () => {
    const db = await open();
    const schema = await db.schema();
    expect(Object.keys(schema.tables)).toEqual(["Album", "Artist", "Customer", "Employee", "Genre", "Invoice", "InvoiceLine", "MediaType", "Playlist", "PlaylistTrack", "Track"]);
    expect(schema.tables.Track?.columns.find((column) => column.name === "UnitPrice")?.declaredType).toBe("NUMERIC(10,2)");
    expect(schema.tables.PlaylistTrack?.primaryKey).toEqual(["PlaylistId", "TrackId"]);
    expect((await db.query({ source: { kind: "collection", name: "Artist" }, filters: [], orders: [] })).records).toHaveLength(275);
    expect((await db.query({ source: { kind: "collection", name: "Album" }, filters: [], orders: [] })).records).toHaveLength(347);
    const line = await db.get(new Key("InvoiceLine", 1));
    expect(line.data).toMatchObject({ UnitPrice: 0.99, Quantity: 1 });
  });

  it("updates an artist name", async () => {
    const db = await open();
    await db.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 1), { Name: "AC-DC (edited)" }));
    expect((await db.get(new Key("Artist", 1))).data).toEqual({ ArtistId: 1, Name: "AC-DC (edited)" });
  });

  it("refuses to delete an artist referenced by albums and deletes an unreferenced one", async () => {
    const db = await open();
    const referenced = db.runReadwriteTransaction((tx) => tx.delete(new Key("Artist", 1)));
    await expect(referenced).rejects.toBeInstanceOf(ConstraintViolationError);
    await expect(referenced).rejects.toMatchObject({ constraint: "foreign_key" });
    const unreferenced = await db.query({
      source: { kind: "collection", name: "Album" },
      filters: [{ field: "ArtistId", operator: "==", value: 25 }],
      orders: [],
    });
    expect(unreferenced.records).toHaveLength(0);
    await db.runReadwriteTransaction((tx) => tx.delete(new Key("Artist", 25)));
    expect((await db.get(new Key("Artist", 25))).exists).toBe(false);
    expect((await db.query({ source: { kind: "collection", name: "Artist" }, filters: [], orders: [] })).records).toHaveLength(274);
  });
});
