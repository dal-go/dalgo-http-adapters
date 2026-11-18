import { expect, it } from "vitest";
import { AthenaNativeClient } from "../src/client.js";
import { Fixture, json, query, source } from "./fixture.js";
it("projects explicit native columns in the original SELECT and preserves projected metadata", async () => {
  const fixture = new Fixture();
  fixture.override = event => event.action === "GetQueryResults" ? json({ ResultSet: { ResultSetMetadata: { ColumnInfo: [{ Name: "amount", Type: "decimal", Precision: 38, Scale: 10 }] }, Rows: [
    { Data: [{ VarCharValue: "amount" }] }, { Data: [{ VarCharValue: "9007199254740993.0001" }] }
  ] } }) : undefined;
  const client = new AthenaNativeClient({ source, transport: fixture });
  try {
    const page = await client.queryPage(query(), { projection: ["amount"] });
    expect(page.rows).toEqual([["9007199254740993.0001"]]); expect(page.columns.map(value => value.name)).toEqual(["amount"]);
    expect(fixture.calls.find(value => value.action === "StartQueryExecution")?.input.QueryString).toMatch(/^SELECT "amount" FROM /u);
  } finally { client.close(); }
});
it.each(["constructor", "__proto__", "array-contains", "==; DELETE"])("refuses unsupported operator %s before auth", async operator => {
  const fixture = new Fixture(), client = new AthenaNativeClient({ source, transport: fixture });
  try {
    const input = { ...query(), filters: [{ field: "id", operator, value: "a" }] };
    await expect(client.queryPage(input as ReturnType<typeof query>)).rejects.toMatchObject({ code: "input" });
    expect(fixture.auth).toBe(0); expect(fixture.calls).toHaveLength(0);
  } finally { client.close(); }
});
it("rejects conflicting offsets, unsafe numbers and malformed Unicode without credential work", async () => {
  const fixture = new Fixture(), client = new AthenaNativeClient({ source, transport: fixture });
  try {
    await expect(client.queryPage(query(1), { offset: 0 })).rejects.toMatchObject({ code: "input" });
    await expect(client.queryPage({ ...query(), filters: [{ field: "amount", operator: "==", value: 9007199254740992 }] })).rejects.toMatchObject({ code: "input" });
    await expect(client.queryPage({ ...query(), filters: [{ field: "id", operator: "==", value: "\ud800" }] })).rejects.toBeInstanceOf(Error);
    expect(fixture.auth).toBe(0); expect(fixture.calls).toHaveLength(0);
  } finally { client.close(); }
});
