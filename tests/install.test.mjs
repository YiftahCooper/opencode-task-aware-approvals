import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { inventory } from "../scripts/artifact.mjs";
const script = resolve("scripts/manage.mjs");
async function fixture() {
  await mkdir(resolve("../.backup-scratch/installer-tests"), { recursive: true });
  const home = await mkdtemp(resolve("../.backup-scratch/installer-tests/install-"));
  const config = join(home, ".config/opencode/opencode.jsonc");
  await mkdir(join(home, ".config/opencode"), { recursive: true });
  const release = join(home, "release");
  await mkdir(release);
  for (const name of [
    "dist",
    "server.js",
    "package.json",
    "scripts/manage.mjs",
    "scripts/artifact.mjs",
  ]) {
    await mkdir(join(release, name, ".."), { recursive: true });
    await cp(resolve(name), join(release, name), { recursive: true });
  }
  for (const name of ["zod", "jsonc-parser"])
    await cp(resolve("node_modules", name), join(release, "node_modules", name), {
      recursive: true,
      dereference: true,
    });
  const stamp = JSON.parse(await readFile(join(release, "dist/build.json"), "utf8"));
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  await writeFile(
    join(release, "manifest.json"),
    JSON.stringify({ version: pkg.version, build: stamp.build, files: await inventory(release) }),
  );
  const original = {
    permission: { "*": "ask" },
    plugin: ["keep-me"],
    mcp: { keep: { enabled: true } },
  };
  await writeFile(config, JSON.stringify(original));
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
  return { home, config, release, original, run };
}
test("install and rollback preserve permissions, other plugins, MCP and concurrent edits", async () => {
  const f = await fixture();
  try {
    assert.equal(f.run("install", f.release, "a".repeat(64)).status, 0);
    const installed = JSON.parse(await readFile(f.config, "utf8"));
    assert.deepEqual(installed.permission, f.original.permission);
    assert.deepEqual(installed.mcp, f.original.mcp);
    installed.plugin.push("new-user-plugin");
    installed.custom = "new preference";
    await writeFile(f.config, JSON.stringify(installed));
    assert.equal(f.run("rollback").status, 0);
    const rolled = JSON.parse(await readFile(f.config, "utf8"));
    assert.deepEqual(rolled.plugin, ["keep-me", "new-user-plugin"]);
    assert.equal(rolled.custom, "new preference");
  } finally {
    await rm(f.home, { recursive: true });
  }
});
test("refuses a symlinked global config before any installation mutation", async () => {
  const f = await fixture();
  try {
    const target = join(f.home, "other-config");
    await writeFile(target, JSON.stringify(f.original));
    await rm(f.config);
    await symlink(target, f.config);
    const result = f.run("install", f.release, "a".repeat(64));
    assert.notEqual(result.status, 0);
  } finally {
    await rm(f.home, { recursive: true });
  }
});

test("resumes an interrupted registration without losing unrelated settings", async () => {
  const f = await fixture();
  try {
    const state = join(f.home, ".local/state/opencode/task-aware-approvals");
    await mkdir(state, { recursive: true });
    await writeFile(
      join(state, "installation.json"),
      JSON.stringify({
        version: 1,
        release: f.release,
        providerFingerprint: "a".repeat(64),
        phase: "prepared",
      }),
    );
    assert.equal(f.run("install", f.release, "a".repeat(64)).status, 0);
    assert.equal(JSON.parse(await readFile(f.config, "utf8")).plugin.length, 2);
  } finally {
    await rm(f.home, { recursive: true });
  }
});

