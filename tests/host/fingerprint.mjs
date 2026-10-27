import { readFileSync } from "node:fs";

import { fingerprint } from "../../src/adaptive.ts";
import { providerIdentity } from "../../src/provider-identity.ts";
process.stdout.write(fingerprint(providerIdentity(JSON.parse(readFileSync(0, "utf8")))));
