import { selectedArtifact } from "./selected-artifact.mjs";
const { candidates, fingerprint, protocol } = await selectedArtifact();
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
process.stdout.write(
  JSON.stringify({
    protocol,
    hostVersion: input.hostVersion,
    providerFingerprint: fingerprint(input.provider),
    providerMetadata: {
      id: input.provider.id,
      integrationID: input.provider.integrationID,
      name: input.provider.name,
      activation: input.provider.activation,
      package: input.provider.package,

      settingKeys: Object.keys(input.provider.settings ?? {}),
      headerNames: Object.keys(input.provider.headers ?? {}),
    },
    candidates: candidates(input.models, "opencode-go", input.hostVersion),
  }),
);