test("installation adopts qualification and reserved spend before enabling, and can resume", async () => {
  const f = await fixture();
  try {
    // Synthetic evidence ONLY in this disposable HOME, never a live qualification.

    const build = (await readFile("src/build-id.ts", "utf8")).match(/"([a-f0-9]{64})"/)[1];
    const evidence = join(f.home, "synthetic-evidence");
    await mkdir(evidence);
    const state = {
      version: 1,
      generation: 7,
      spend: Array.from({ length: 48 }, (_, i) => Date.now() - 5000 + i),
      results: [
        {
          candidate: {
            key: "fixture",
            providerID: "opencode-go",
            modelID: "gpt-cli-fixture",
            variant: "high",
          },
          protocol: `task-aware-v1:${build}`,
          tested: Date.now(),
          unauthorized: 0,
          escalationMisses: 0,
          authorized: 24,
          required: 12,
          errors: 0,
          medianMs: 1,
        },
      ],
      incumbent: "fixture",
      lastBatch: Date.now(),
      lastDiscovery: Date.now(),
      failures: {},
      status: "Synthetic installer fixture",
    };
    await writeFile(join(evidence, "selection.json"), JSON.stringify(state), { mode: 0o600 });
    await writeFile(
      join(evidence, "trusted.json"),
      JSON.stringify({
        enabled: true,
        providerID: "opencode-go",
        providerFingerprint: "a".repeat(64),
      }),
      { mode: 0o600 },
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.run("install", f.release, "a".repeat(64), evidence);
      assert.equal(result.status, 0, result.stderr);
    }
    const live = JSON.parse(
      await readFile(
        join(f.home, ".local/state/opencode/task-aware-approvals/selection.json"),
        "utf8",
      ),
    );
    assert.deepEqual(live.spend, state.spend);
    assert.deepEqual(live.results, state.results);
    assert.equal(live.generation, 1);
    const configured = JSON.parse(await readFile(f.config, "utf8"));
    assert.deepEqual(configured.permission, f.original.permission);
    await writeFile(
      join(evidence, "trusted.json"),
      JSON.stringify({
        enabled: true,
        providerID: "opencode-go",
        providerFingerprint: "b".repeat(64),
      }),
    );
    assert.notEqual(f.run("install", f.release, "a".repeat(64), evidence).status, 0);
    assert.equal(
      JSON.parse(
        await readFile(
          join(f.home, ".local/state/opencode/task-aware-approvals/installation.json"),
          "utf8",
        ),
      ).phase,
      "active",
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(f.home, ".local/state/opencode/task-aware-approvals/selection.json"),
          "utf8",
        ),
      ),
      live,
    );
  } finally {
    await rm(f.home, { recursive: true });
  }
});

test("preserves JSONC comments/trailing commas and native plugins in an existing JSON config", async () => {
  const f = await fixture();
  try {
    await rm(f.config);
    const config = join(f.home, ".config/opencode/opencode.json");
    await writeFile(
      config,
      '{\n // retain this comment\n "plugins": ["keep-me",],\n "permission": {"*": "ask",},\n}\n',
    );
    const result = f.run("install", f.release, "a".repeat(64));
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(config, "utf8"), /retain this comment/);
    assert.equal(f.run("rollback").status, 0);
    assert.match(await readFile(config, "utf8"), /keep-me/);
    await assert.rejects(readFile(f.config), { code: "ENOENT" });
  } finally {
    await rm(f.home, { recursive: true });
  }
});
test("refuses ambiguous config files and competitors under either plugin key", async () => {
  const f = await fixture();
  try {
    const second = join(f.home, ".config/opencode/opencode.json");
    await writeFile(second, "{}");
    assert.notEqual(f.run("install", f.release, "a".repeat(64)).status, 0);
    await rm(second);
    await writeFile(
      f.config,
      JSON.stringify({ plugins: ["opencode-task-aware-approvals"], plugin: ["keep-me"] }),
    );
    assert.notEqual(f.run("install", f.release, "a".repeat(64)).status, 0);
  } finally {
    await rm(f.home, { recursive: true });
  }
});

