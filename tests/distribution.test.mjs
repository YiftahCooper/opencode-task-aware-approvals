import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { test } from "node:test";
const root = resolve(".");
const scratch = resolve("../.backup-scratch/distribution-tests");
await mkdir(scratch, { recursive: true });
test("public ESM, CJS and server entries select the fixed task-aware plugin", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const esm = await import(pkg.name);
  const server = await import("../server.js");
  const fixed = await import("../dist/task-aware.js");
  const cjs = createRequire(import.meta.url)(pkg.name);
  assert.equal(esm.default, fixed.default);
  assert.equal(server.default, fixed.default);
  assert.equal(cjs.default.id, "opencode-task-aware-approvals");
  assert.deepEqual(esm.configuration, fixed.configuration);
});
test("all production build/loader/installer inputs change build identity", async () => {
  const home = await mkdtemp(join(scratch, "identity-"));
  try {
    await cp(root, join(home, "plugin"), {
      recursive: true,
      filter: (p) =>
        !["node_modules", ".git", "dist", ".backup-scratch"].includes(p.split("/").at(-1)),
    });
    const cwd = join(home, "plugin");
    const build = () => {
      const r = spawnSync(process.execPath, ["scripts/build-id.mjs"], { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return readFile(join(cwd, "src/build-id.ts"), "utf8");
    };
    const before = await build();
    for (const name of [
      "server.js",
      "tsdown.config.ts",
      "tsconfig.json",
      "mise.toml",
      "scripts/package.mjs",
      "scripts/manage.mjs",
      "scripts/build-id.mjs",
    ]) {
      const path = join(cwd, name),
        original = await readFile(path, "utf8");
      await writeFile(path, original + "\n// identity change\n");
      assert.notEqual(await build(), before, name);
      await writeFile(path, original);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("packaging verifies dist, stages atomically, reuses only identical releases and includes management inventory", async () => {
  const home = await mkdtemp(join(scratch, "package-"));
  try {
    const cwd = join(home, "plugin");
    await cp(root, cwd, {
      recursive: true,
      filter: (p) => !["node_modules", ".git", ".backup-scratch"].includes(p.split("/").at(-1)),
    });
    await symlink(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    const run = () =>
      spawnSync(process.execPath, ["scripts/package.mjs"], { cwd, encoding: "utf8" });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    const release = r.stdout.trim();
    const manifest = JSON.parse(await readFile(join(release, "manifest.json"), "utf8"));
    for (const name of [
      "README.md",
      "TASK-AWARE.md",
      "scripts/manage.mjs",
      "dist/task-aware.js",
      "server.js",
      "node_modules/jsonc-parser/package.json",
    ])
      assert.ok(manifest.files[name], name);
    r = run();
    assert.equal(r.status, 0, r.stderr);
    await writeFile(join(release, "server.js"), "partial");
    assert.notEqual(run().status, 0);
    assert.equal(await readFile(join(release, "server.js"), "utf8"), "partial");
    await writeFile(join(cwd, "server.js"), "stale source");
    assert.notEqual(run().status, 0);
    assert.equal((await readdir(join(home, "releases"))).length, 1);
    assert.deepEqual(
      (await readdir(join(home, ".backup-scratch"))).filter((x) => x.startsWith("release-")),
      [],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("npm pack inventory and installed package resolver expose the task-aware product", async () => {
  const home = await mkdtemp(join(scratch, "npm-pack-"));
  try {
    const packed = spawnSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", home],
      {
        cwd: root,
        env: {
          ...process.env,
          npm_config_cache: join(scratch, "npm-cache"),
          npm_config_update_notifier: "false",
        },
        encoding: "utf8",
      },
    );
    assert.equal(packed.status, 0, packed.stderr);
    assert.ifError(packed.error);
    const packedInfo = JSON.parse(packed.stdout);
    const info = Array.isArray(packedInfo) ? packedInfo[0] : Object.values(packedInfo)[0];
    const names = info.files.map((f) => f.path);
    for (const name of [
      "server.js",
      "scripts/manage.mjs",
      "scripts/artifact.mjs",
      "TASK-AWARE.md",
      "README.md",
      "LICENSE",
    ])
      assert.ok(names.includes(name), name);
    assert.ok(
      !names.some((name) =>
        /qualification\/|installation.json|trusted.json|\.backup-scratch/.test(name),
      ),
    );
    const extracted = spawnSync("tar", ["-xzf", join(home, info.filename), "-C", home], {
      encoding: "utf8",
    });
    assert.equal(extracted.status, 0, extracted.stderr);
    await mkdir(join(home, "node_modules"), { recursive: true });
    await symlink(
      join(home, "package"),
      join(home, "node_modules", "opencode-task-aware-approvals"),
      "dir",
    );
    await symlink(join(root, "node_modules"), join(home, "package", "node_modules"), "dir");
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict'; import plugin from 'opencode-task-aware-approvals'; import server from './package/server.js'; import {createRequire} from 'node:module'; const cjs=createRequire(import.meta.url)('opencode-task-aware-approvals'); assert.equal(plugin,server); assert.equal(plugin.id,'opencode-task-aware-approvals'); assert.equal(cjs.default.id,plugin.id);`,
      ],
      { cwd: home, encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.ifError(probe.error);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("packaging rejects copy-boundary mutations even when source is restored and preserves completed releases", async () => {
  const home = await mkdtemp(join(scratch, "copy-race-"));
  try {
    const cwd = join(home, "plugin");
    await cp(root, cwd, {
      recursive: true,
      filter: (p) => !["node_modules", ".git", ".backup-scratch"].includes(p.split("/").at(-1)),
    });
    await symlink(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    const run = (preload) =>
      spawnSync(
        process.execPath,
        [...(preload ? ["--import", preload] : []), "scripts/package.mjs"],
        { cwd, encoding: "utf8" },
      );
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const destination = first.stdout.trim(),
      release = join(home, "releases", "preserved");
    await cp(destination, release, { recursive: true });
    await rm(destination, { recursive: true });
    const before = await readFile(join(release, "manifest.json"), "utf8");
    for (const target of [
      "dist/task-aware.js",
      "server.js",
      "scripts/manage.mjs",
      "src/task-guard.ts",
    ]) {
      const preload = join(home, "copy-boundary.mjs");
      await writeFile(
        preload,
        `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';const original=fs.cp;let changed=false;fs.cp=async function(source,dest,options){if(!changed && String(source).endsWith('/dist')){changed=true;const path=join(process.cwd(),${JSON.stringify(target)});const before=await fs.readFile(path);await fs.appendFile(path,'\\n// controlled packaging mutation\\n');try{return await original(source,dest,options);}finally{${target === "src/task-guard.ts" ? "" : "await fs.writeFile(path,before);"}}}if(${JSON.stringify(target)}!=='dist/task-aware.js' && ${JSON.stringify(target)}!=='src/task-guard.ts' && String(source).endsWith('/'+${JSON.stringify(target)})){const before=await fs.readFile(source);await fs.appendFile(source,'\\n// copied loader mutation\\n');try{return await original(source,dest,options);}finally{await fs.writeFile(source,before);}}return original(source,dest,options);};syncBuiltinESMExports();`,
      );
      const result = run(preload);
      assert.notEqual(result.status, 0, target);
      assert.equal(await readFile(join(release, "manifest.json"), "utf8"), before);
      await assert.rejects(readFile(join(destination, "manifest.json")), { code: "ENOENT" });
      assert.deepEqual(
        (await readdir(join(home, ".backup-scratch"))).filter((n) => n.startsWith("release-")),
        [],
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("selected distinct build supplies probe and seed identities and completes against its own keys", async () => {
  const home = await mkdtemp(join(scratch, "selected-build-"));
  try {
    const cwd = join(home, "plugin");
    await cp(root, cwd, {
      recursive: true,
      filter: (p) =>
        !["node_modules", ".git", ".backup-scratch", "dist"].includes(p.split("/").at(-1)),
    });
    await symlink(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    const adaptive = join(cwd, "src/adaptive.ts");
    await writeFile(
      adaptive,
      (await readFile(adaptive, "utf8")) + "\n// Distinct selected test build\n",
    );
    const built = spawnSync("corepack", ["pnpm@10.30.3", "build"], {
      cwd,
      env: { ...process.env, COREPACK_HOME: resolve("../.backup-scratch/corepack") },
      encoding: "utf8",
    });
    assert.equal(built.status, 0, built.stderr);
    const model = {
      providerID: "opencode-go",
      id: "gpt-fixture",
      capabilities: { tools: true },
      variants: [{ id: "high" }],
    };
    const input = JSON.stringify({
      provider: { id: "opencode-go" },
      models: [model],
      hostVersion: "2.0.30",
    });
    const probe = (selected) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", "tests/host/catalog-binding.mjs"], {
        cwd: root,
        env: { ...process.env, TASK_AWARE_PLUGIN_PATH: selected ?? "" },
        input,
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const a = probe(),
      b = probe(cwd);
    assert.notEqual(b.candidates[0].key, a.candidates[0].key);
    const selectedBuild = JSON.parse(await readFile(join(cwd, "dist/build.json"), "utf8")).build;
    assert.equal(b.protocol, `task-aware-v1:${selectedBuild}`);
    const seed = spawnSync(process.execPath, ["--import", "tsx", "tests/host/seed.mjs", "2.0.30"], {
      cwd: root,
      env: { ...process.env, TASK_AWARE_PLUGIN_PATH: cwd },
      input: JSON.stringify(model),
      encoding: "utf8",
    });
    assert.equal(seed.status, 0, seed.stderr);
    const state = JSON.parse(seed.stdout);
    assert.equal(state.results[0].candidate.key, b.candidates[0].key);
    assert.equal(state.results[0].protocol, b.protocol);
    const recognized = spawnSync(
      "python3",
      [
        "-c",
        "import json,sys; from qualification_helpers import current_results; v=json.load(sys.stdin); assert len(current_results(v['state'],v['protocol'],set(v['keys'])))==1",
      ],
      {
        cwd: join(root, "tests/host"),
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        input: JSON.stringify({
          state,
          protocol: b.protocol,
          keys: b.candidates.map((c) => c.key),
        }),
        encoding: "utf8",
      },
    );
    assert.equal(recognized.status, 0, recognized.stderr);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("synthetic seed binds the supplied host version and refuses missing identity", async () => {
  const { candidates } = await import("../dist/task-aware.js");
  const model = {
    providerID: "opencode-go",
    id: "gpt-fixture",
    capabilities: { tools: true },
    variants: [{ id: "high" }],
  };
  const seed = (...args) =>
    spawnSync(process.execPath, ["tests/host/seed.mjs", ...args], {
      cwd: root,
      env: { ...process.env, TASK_AWARE_PLUGIN_PATH: root, TASK_AWARE_RELEASE: "" },
      input: JSON.stringify(model),
      encoding: "utf8",
    });
  const keys = [];
  for (const [reported, version] of [
    ["2.0.30", "2.0.30"],
    ["opencode v2.0.99", "2.0.99"],
  ]) {
    const result = seed(reported);
    assert.equal(result.status, 0, result.stderr);
    const candidate = JSON.parse(result.stdout).results[0].candidate;
    assert.equal(candidate.hostVersion, version);
    assert.equal(candidate.key, candidates([model], "opencode-go", version)[0].key);
    keys.push(candidate.key);
  }
  assert.notEqual(keys[0], keys[1]);
  assert.notEqual(seed().status, 0, "Missing host identity must not produce a default seed");
});
