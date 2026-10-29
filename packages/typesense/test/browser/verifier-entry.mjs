// Dedicated browser bundle for the real internal verifier cadence test. It
// imports the shipped verifier implementation directly so Chromium can isolate
// the verifier's own macrotask yielding from HTTP/body timing. This file is test
// harness only: production code exposes no hook for it.
import { createVerifier, predicateRoot } from "../../dist/structured.js";

globalThis.TypesenseVerifier = { createVerifier, predicateRoot };
