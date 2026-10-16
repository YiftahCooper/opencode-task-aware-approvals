import { readFileSync } from "node:fs";

import { fingerprint } from "../../src/adaptive.ts";
process.stdout.write(fingerprint(JSON.parse(readFileSync(0, "utf8"))));
