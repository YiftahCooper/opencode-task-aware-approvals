import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { candidates, protocol } from "./adaptive.js";
import { adoptEvidence } from "./installation-evidence.js";
import { SelectionStore } from "./selection-store.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true })));
});
async function fixture() {
  const source = await mkdtemp(join(tmpdir(), "approval-evidence-"));
  directories.push(source);
  const destination = await mkdtemp(join(tmpdir(), "approval-live-"));
  directories.push(destination);
  const store = new SelectionStore(source);
  const state = await store.read();
  const candidate = candidates(
    [
      {
        providerID: "opencode-go",
        id: "gpt-6-luna",
        capabilities: { tools: true },
        variants: [{ id: "high" }],
      },
    ],
    "opencode-go",
    "2.0.30",
  )[0]!;
  state.spend = [Date.now() - 1000, Date.now()];
  state.results = [
    {
      candidate,
      protocol,
      tested: Date.now(),
      unauthorized: 0,
      escalationMisses: 0,
      authorized: 24,
      required: 12,
      errors: 0,
      medianMs: 10,
    },
  ];
  state.incumbent = candidate.key;
  await store.write(state);
  await writeFile(
    join(source, "trusted.json"),
    JSON.stringify({
      enabled: true,
      providerID: "opencode-go",
      providerFingerprint: "a".repeat(64),
    }),
    { mode: 0o600 },
  );
  return {
    source,
    destination,
    store,
    state,
    input: { source, destination, providerFingerprint: "a".repeat(64) },
  };
}
it("adopts passing evidence with its spent-call history exactly once across an interrupted install", async () => {
  const f = await fixture();
  await adoptEvidence(f.input);
  await adoptEvidence(f.input);
  const live = await new SelectionStore(f.destination).read();
  expect(live.spend).toEqual(f.state.spend);
  expect(live.results).toEqual(f.state.results);
  expect(live.incumbent).toBe(f.state.incumbent);
  expect(live.generation).toBe(1);
});
it.each(["provider", "protocol", "expired", "synthetic"])(
  "refuses %s evidence before writing live state",
  async (kind) => {
    const f = await fixture();
    if (kind === "provider") f.input.providerFingerprint = "b".repeat(64);
    if (kind === "protocol") f.state.results[0]!.protocol = "old-build";
    if (kind === "expired") f.state.results[0]!.tested = Date.now() - 15 * 86400_000;
    if (kind === "synthetic") f.state.results[0]!.candidate.modelID = "gpt-fixture";
    if (kind !== "provider") await f.store.write(f.state);
    await expect(adoptEvidence(f.input)).rejects.toThrow();
    expect((await new SelectionStore(f.destination).read()).spend).toHaveLength(0);
  },
);
it("preserves existing live spend instead of overwriting it with a different isolated history", async () => {
  const f = await fixture();
  const live = new SelectionStore(f.destination);
  const before = await live.read();
  before.spend = [Date.now() - 500];
  await live.write(before);
  await expect(adoptEvidence(f.input)).rejects.toThrow(/existing/i);
  expect((await live.read()).spend).toEqual(before.spend);
});
it("uses the latest result and does not revive a superseded pass", async () => {
  const f = await fixture();
  f.state.results.push({ ...f.state.results[0]!, errors: 1 });
  await f.store.write(f.state);
  await expect(adoptEvidence(f.input)).rejects.toThrow(/qualification/i);
});
it("accepts the latest fresh result after expired history", async () => {
  const f = await fixture();
  const fresh = { ...f.state.results[0]! };
  f.state.results[0]!.tested -= 15 * 86400_000;
  f.state.results.push(fresh);
  await f.store.write(f.state);
  await expect(adoptEvidence(f.input)).resolves.toBeUndefined();
});
it("adopts an explicit upgrade history extension preserving duplicate reservations and results", async () => {
  const f = await fixture();
  const live = new SelectionStore(f.destination);
  const before = await live.read();
  const stamp = Date.now() - 1000;
  before.spend = [stamp, stamp];
  before.results = [
    {
      ...f.state.results[0]!,
      protocol: "old-build",
      candidate: { ...f.state.results[0]!.candidate, key: "old-key" },
    },
  ];
  await live.write(before);
  f.state.spend.unshift(stamp, stamp);
  f.state.results.unshift(...before.results);
  await f.store.write(f.state);
  await expect(adoptEvidence({ ...f.input, upgrade: true })).resolves.toBeUndefined();
  expect((await live.read()).spend).toEqual(f.state.spend);
});
it("refuses an upgrade losing duplicate reservations or diverging result history", async () => {
  const f = await fixture();
  const live = new SelectionStore(f.destination);
  const before = await live.read();
  before.spend = [f.state.spend[0]!, f.state.spend[0]!];
  await live.write(before);
  await expect(adoptEvidence({ ...f.input, upgrade: true })).rejects.toThrow(/history/i);
});
