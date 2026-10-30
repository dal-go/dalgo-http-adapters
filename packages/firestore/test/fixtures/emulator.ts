// Shared Firestore emulator setup of the TugQL pushdown tests. They use their
// own named database, so clearing it never touches other emulator tests.
import { deleteApp, initializeApp } from "firebase/app";
import { connectFirestoreEmulator, doc, getFirestore, terminate, writeBatch, type Firestore } from "firebase/firestore";
import type { Documents } from "./items.js";

const HOST = "127.0.0.1";
const PORT = 8089;
const PROJECT = "demo-dalgo-js-e2e";

export interface EmulatorDatabase {
  readonly firestore: Firestore;
  /** Deletes every document of the database, then writes `documents`. */
  reset(documents: Documents): Promise<void>;
  close(): Promise<void>;
}

export function emulatorDatabase(databaseId: string): EmulatorDatabase {
  const app = initializeApp({ projectId: PROJECT }, `tugql-pushdown-${databaseId}`);
  const firestore = getFirestore(app, databaseId);
  connectFirestoreEmulator(firestore, HOST, PORT);
  return {
    firestore,
    async reset(documents) {
      const url = `http://${HOST}:${PORT.toString()}/emulator/v1/projects/${PROJECT}/databases/${databaseId}/documents`;
      const response = await fetch(url, { method: "DELETE" });
      if (!response.ok) throw new Error(`emulator reset failed: ${response.status.toString()}`);
      const entries = [...documents];
      for (let start = 0; start < entries.length; start += 400) {
        const batch = writeBatch(firestore);
        for (const [path, data] of entries.slice(start, start + 400)) batch.set(doc(firestore, path), data);
        await batch.commit();
      }
    },
    async close() {
      await terminate(firestore);
      await deleteApp(app);
    },
  };
}
