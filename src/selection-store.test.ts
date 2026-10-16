import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { SelectionStore } from "./selection-store.js";

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "approvals-"));
  dirs.push(dir);
  return { dir, store: new SelectionStore(dir) };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true })));
});
it("serializes processes and retains reserved spend over restart with atomic prior generation", async () => {
  const { dir, store } = await fixture();
  const release = await store.lock();
  expect(release).toBeTypeOf("function");
  expect(await new SelectionStore(dir).lock()).toBeUndefined();
  const state = await store.read();
  state.spend.push(Date.now());
  await store.write(state);
  await release!();
  expect((await new SelectionStore(dir).read()).spend).toHaveLength(1);
  await store.write(state);
  expect(JSON.parse(await readFile(join(dir, "selection.previous.json"), "utf8")).generation).toBe(
    1,
  );
});
it("does not reset budgets or trust qualifications when persisted state is corrupt", async () => {
  const { dir, store } = await fixture();
  await writeFile(join(dir, "selection.json"), '{"spend":[]}');
  await expect(store.read()).rejects.toThrow();
});
it("requires recovery when current state is missing but prior spend exists", async () => {
  const { dir, store } = await fixture();
  const state = await store.read();
  state.spend.push(Date.now());
  await store.write(state);
  await store.write(state);
  await rm(join(dir, "selection.json"));
  await expect(store.read()).rejects.toThrow(/recovery/i);
});
it("recovers an empty claim from a dead owner without unlinking a new owner's unique claim", async () => {
  const { dir, store } = await fixture();
  await (await import("node:fs/promises")).mkdir(join(dir, "locks"));
  const stale = join(
    dir,
    "locks",
    "claim-2147483647-0-00000000-00000000-0000-0000-0000-000000000000.json",
  );
  await writeFile(stale, "");
  const release = await store.lock();
  expect(release).toBeTypeOf("function");
  const claims = await (await import("node:fs/promises")).readdir(join(dir, "locks"));
  expect(claims).toHaveLength(1);
  expect(claims).not.toContain(stale.split("/").at(-1));
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () => new SelectionStore(dir).lock()),
  );
  expect(attempts.filter(Boolean)).toHaveLength(0);
  await release!();
  const next = await store.lock();
  expect(next).toBeTypeOf("function");
  await next!();
});
it("admits at most one owner when many contenders choose tickets concurrently", async () => {
  const { dir, store } = await fixture();
  const releases = await Promise.all(
    Array.from({ length: 24 }, () => new SelectionStore(dir).lock()),
  );
  expect(releases.filter(Boolean).length).toBeLessThanOrEqual(1);
  await Promise.all(releases.map((release) => release?.()));
  const eventual = await store.lock();
  expect(eventual).toBeTypeOf("function");
  await eventual!();
});
