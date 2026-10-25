import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { AdaptiveController } from "./adaptive-controller.js";
import { DAY, MONTHLY_CALL_CAP, WEEKLY_CALL_CAP } from "./adaptive.js";
import { cases } from "./qualification.js";
import { SelectionStore } from "./selection-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true })));
});
const model = {
  providerID: "opencode-go",
  id: "gpt-6-luna",
  enabled: true,
  capabilities: { tools: true },
  variants: [{ id: "high" }],
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "controller-"));
  dirs.push(dir);
  const store = new SelectionStore(dir);
  const review = vi.fn(
    async (r) =>
      ({
        verdict:
          cases.find((c) => JSON.stringify(c.request) === JSON.stringify(r))?.expected === "allow"
            ? "allow"
            : "escalate",
        reason: "fixture",
      }) as const,
  );
  const catalog = vi.fn(async () => [model]);
  const controller = new AdaptiveController({
    store,
    catalog,
    provider: "opencode-go",
    factory: () => ({ review, isReviewerSession: () => false }),
  });
  return { controller, store, review, catalog };
}
it("qualifies the frozen cases before serving actions, retains spend across controllers", async () => {
  const { controller, store, review } = await fixture();
  expect((await controller.review(cases[0]!.request)).verdict).toBe("escalate");
  await controller.refresh();
  expect((await store.read()).spend).toHaveLength(48);
  expect((await controller.review(cases[0]!.request)).verdict).toBe("allow");
  expect(review).toHaveBeenCalledTimes(49);
  await controller.refresh();
  expect((await store.read()).spend).toHaveLength(48);
  controller.close();
});
it("never tries another model after a valid denial and fails to human on outage", async () => {
  const { controller, review } = await fixture();
  await controller.refresh();
  review.mockResolvedValueOnce({ verdict: "deny", reason: "no" } as never);
  expect((await controller.review(cases[0]!.request)).verdict).toBe("deny");
  expect(review).toHaveBeenCalledTimes(49);
  review.mockRejectedValueOnce(new Error("provider unavailable"));
  expect((await controller.review(cases[0]!.request)).verdict).toBe("escalate");
  expect(review).toHaveBeenCalledTimes(50);
  controller.close();
});
it("invalidates changed metadata, respects call budget and stops when unloaded", async () => {
  const { controller, store, catalog, review } = await fixture();
  await controller.refresh();
  catalog.mockResolvedValue([{ ...model, enabled: false }]);
  await controller.discover();
  expect((await controller.review(cases[0]!.request)).verdict).toBe("escalate");
  const s = await store.read();
  s.spend = Array.from({ length: WEEKLY_CALL_CAP }, () => Date.now());
  await store.write(s);
  await controller.refresh();
  expect(review).toHaveBeenCalledTimes(48);
  controller.close();
  expect((await controller.review(cases[0]!.request)).verdict).toBe("escalate");
});
it("preserves a passing incumbent and its tested date when a regression is deferred for monthly budget", async () => {
  const { controller, store, review } = await fixture();
  await controller.refresh();
  const state = await store.read();
  const old = Date.now() - 8 * 86400_000;
  state.results[0]!.tested = old;
  state.lastBatch = old;
  state.spend = Array.from(
    { length: MONTHLY_CALL_CAP },
    (_, i) => Date.now() - (8 + (i % 20)) * 86400_000,
  );
  await store.write(state);
  await controller.refresh();
  const after = await store.read();
  expect(after.incumbent).toBe(state.incumbent);
  expect(after.results[0]!.tested).toBe(old);
  expect(review).toHaveBeenCalledTimes(48);
  controller.close();
});
it("returns human approval when catalog loading hangs", async () => {
  vi.useFakeTimers();
  try {
    const { emptyState } = await import("./selection-store.js");
    const controller = new AdaptiveController({
      store: { read: async () => emptyState() } as never,
      catalog: () => new Promise(() => {}),
      provider: "opencode-go",
      factory: () => ({
        review: async () => ({ verdict: "allow", reason: "no" }),
        isReviewerSession: () => false,
      }),
    });
    const pending = controller.review(cases[0]!.request);
    await vi.advanceTimersByTimeAsync(3001);
    expect((await pending).verdict).toBe("escalate");
    controller.close();
  } finally {
    vi.useRealTimers();
  }
});
it("uses a qualified standby only on a subsequent action after an outage", async () => {
  const { controller, review, catalog } = await fixture();
  catalog.mockResolvedValue([model, { ...model, id: "gpt-5.6-luna" }]);
  await controller.refresh();
  expect(review).toHaveBeenCalledTimes(96);
  review.mockRejectedValueOnce(new Error("retired or unavailable"));
  expect((await controller.review(cases[0]!.request)).verdict).toBe("escalate");
  expect(review).toHaveBeenCalledTimes(97);
  expect((await controller.review(cases[0]!.request)).verdict).toBe("allow");
  expect(review).toHaveBeenCalledTimes(98);
  controller.close();
});
it("persists one provider cooldown after a quota failure and avoids trying every model", async () => {
  const { controller, store, review, catalog } = await fixture();
  catalog.mockResolvedValue([model, { ...model, id: "claude-haiku-5-5" }]);
  review.mockRejectedValue(new Error("Reviewer session failed: Go usage limit exceeded"));
  await controller.refresh();
  expect(review).toHaveBeenCalledTimes(1);
  const state = await store.read();
  expect(state.cooldownUntil).toBeGreaterThan(Date.now());
  await controller.refresh();
  expect(review).toHaveBeenCalledTimes(1);
  expect((await controller.review(cases[0]!.request)).verdict).toBe("escalate");
  controller.close();
});
it("retries after the quota cooldown across a controller restart without losing spend", async () => {
  const { controller, store, review, catalog } = await fixture();
  review.mockRejectedValueOnce(new Error("Go usage limit exceeded"));
  await controller.refresh();
  const waiting = await store.read();
  expect(waiting.results).toHaveLength(0);
  controller.close();
  let now = Date.now();
  const resumed = new AdaptiveController({
    store,
    catalog,
    provider: "opencode-go",
    now: () => now,
    factory: () => ({ review, isReviewerSession: () => false }),
  });
  await resumed.refresh();
  expect(review).toHaveBeenCalledTimes(1);
  now = waiting.cooldownUntil! + 1;
  await resumed.refresh();
  expect(review).toHaveBeenCalledTimes(49);
  expect((await store.read()).spend).toHaveLength(49);
  expect((await resumed.review(cases[0]!.request)).verdict).toBe("allow");
  resumed.close();
});
it("persists a live quota outage without invalidating prior qualification or trying a standby", async () => {
  const { controller, store, review, catalog } = await fixture();
  catalog.mockResolvedValue([model, { ...model, id: "gpt-5.6-luna" }]);
  await controller.refresh();
  const qualified = await store.read();
  review.mockRejectedValueOnce(new Error("Go usage limit exceeded"));
  expect((await controller.review(cases[0]!.request)).verdict).toBe("escalate");
  expect((await controller.review(cases[0]!.request)).verdict).toBe("escalate");
  expect(review).toHaveBeenCalledTimes(97);
  const waiting = await store.read();
  expect(waiting.cooldownUntil).toBeGreaterThan(Date.now());
  expect(waiting.results).toEqual(qualified.results);
  controller.close();
});