test("new config uses native plugins and preserves a manually disabled reviewer on retry", async () => {
  const f = await fixture();
  try {
    await rm(f.config);
    let result = f.run("install", f.release, "a".repeat(64));
    assert.equal(result.status, 0, result.stderr);
    const selected = join(f.home, ".config/opencode/opencode.json");
    assert.deepEqual(JSON.parse(await readFile(selected, "utf8")).plugins, [
      { package: f.release, options: {} },
    ]);
    const trusted = join(f.home, ".config/opencode/task-aware-approvals.json");
    const policy = JSON.parse(await readFile(trusted, "utf8"));
    policy.enabled = false;
    await writeFile(trusted, JSON.stringify(policy));
    result = f.run("install", f.release, "a".repeat(64));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(trusted, "utf8")).enabled, false);
    result = f.run("rollback");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(selected, "utf8")).plugins, []);
  } finally {
    await rm(f.home, { recursive: true });
  }
});
test("refuses competing installers, symlinked state and modified pinned releases", async () => {
  const f = await fixture();
  try {
    const state = join(f.home, ".local/state/opencode/task-aware-approvals");
    await mkdir(join(state, "installer.lock"), { recursive: true });
    assert.match(f.run("install", f.release, "a".repeat(64)).stderr, /lock/i);
    await rm(join(state, "installer.lock"), { recursive: true });
    await writeFile(join(f.release, "server.js"), "changed");
    assert.match(f.run("install", f.release, "a".repeat(64)).stderr, /integrity/i);
    await rm(state, { recursive: true });
    const target = join(f.home, "state-target");
    await mkdir(target);
    await symlink(target, state, "dir");
    assert.match(f.run("install", f.release, "a".repeat(64)).stderr, /symlink/i);
  } finally {
    await rm(f.home, { recursive: true });
  }
});

test("explicit upgrade preserves history, disablement and original backup, and rollback restores the last release", async () => {
  const f = await fixture();
  try {
    let result = f.run("install", f.release, "a".repeat(64));
    assert.equal(result.status, 0, result.stderr);
    const stateDir = join(f.home, ".local/state/opencode/task-aware-approvals");
    const originalBackup = await readFile(join(stateDir, "opencode.before-install.jsonc"), "utf8");
    const trusted = join(f.home, ".config/opencode/task-aware-approvals.json");
    const policy = JSON.parse(await readFile(trusted, "utf8"));
    policy.enabled = false;
    await writeFile(trusted, JSON.stringify(policy));
    const stamp = JSON.parse(await readFile(join(f.release, "dist/build.json"), "utf8"));
    const now = Date.now();
    const oldResult = {
      candidate: {
        key: "old",
        providerID: "opencode-go",
        modelID: "gpt-cli-fixture",
        variant: "high",
      },
      protocol: "old-build",
      tested: now - 1000,
      unauthorized: 0,
      escalationMisses: 0,
      authorized: 24,
      required: 12,
      errors: 0,
      medianMs: 1,
    };
    const oldState = {
      version: 1,
      generation: 1,
      spend: [now - 1000, now - 1000],
      results: [oldResult],
      incumbent: "old",
      lastBatch: now - 1000,
      lastDiscovery: now - 1000,
      failures: {},
      status: "Historical",
    };
    await writeFile(join(stateDir, "selection.json"), JSON.stringify(oldState), { mode: 0o600 });
    const evidence = join(f.home, "upgrade-evidence");
    await mkdir(evidence);
    await writeFile(join(evidence, "trusted.json"), JSON.stringify({ ...policy, enabled: true }), {
      mode: 0o600,
    });
    const fresh = {
      ...oldResult,
      candidate: { ...oldResult.candidate, key: "new" },
      protocol: `task-aware-v1:${stamp.build}`,
      tested: now,
    };
    const state = {
      ...oldState,
      incumbent: "new",
      results: [oldResult, fresh],
      spend: [now - 1000, now],
    };
    await writeFile(join(evidence, "selection.json"), JSON.stringify(state), { mode: 0o600 });
    const replacement = join(f.home, "replacement");
    await cp(f.release, replacement, { recursive: true });
    assert.notEqual(f.run("install", replacement, "a".repeat(64), evidence).status, 0);
    assert.notEqual(f.run("upgrade", replacement, "a".repeat(64), evidence).status, 0);
    assert.equal(
      JSON.parse(await readFile(join(stateDir, "installation.json"), "utf8")).release,
      f.release,
    );
    state.spend = [...oldState.spend, now];
    await writeFile(join(evidence, "selection.json"), JSON.stringify(state), { mode: 0o600 });
    result = f.run("upgrade", replacement, "a".repeat(64), evidence);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(f.config, "utf8")).plugin, [
      "keep-me",
      [replacement, {}],
    ]);
    assert.equal(JSON.parse(await readFile(trusted, "utf8")).enabled, false);
    assert.equal(
      await readFile(join(stateDir, "opencode.before-install.jsonc"), "utf8"),
      originalBackup,
    );
    result = f.run("rollback");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(f.config, "utf8")).plugin, [
      "keep-me",
      [f.release, {}],
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(join(stateDir, "selection.json"), "utf8")).spend,
      state.spend,
    );
    assert.equal(JSON.parse(await readFile(trusted, "utf8")).enabled, false);
  } finally {
    await rm(f.home, { recursive: true });
  }
});

