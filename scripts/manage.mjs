import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse, modify, applyEdits } from "jsonc-parser";

import { digest, noSymlinks, verifyRelease, verifyPredecessor, syncParent } from "./artifact.mjs";
const directory = join(homedir(), ".local/state/opencode/task-aware-approvals");
const configDirectory = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
const trusted = join(homedir(), ".config/opencode/task-aware-approvals.json");
const receipt = join(directory, "installation.json");
const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function read(path, fallback) {
  await noSymlinks(path);
  return (await exists(path)) ? readFile(path, "utf8") : fallback;
}
async function atomic(path, text) {
  await noSymlinks(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    await noSymlinks(path);
    await rename(temporary, path);
    await syncParent(path);
  } finally {
    await rm(temporary, { force: true });
  }
}
function document(text) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid JSON/JSONC config");
  for (const key of ["plugin", "plugins"])
    if (value[key] !== undefined && !Array.isArray(value[key]))
      throw new Error("Invalid plugin registrations");
  return value;
}
const registration = (item) =>
  Array.isArray(item) ? item[0] : typeof item === "object" && item ? item.package : item;
export function removeRegistration(value, release, key = "plugin") {
  return { ...value, [key]: (value[key] ?? []).filter((item) => registration(item) !== release) };
}
function edit(text, key, items) {
  return applyEdits(
    text,
    modify(text, [key], items, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  );
}
async function configPath(record) {
  const paths = [join(configDirectory, "opencode.json"), join(configDirectory, "opencode.jsonc")];
  for (const path of paths) await noSymlinks(path);
  const found = [];
  for (const path of paths) if (await exists(path)) found.push(path);
  if (found.length > 1)
    throw new Error("Ambiguous opencode.json and opencode.jsonc; select one before installation");
  if (record?.configPath && !paths.includes(record.configPath))
    throw new Error("Recorded config path differs from selected configuration directory");
  if (record?.configPath && found.length && found[0] !== record.configPath)
    throw new Error("Active config changed since installation");
  return record?.configPath ?? found[0] ?? paths[0];
}
async function unchanged(path, before) {
  if ((await read(path, "{}\n")) !== before)
    throw new Error("Global config changed during installation; external-editor conflict detected");
}
async function pinPrevious(previous, config) {
  if (previous.phase !== "active")
    throw new Error("Upgrade rollback target must be a completed installation");
  const manifest = await verifyPredecessor(previous.release, previous.artifactFormat);
  if (
    (previous.manifestHash && previous.manifestHash !== manifest.manifestHash) ||
    (previous.build && previous.build !== manifest.build)
  )
    throw new Error("Prior release changed; cannot restore it");
  return {
    ...previous,
    version: 2,
    artifactFormat: manifest.artifactFormat,
    manifestHash: manifest.manifestHash,
    build: manifest.build,
    configPath: previous.configPath ?? config,
    configKey: previous.configKey ?? "plugin",
  };
}
async function status() {
  const { managementStatus, protocol } = await import(
    pathToFileURL(join(ownRoot, "dist/task-aware.js")).href
  );
  if (await exists(join(ownRoot, "src"))) {
    const { computeBuild } = await import("./build-id.mjs");
    if (protocol !== `task-aware-v1:${computeBuild(ownRoot)}`)
      throw new Error("Source build is stale; rebuild before reporting current evidence");
  } else await verifyRelease(ownRoot);
  const record = JSON.parse(await read(receipt, "{}"));
  const policy = JSON.parse(await read(trusted, "{}"));
  const state = await read(join(directory, "selection.json"));
  process.stdout.write(
    JSON.stringify(
      state
        ? managementStatus(state, policy, record)
        : {
            protocol,
            status: "No selection state",
            policyEnabled: policy.enabled === true,
            installationActive: record.phase === "active",
            catalogAvailability: "unknown; not checked",
          },
      null,
      2,
    ) + "\n",
  );
}
// Ordered transaction: validate -> evidence -> prepared receipt -> policy -> registration -> active receipt.
// oxlint-disable-next-line complexity
async function install(command, releaseArg, fingerprint, evidenceDirectory) {
  if (!releaseArg || !/^[a-f0-9]{64}$/.test(fingerprint ?? ""))
    throw new Error(
      "install/upgrade requires a verified release path and trusted provider fingerprint",
    );
  await noSymlinks(releaseArg);
  const release = await realpath(releaseArg),
    manifest = await verifyRelease(release);
  const prior = JSON.parse(await read(receipt, "null"));
  const upgrade = command === "upgrade";
  if (
    prior?.phase === "prepared" &&
    (prior.release !== release || prior.providerFingerprint !== fingerprint)
  )
    throw new Error(
      "Prepared transaction must resume its exact release/provider or roll back first",
    );
  if (prior?.previous && prior.previous.phase !== "active")
    throw new Error("Previous installation is not complete; explicit recovery required");
  if (upgrade && (!prior || prior.providerFingerprint !== fingerprint || !evidenceDirectory))
    throw new Error(
      "Upgrade requires prior installation, same trusted provider and fresh matching evidence",
    );
  if (
    prior &&
    (prior.providerFingerprint !== fingerprint || (!upgrade && prior.release !== release))
  )
    throw new Error("A different installation exists; use explicit upgrade with fresh evidence");
  if (
    prior?.release === release &&
    prior.manifestHash &&
    prior.manifestHash !== manifest.manifestHash
  )
    throw new Error("Recorded release integrity changed");
  const config = await configPath(prior);
  const before = await read(config, "{}\n");
  const value = document(before);
  const predecessor = upgrade && prior.release !== release ? prior : prior?.previous;
  // Establish usable rollback before evidence adoption or any prepared writes.
  const previous = predecessor ? await pinPrevious(predecessor, config) : undefined;
  const owned = new Set([
    prior?.release ?? release,
    ...(prior?.phase === "prepared" && prior.previous ? [prior.previous.release] : []),
  ]);
  let next = before;
  for (const key of ["plugin", "plugins"]) {
    const without = (value[key] ?? []).filter(
      (item) => !owned.has(registration(item)) && registration(item) !== release,
    );
    if (
      without.some((p) =>
        /permission-reviewer|auto-approval-plugin|auto-permissions|opencode-task-aware-approvals/.test(
          JSON.stringify(p),
        ),
      )
    )
      throw new Error("An approver is already registered; refusing competing approval plugins");
    if (without.length !== (value[key] ?? []).length) next = edit(next, key, without);
  }
  const key =
    prior?.configKey ??
    (value.plugins !== undefined ? "plugins" : value.plugin !== undefined ? "plugin" : "plugins");
  const current = document(next);
  // Native V2 config uses package objects; the compatibility key uses legacy tuples.
  next = edit(next, key, [
    ...(current[key] ?? []),
    key === "plugins" ? { package: release, options: {} } : [release, {}],
  ]);
  const policy = JSON.parse(await read(trusted, "null"));
  if (
    policy &&
    (!prior || policy.providerFingerprint !== fingerprint || policy.providerID !== "opencode-go")
  )
    throw new Error("Unrelated trusted reviewer configuration exists; preserving it");
  const enabled = policy ? policy.enabled === true : true;
  if (evidenceDirectory) {
    const { adoptEvidence } = await import(pathToFileURL(join(release, "dist/task-aware.js")).href);
    await adoptEvidence({
      source: evidenceDirectory,
      destination: directory,
      providerFingerprint: fingerprint,
      upgrade,
    });
  }
  if (!prior) await atomic(join(directory, "opencode.before-install.jsonc"), before);
  const record = {
    version: 2,
    release,
    build: manifest.build,
    manifestHash: manifest.manifestHash,
    artifactFormat: "build-stamp-v1",
    providerFingerprint: fingerprint,
    configPath: config,
    configKey: key,
    originalHash: prior?.originalHash ?? digest(before),
    previous,
    previousEnabled: previous ? (prior.previousEnabled ?? enabled) : undefined,
  };
  await atomic(receipt, JSON.stringify({ ...record, phase: "prepared" }));
  await atomic(
    trusted,
    JSON.stringify({ enabled, providerID: "opencode-go", providerFingerprint: fingerprint }),
  );
  await unchanged(config, before);
  await atomic(config, next);
  await atomic(receipt, JSON.stringify({ ...record, phase: "active" }));
  process.stdout.write(
    "Registered pinned task-aware plugin; native permissions and unrelated settings preserved.\n",
  );
}
async function rollback() {
  const record = JSON.parse(await read(receipt, "null"));
  if (!record) throw new Error("No installation receipt");
  const config = await configPath(record),
    before = await read(config, "{}\n");
  const key = record.configKey ?? "plugin";
  const value = document(before);
  let next = edit(before, key, removeRegistration(value, record.release, key)[key]);
  const previous = record.previous ? await pinPrevious(record.previous, config) : undefined;
  if (previous) {
    const previousKey = previous.configKey ?? "plugin";
    const items = removeRegistration(document(next), previous.release, previousKey)[previousKey];
    next = edit(next, previousKey, [
      ...items,
      previousKey === "plugins"
        ? { package: previous.release, options: {} }
        : [previous.release, {}],
    ]);
  }
  await unchanged(config, before);
  await atomic(config, next);
  const policy = JSON.parse(await read(trusted, "null"));
  if (policy?.providerFingerprint === record.providerFingerprint)
    await atomic(
      trusted,
      JSON.stringify({
        ...policy,
        enabled: record.previous
          ? policy.enabled === true && record.previousEnabled === true
          : false,
      }),
    );
  await atomic(
    receipt,
    JSON.stringify(
      previous ? { ...previous, phase: "active" } : { ...record, phase: "rolledback" },
    ),
  );
  process.stdout.write(
    record.previous
      ? "Restored previous registration; retained all qualification spend.\n"
      : "Removed owned registration and disabled reviewer; unrelated settings preserved.\n",
  );
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "status") return status();
  if (!["install", "upgrade", "rollback"].includes(command))
    throw new Error(
      "Usage: node scripts/manage.mjs status | install RELEASE FINGERPRINT [EVIDENCE] | upgrade RELEASE FINGERPRINT EVIDENCE | rollback",
    );
  for (const path of [directory, trusted, receipt]) await noSymlinks(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "installer.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Installer lock exists; another install or interrupted transaction requires inspection",
        { cause: error },
      );
    throw error;
  }
  try {
    return await (command === "rollback" ? rollback() : install(command, ...args));
  } finally {
    await rm(lock, { recursive: true });
    await syncParent(lock);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