it.each(["fetch failed: ENOTFOUND", "Reviewer timed out."])(
  "preserves incumbent evidence during transient %s requalification",
  async (message) => {
    const { controller, store, review } = await fixture();
    await controller.refresh();
    const state = await store.read();
    state.lastBatch = Date.now() - 8 * DAY;
    state.results[0]!.tested = state.lastBatch;
    await store.write(state);
    const prior = structuredClone(state.results);
    review.mockRejectedValueOnce(new Error(message));
    await controller.refresh();
    const waiting = await store.read();
    expect(waiting.results).toEqual(prior);
    expect(waiting.cooldownUntil).toBeGreaterThan(Date.now());
    expect(waiting.spend).toHaveLength(49);
    await controller.refresh();
    expect(review).toHaveBeenCalledTimes(49);
    controller.close();
  },
);
it("resumes the later candidate after cooldown rather than completing the week early", async () => {
  const { controller, store, review, catalog } = await fixture();
  catalog.mockResolvedValue([model, { ...model, id: "gpt-5.6-luna" }]);
  const answer = review.getMockImplementation()!;
  review.mockImplementation(async (request) => {
    if (review.mock.calls.length === 49) throw new Error("Go usage limit exceeded");
    return answer(request);
  });
  await controller.refresh();
  const waiting = await store.read();
  expect(waiting.lastBatch).toBe(0);
  expect(waiting.results).toHaveLength(1);
  controller.close();
  const resumed = new AdaptiveController({
    store,
    catalog,
    provider: "opencode-go",
    now: () => waiting.cooldownUntil! + 1,
    factory: () => ({ review, isReviewerSession: () => false }),
  });
  await resumed.refresh();
  const after = await store.read();
  expect(after.results).toHaveLength(2);
  expect(after.spend).toHaveLength(97);
  expect(after.lastBatch).toBeGreaterThan(waiting.lastBatch);
  resumed.close();
});
it("defers a candidate unless all 48 calls fit the remaining budget", async () => {
  const { controller, store, review } = await fixture();
  const state = await store.read();
  state.spend = Array.from({ length: WEEKLY_CALL_CAP - 24 }, () => Date.now());
  await store.write(state);
  await controller.refresh();
  expect(review).not.toHaveBeenCalled();
  expect((await store.read()).spend).toHaveLength(WEEKLY_CALL_CAP - 24);
  controller.close();
});
it("persists live quota while qualification is held and merges results and spend across controllers", async () => {
  const { controller, store, review, catalog } = await fixture();
  await controller.refresh();
  const state = await store.read();
  state.lastBatch = Date.now() - 8 * DAY;
  state.results[0]!.tested = state.lastBatch;
  await store.write(state);
  const prior = structuredClone(state.results);
  let release!: (value: Awaited<ReturnType<typeof review>>) => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    started = resolve;
  });
  review.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const qualifying = controller.refresh();
  await held;
  const competitor = new AdaptiveController({
    store: new SelectionStore(store.directory),
    catalog,
    provider: "opencode-go",
    factory: () => ({ review, isReviewerSession: () => false }),
  });
  await competitor.refresh();
  expect(review).toHaveBeenCalledTimes(49);
  competitor.close();
  const live = new AdaptiveController({
    store: new SelectionStore(store.directory),
    catalog,
    provider: "opencode-go",
    factory: () => ({
      review: async () => {
        throw new Error("Go usage limit exceeded");
      },
      isReviewerSession: () => false,
    }),
  });
  try {
    expect((await live.review(cases[0]!.request)).verdict).toBe("escalate");
    live.close();
    const persisted = await store.read();
    expect(persisted.cooldownUntil).toBeGreaterThan(Date.now());
    expect(persisted.results).toEqual(prior);
    const restarted = new AdaptiveController({
      store,
      catalog,
      provider: "opencode-go",
      factory: () => ({ review, isReviewerSession: () => false }),
    });
    expect((await restarted.review(cases[0]!.request)).verdict).toBe("escalate");
    await restarted.refresh();
    expect(review).toHaveBeenCalledTimes(49);
    restarted.close();
  } finally {
    release({ verdict: "allow", reason: "fixture" });
    await qualifying;
    controller.close();
  }
  expect((await store.read()).spend).toHaveLength(49);
  expect((await store.read()).results).toEqual(prior);
});

it.each(["invalid JSON verdict", "unsafe"])(
  "retains historical results but invalidates the incumbent on %s quality evidence",
  async (kind) => {
    const { controller, store, review } = await fixture();
    await controller.refresh();
    const state = await store.read();
    state.lastBatch = Date.now() - 8 * DAY;
    state.results[0]!.tested = state.lastBatch;
    await store.write(state);
    if (kind === "unsafe") review.mockResolvedValue({ verdict: "allow", reason: "fixture" });
    else review.mockRejectedValue(new Error(kind));
    await controller.refresh();
    const after = await store.read();
    expect(after.results).toHaveLength(2);
    expect(after.results[0]).toEqual(state.results[0]);
    expect(after.incumbent).toBeUndefined();
    expect((await controller.review(cases[0]!.request)).verdict).toBe("escalate");
    controller.close();
  },
);