test("prepared upgrade refuses a different target before adoption and rollback restores only the last complete release", async () => {
  const f = await fixture();
  try {
    const installed = f.run("install", f.release, "a".repeat(64));
    assert.equal(installed.status, 0, installed.stderr);
    const stateDir = join(f.home, ".local/state/opencode/task-aware-approvals");
    const receiptPath = join(stateDir, "installation.json");
    const active = JSON.parse(await readFile(receiptPath, "utf8"));
    const second = join(f.home, "b"),
      third = join(f.home, "c");
    await cp(f.release, second, { recursive: true });
    await cp(f.release, third, { recursive: true });
    const prepared = {
      ...active,
      release: second,
      phase: "prepared",
      previous: active,
      previousEnabled: true,
    };
    await writeFile(receiptPath, JSON.stringify(prepared));
    const before = await readFile(f.config, "utf8");
    const rejected = f.run(
      "upgrade",
      third,
      "a".repeat(64),
      join(f.home, "evidence-must-not-be-read"),
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /prepared.*resume|resume.*prepared/i);
    assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), prepared);
    assert.equal(await readFile(f.config, "utf8"), before);
    const rollback = f.run("rollback");
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.deepEqual(JSON.parse(await readFile(f.config, "utf8")).plugin, [
      "keep-me",
      [f.release, {}],
    ]);
    assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).release, f.release);
    await writeFile(receiptPath, JSON.stringify(prepared));
    const resumed = f.run("install", second, "a".repeat(64));
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(JSON.parse(await readFile(f.config, "utf8")).plugin, [
      "keep-me",
      [second, {}],
    ]);
  } finally {
    await rm(f.home, { recursive: true });
  }
});

