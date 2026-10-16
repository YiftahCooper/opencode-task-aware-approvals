import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export function captureBuild(root = ".") {
  const files = [
    ...readdirSync(`${root}/src`)
      .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "build-id.ts")
      .map((n) => `src/${n}`),
    ...readdirSync(`${root}/scripts`)
      .filter((n) => n.endsWith(".mjs"))
      .map((n) => `scripts/${n}`),
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "server.js",
    "tsdown.config.ts",
    "tsconfig.json",
    "mise.toml",
  ].toSorted();
  const hash = createHash("sha256");
  const inputs = {};
  for (const name of files) {
    const bytes = readFileSync(`${root}/${name}`);
    hash.update(JSON.stringify([name, bytes.length])).update(bytes);
    inputs[name] = createHash("sha256").update(bytes).digest("hex");
  }
  return { build: hash.digest("hex"), inputs };
}
export function computeBuild(root = ".") {
  return captureBuild(root).build;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  writeFileSync(
    "src/build-id.ts",
    `// Generated from production source, loaders, package and build inputs.\nexport const buildID = "${computeBuild()}";\n`,
  );
