// Build first. Publish a fully checked, immutable candidate; never install it.
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, lstat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  digest,
  inventory,
  verifyRelease,
  noSymlinks,
  syncTree,
  syncDirectory,
} from "./artifact.mjs";
import { captureBuild } from "./build-id.mjs";
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const captured = captureBuild(source);
const { build } = captured;
const stamp = JSON.parse(await readFile(join(source, "dist/build.json"), "utf8"));
if (
  stamp.build !== build ||
  JSON.stringify(stamp.files) !==
    JSON.stringify(await inventory(join(source, "dist"), ["build.json"]))
)
  throw new Error("Stale or modified dist; rebuild before packaging");
const destination = resolve(source, "../releases", `${pkg.version}-${build.slice(0, 12)}`);
const scratch = resolve(source, "../.backup-scratch");
await noSymlinks(scratch);
await noSymlinks(dirname(destination));
await mkdir(scratch, { recursive: true, mode: 0o700 });
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
const staging = await mkdtemp(join(scratch, "release-"));
try {
  for (const name of [
    "dist",
    "server.js",
    "package.json",
    "LICENSE",
    "README.md",
    "TASK-AWARE.md",
    "scripts/manage.mjs",
    "scripts/artifact.mjs",
  ]) {
    await mkdir(dirname(join(staging, name)), { recursive: true });
    await cp(join(source, name), join(staging, name), { recursive: true, dereference: false });
  }
  await mkdir(join(staging, "node_modules"));
  for (const name of Object.keys(pkg.dependencies))
    await cp(
      await realpath(join(source, "node_modules", name)),
      join(staging, "node_modules", name),
      { recursive: true, dereference: false },
    );
  const stagedStamp = JSON.parse(await readFile(join(staging, "dist/build.json"), "utf8"));
  if (
    JSON.stringify(stagedStamp) !== JSON.stringify(stamp) ||
    JSON.stringify(await inventory(join(staging, "dist"), ["build.json"])) !==
      JSON.stringify(stamp.files)
  )
    throw new Error("Copied dist differs from captured build stamp");
  for (const name of ["server.js", "package.json", "scripts/manage.mjs", "scripts/artifact.mjs"])
    if (digest(await readFile(join(staging, name))) !== captured.inputs[name])
      throw new Error("Copied production input differs from captured build");
  if (JSON.stringify(captureBuild(source)) !== JSON.stringify(captured))
    throw new Error("Source inputs changed during packaging");
  await writeFile(
    join(staging, "manifest.json"),
    JSON.stringify(
      {
        version: pkg.version,
        build,
        upstream: "ccfe507c7cc7df5af4679aef264365369e778388",
        files: await inventory(staging),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  const candidate = await verifyRelease(staging);
  await syncTree(staging);
  let present = false;
  try {
    await lstat(destination);
    present = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (JSON.stringify(captureBuild(source)) !== JSON.stringify(captured))
    throw new Error("Source inputs changed before publication");
  if (present) {
    const existing = await verifyRelease(destination);
    if (existing.manifestHash !== candidate.manifestHash)
      throw new Error("Different existing release; preserving it");
  } else {
    // Nonempty release directories cannot be replaced by rename; competing complete publishers fail safely.
    await rename(staging, destination);
    await syncDirectory(dirname(destination));
  }
  process.stdout.write(destination + "\n");
} finally {
  await rm(staging, { recursive: true, force: true });
}