// Reproduce the prior public inventory/receipt format without using or executing
// an installed artifact. ASCII insertion order intentionally differs from inventory().
async function legacyUpgradeFixture() {
  const f = await fixture();
  const previous = join(f.home, "legacy-release");
  const files = {
    LICENSE: "fixture license\n",
    "TASK-AWARE.md": "fixture legacy documentation\n",
    "dist/index.js": "// fixture legacy entry\n",
    "dist/index.cjs": "// fixture legacy entry\n",
    "dist/task-aware.js": "// fixture predecessor; never executed\n",
    "dist/task-aware.cjs": "// fixture predecessor; never executed\n",
    "node_modules/zod/package.json": JSON.stringify({ name: "zod", version: "4.6.7" }),
    "package.json": JSON.stringify({
      name: "opencode-auto-approval-plugin",
      version: "0.7.0-taskaware.1",
      dependencies: { zod: "4.6.7" },
    }),
    "scripts/manage.mjs": "// fixture predecessor; never executed\n",
    "server.js": "// fixture server\n",
  };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(previous, name, ".."), { recursive: true });
    await writeFile(join(previous, name), bytes);
  }
  const legacyManifest = {
    version: "0.7.0-taskaware.1",
    build: "1".repeat(64),
    upstream: "ccfe507c7cc7df5af4679aef264365369e778388",
    files: Object.fromEntries(
      Object.entries(await inventory(previous)).toSorted(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    ),
  };
  await writeFile(join(previous, "manifest.json"), JSON.stringify(legacyManifest));
  const stateDir = join(f.home, ".local/state/opencode/task-aware-approvals");
  await mkdir(stateDir, { recursive: true });
  const receiptPath = join(stateDir, "installation.json");
  const oldReceipt = {
    version: 1,
    phase: "active",
    release: previous,
    providerFingerprint: "a".repeat(64),
    originalHash: "b".repeat(64),
  };
  await writeFile(receiptPath, JSON.stringify(oldReceipt));
  await writeFile(f.config, JSON.stringify({ ...f.original, plugin: ["keep-me", [previous, {}]] }));
  const trusted = join(f.home, ".config/opencode/task-aware-approvals.json");
  const policy = { enabled: false, providerID: "opencode-go", providerFingerprint: "a".repeat(64) };
  await writeFile(trusted, JSON.stringify(policy));
  const stamp = JSON.parse(await readFile(join(f.release, "dist/build.json"), "utf8"));
  const now = Date.now();
  const oldState = {
    version: 1,
    generation: 1,
    spend: [now - 1],
    results: [],
    lastBatch: now - 1,
    lastDiscovery: now - 1,
    failures: {},
    status: "Fixture prior spend",
  };
  await writeFile(join(stateDir, "selection.json"), JSON.stringify(oldState), { mode: 0o600 });
  const evidence = join(f.home, "fresh-evidence");
  await mkdir(evidence);
  await writeFile(join(evidence, "trusted.json"), JSON.stringify({ ...policy, enabled: true }), {
    mode: 0o600,
  });
  const state = {
    ...oldState,
    spend: [...oldState.spend, now],
    incumbent: "fixture",
    results: [
      {
        candidate: {
          key: "fixture",
          providerID: "opencode-go",
          modelID: "gpt-cli-fixture",
          variant: "high",
        },
        protocol: `task-aware-v1:${stamp.build}`,
        tested: now,
        unauthorized: 0,
        escalationMisses: 0,
        authorized: 24,
        required: 12,
        errors: 0,
        medianMs: 1,
      },
    ],
  };
  await writeFile(join(evidence, "selection.json"), JSON.stringify(state), { mode: 0o600 });
  return {
    ...f,
    previous,
    legacyManifest,
    receiptPath,
    oldReceipt,
    stateDir,
    evidence,
    state,
    trusted,
  };
}

test("legacy inventory upgrade pins and restores the original receipt in active and prepared phases", async () => {
  const f = await legacyUpgradeFixture();
  try {
    // Object insertion order is not part of the inventory's meaning.
    f.legacyManifest.files = Object.fromEntries(
      Object.entries(f.legacyManifest.files).toReversed(),
    );
    await writeFile(join(f.previous, "manifest.json"), JSON.stringify(f.legacyManifest));
    const artifactBefore = await inventory(f.previous);
    const candidate = f.run("install", f.previous, "a".repeat(64), f.evidence);
    assert.notEqual(candidate.status, 0, "Legacy recovery must not relax candidate validation");
    assert.match(candidate.stderr, /Incomplete release manifest/);
    const upgraded = f.run("upgrade", f.release, "a".repeat(64), f.evidence);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
    assert.equal(receipt.previous.artifactFormat, "legacy-inventory-v1");
    assert.match(receipt.previous.manifestHash, /^[a-f0-9]{64}$/);
    assert.equal(receipt.previous.build, f.legacyManifest.build);
    assert.equal(receipt.previous.configKey, "plugin");
    for (const phase of ["active", "prepared"]) {
      await writeFile(f.receiptPath, JSON.stringify({ ...receipt, phase }));
      const rolled = f.run("rollback");
      assert.equal(rolled.status, 0, rolled.stderr);
      assert.deepEqual(JSON.parse(await readFile(f.config, "utf8")).plugin, [
        "keep-me",
        [f.previous, {}],
      ]);
      assert.equal(
        JSON.parse(await readFile(f.receiptPath, "utf8")).originalHash,
        f.oldReceipt.originalHash,
      );
      assert.equal(JSON.parse(await readFile(f.trusted, "utf8")).enabled, false);
      assert.deepEqual(
        JSON.parse(await readFile(join(f.stateDir, "selection.json"), "utf8")).spend,
        f.state.spend,
      );
    }
    assert.deepEqual(await inventory(f.previous), artifactBefore);
  } finally {
    await rm(f.home, { recursive: true });
  }
});

