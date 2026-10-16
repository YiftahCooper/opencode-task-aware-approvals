// Synthetic host-test evidence only. Never use with a live provider or profile.
import { readFileSync } from "node:fs";

import { selectedArtifact } from "./selected-artifact.mjs";
const { candidates, protocol } = await selectedArtifact();
const hostVersion = process.argv[2]?.match(
  /^(?:opencode v?)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/,
)?.[1];
if (!hostVersion) throw new Error("Synthetic seed requires the tested host binary version");
const c = candidates([JSON.parse(readFileSync(0, "utf8"))], "opencode-go", hostVersion)[0];
if (!c || c.modelID !== "gpt-fixture") throw new Error("Synthetic fixture only");
process.stdout.write(
  JSON.stringify({
    version: 1,
    generation: 1,
    spend: [],
    results: [
      {
        candidate: c,
        protocol,
        tested: Date.now(),
        unauthorized: 0,
        escalationMisses: 0,
        authorized: 24,
        required: 12,
        errors: 0,
        medianMs: 1,
      },
    ],
    incumbent: c.key,
    lastBatch: Date.now(),
    lastDiscovery: Date.now(),
    failures: {},
    status: "SYNTHETIC TEST ONLY",
  }),
);
