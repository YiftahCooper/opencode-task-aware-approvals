import { readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
/** Use one selected compiled artifact for all candidate identities and seed evidence. */
export async function selectedArtifact() {
  const root =
    process.env.TASK_AWARE_PLUGIN_PATH ||
    process.env.TASK_AWARE_RELEASE ||
    resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const selected = await import(pathToFileURL(join(root, "dist/task-aware.js")).href);
  const stamp = JSON.parse(await readFile(join(root, "dist/build.json"), "utf8"));
  if (
    selected.protocol !== `task-aware-v1:${stamp.build}` ||
    typeof selected.candidates !== "function" ||
    typeof selected.fingerprint !== "function"
  )
    throw new Error(
      "Selected artifact does not expose matching qualification identity helpers; rebuild it",
    );
  return selected;
}