test("unverifiable legacy predecessor refuses upgrade before evidence adoption or prepared writes", async () => {
  const f = await legacyUpgradeFixture();
  try {
    const watched = [f.receiptPath, f.config, f.trusted, join(f.stateDir, "selection.json")];
    const before = await Promise.all(watched.map((path) => readFile(path, "utf8")));
    const server = join(f.previous, "server.js");
    const original = await readFile(server);
    for (const mutation of [
      "tamper",
      "missing",
      "extra",
      "wrong-version",
      "wrong-upstream",
      "invalid-build",
    ]) {
      if (mutation === "tamper") await writeFile(server, "changed");
      if (mutation === "missing") await rm(server);
      if (mutation === "extra") await writeFile(join(f.previous, "unlisted.js"), "extra");
      if (mutation === "wrong-version")
        await writeFile(
          join(f.previous, "manifest.json"),
          JSON.stringify({ ...f.legacyManifest, version: "0.6.0" }),
        );
      if (mutation === "wrong-upstream")
        await writeFile(
          join(f.previous, "manifest.json"),
          JSON.stringify({ ...f.legacyManifest, upstream: "0".repeat(40) }),
        );
      if (mutation === "invalid-build")
        await writeFile(
          join(f.previous, "manifest.json"),
          JSON.stringify({ ...f.legacyManifest, build: [f.legacyManifest.build] }),
        );
      const result = f.run("upgrade", f.release, "a".repeat(64), f.evidence);
      assert.notEqual(result.status, 0, `${mutation}: upgrade must reject invalid predecessor`);
      assert.deepEqual(
        await Promise.all(watched.map((path) => readFile(path, "utf8"))),
        before,
        mutation,
      );
      await writeFile(server, original);
      await rm(join(f.previous, "unlisted.js"), { force: true });
      await writeFile(join(f.previous, "manifest.json"), JSON.stringify(f.legacyManifest));
    }
  } finally {
    await rm(f.home, { recursive: true });
  }
});

test("legacy rollback refuses changed files and a rewritten matching manifest after upgrade", async () => {
  const f = await legacyUpgradeFixture();
  try {
    const upgraded = f.run("upgrade", f.release, "a".repeat(64), f.evidence);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    const watched = [f.receiptPath, f.config, f.trusted, join(f.stateDir, "selection.json")];
    const before = await Promise.all(watched.map((path) => readFile(path, "utf8")));
    await writeFile(join(f.previous, "server.js"), "changed");
    let result = f.run("rollback");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /integrity|changed/i);
    f.legacyManifest.files = await inventory(f.previous, ["manifest.json"]);
    await writeFile(join(f.previous, "manifest.json"), JSON.stringify(f.legacyManifest));
    result = f.run("rollback");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed/i);
    // A prepared upgrade revalidates its pin before resuming evidence adoption.
    const prepared = { ...JSON.parse(before[0]), phase: "prepared" };
    await writeFile(f.receiptPath, JSON.stringify(prepared));
    result = f.run("upgrade", f.release, "a".repeat(64), f.evidence);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed/i);
    before[0] = JSON.stringify(prepared);
    assert.deepEqual(await Promise.all(watched.map((path) => readFile(path, "utf8"))), before);
  } finally {
    await rm(f.home, { recursive: true });
  }
});
