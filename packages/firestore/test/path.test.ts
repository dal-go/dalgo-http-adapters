import { collection, key } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { firestoreCollectionPath, keyFromDocumentPath } from "../src/index.js";

describe("Firestore path mapping", () => {
  it("maps nested DALgo collections to Firestore collection paths", () => {
    const items = collection("items", { parent: key("spaces", "s1") });
    expect(firestoreCollectionPath(items.source)).toBe("spaces/s1/items");
  });

  it("maps Firestore document paths back to hierarchical DALgo keys", () => {
    const item = keyFromDocumentPath("spaces/s1/items/i1");
    expect(item.id).toBe("i1");
    expect(item.parent?.id).toBe("s1");
    expect(item.path).toBe("spaces/s1/items/i1");
  });

  it("rejects collection paths where a document path is required", () => {
    expect(() => keyFromDocumentPath("spaces/s1/items")).toThrow("invalid Firestore document path");
  });
});
