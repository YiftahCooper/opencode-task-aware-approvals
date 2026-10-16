import { createHash } from "node:crypto";
import { lstat, readdir, readFile, open } from "node:fs/promises";
import { join, dirname, resolve, parse } from "node:path";
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function noSymlinks(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Refusing symlinked path");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
export async function inventory(directory, excluded = []) {
  const files = {};
  async function walk(path, prefix = "") {
    for (const item of (await readdir(path, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = prefix + item.name;
      if (excluded.includes(name)) continue;
      if (item.isDirectory()) await walk(join(path, item.name), name + "/");
      else if (item.isFile()) files[name] = digest(await readFile(join(path, item.name)));
      else throw new Error("Artifact contains a symlink or special file");
    }
  }
  await walk(directory);
  return files;
}
export async function verifyRelease(directory) {
  await noSymlinks(directory);
  await noSymlinks(join(directory, "manifest.json"));
  const raw = await readFile(join(directory, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  if (
    !/^[a-f0-9]{64}$/.test(manifest.build) ||
    typeof manifest.version !== "string" ||
    !manifest.files ||
    typeof manifest.files !== "object"
  )
    throw new Error("Invalid release manifest");
  for (const name of [
    "server.js",
    "package.json",
    "scripts/manage.mjs",
    "scripts/artifact.mjs",
    "dist/task-aware.js",
    "dist/task-aware.cjs",
    "dist/build.json",
  ])
    if (!/^[a-f0-9]{64}$/.test(manifest.files[name]))
      throw new Error("Incomplete release manifest");
  if (
    JSON.stringify(await inventory(directory, ["manifest.json"])) !== JSON.stringify(manifest.files)
  )
    throw new Error("Release integrity mismatch");
  const stamp = JSON.parse(await readFile(join(directory, "dist/build.json"), "utf8"));
  if (stamp.build !== manifest.build) throw new Error("Release build mismatch");
  if (
    JSON.stringify(await inventory(join(directory, "dist"), ["build.json"])) !==
    JSON.stringify(stamp.files)
  )
    throw new Error("Release dist differs from build stamp");
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (pkg.version !== manifest.version) throw new Error("Release version mismatch");
  return { ...manifest, manifestHash: digest(raw) };
}
// Recovery only: the original task-aware release predates dist/build.json and
// artifact.mjs. Never use this verifier to admit a new installation candidate.
const isDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export async function verifyLegacyRelease(directory) {
  await noSymlinks(directory);
  await noSymlinks(join(directory, "manifest.json"));
  const raw = await readFile(join(directory, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  if (
    !manifest ||
    Object.keys(manifest).toSorted().join(",") !== "build,files,upstream,version" ||
    manifest.version !== "0.7.0-taskaware.1" ||
    manifest.upstream !== "ccfe507c7cc7df5af4679aef264365369e778388" ||
    !isDigest(manifest.build) ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    throw new Error("Invalid legacy release manifest");
  const entries = Object.entries(manifest.files);
  if (
    entries.some(
      ([name, hash]) =>
        name === "manifest.json" ||
        name.split("/").some((part) => !part || part === "." || part === "..") ||
        name.includes("\\") ||
        !isDigest(hash),
    )
  )
    throw new Error("Invalid legacy release inventory");
  for (const name of [
    "LICENSE",
    "TASK-AWARE.md",
    "server.js",
    "package.json",
    "scripts/manage.mjs",
    "dist/index.js",
    "dist/index.cjs",
    "dist/task-aware.js",
    "dist/task-aware.cjs",
    "node_modules/zod/package.json",
  ])
    if (!Object.hasOwn(manifest.files, name)) throw new Error("Incomplete legacy release manifest");
  if (
    ["dist/build.json", "scripts/artifact.mjs"].some((name) => Object.hasOwn(manifest.files, name))
  )
    throw new Error("Not a legacy inventory release");
  const actual = await inventory(directory, ["manifest.json"]);
  // The old packager used ASCII order; object insertion order is not integrity.
  if (
    Object.keys(actual).length !== entries.length ||
    entries.some(([name, hash]) => actual[name] !== hash)
  )
    throw new Error("Legacy release integrity mismatch");
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (
    pkg.name !== "opencode-auto-approval-plugin" ||
    pkg.version !== manifest.version ||
    pkg.dependencies?.zod !== "4.6.7" ||
    Object.keys(pkg.dependencies).length !== 1
  )
    throw new Error("Legacy release package mismatch");
  return { ...manifest, manifestHash: digest(raw) };
}
export async function verifyPredecessor(directory, format) {
  if (format === undefined) {
    await noSymlinks(join(directory, "manifest.json"));
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    format =
      manifest.version === "0.7.0-taskaware.1" && !manifest.files?.["dist/build.json"]
        ? "legacy-inventory-v1"
        : "build-stamp-v1";
  }
  if (!["legacy-inventory-v1", "build-stamp-v1"].includes(format))
    throw new Error("Unknown predecessor artifact format");
  const manifest = await (format === "legacy-inventory-v1"
    ? verifyLegacyRelease(directory)
    : verifyRelease(directory));
  return { ...manifest, artifactFormat: format };
}
export async function syncDirectory(path) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function syncTree(path) {
  for (const item of await readdir(path, { withFileTypes: true })) {
    const child = join(path, item.name);
    if (item.isDirectory()) await syncTree(child);
    else {
      const file = await open(child, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
  }
  await syncDirectory(path);
}
export async function syncParent(path) {
  await syncDirectory(dirname(path));
}
