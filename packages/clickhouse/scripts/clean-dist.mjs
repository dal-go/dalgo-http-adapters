// Never let stale output from the private prototype enter a public tarball.
import { rmSync } from "node:fs";
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
