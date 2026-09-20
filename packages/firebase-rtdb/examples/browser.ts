import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { collection } from "@dal-go/dalgo";
import { RealtimeDatabase } from "../src/index.js";
interface Todo { done: boolean; title: string; }
const app = initializeApp({ apiKey: "browser-api-key", authDomain: "example.firebaseapp.com", databaseURL: "https://example.firebaseio.com", projectId: "example" });
const todos = collection<Todo>("todos");
const db = new RealtimeDatabase(getDatabase(app));
await db.set(todos.key("first"), { done: false, title: "Use Firebase Auth before this write" });
await db.query(todos.query().orderBy("done").limit(10).build());
