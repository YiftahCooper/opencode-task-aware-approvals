import { readFile, writeFile } from "node:fs/promises";

import { inventory } from "./artifact.mjs";
import { computeBuild } from "./build-id.mjs";
const build = computeBuild();
if (!(await readFile("src/build-id.ts", "utf8")).includes(`"${build}"`))
  throw new Error("Source changed during build");
const { protocol } = await import("../dist/task-aware.js");
if (protocol !== `task-aware-v1:${build}`)
  throw new Error("Built entrypoint does not match source");
await writeFile(
  "dist/build.json",
  JSON.stringify({ build, files: await inventory("dist", ["build.json"]) }, null, 2) + "\n",
);
