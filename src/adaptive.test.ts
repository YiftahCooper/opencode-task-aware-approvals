import { describe, expect, it } from "vitest";

import {
  candidates,
  qualifies,
  choose,
  reserve,
  valid,
  fingerprint,
  protocol,
  MONTHLY_CALL_CAP,
  WEEKLY_CALL_CAP,
} from "./adaptive.js";

const model = (id = "gpt-6-luna") => ({
  providerID: "opencode-go",
  id,
  enabled: true,
  capabilities: { tools: true },
  variants: [{ id: "high" }],
});
const now = 1_800_000_000_000;
const candidate = () => candidates([model()], "opencode-go")[0]!;
const result = (overrides = {}) => ({
  candidate: candidate(),
  tested: now,
  protocol,
  unauthorized: 0,
  escalationMisses: 0,
  authorized: 24,
  required: 12,
  errors: 0,
  medianMs: 1000,
  ...overrides,
});

describe("adaptive qualification", () => {
  it("only considers enabled GPT models on the trusted provider with explicit high variant", () => {
    expect(
      candidates(
        [
          model(),
          model("claude-haiku-5-5"),
          model("glm-5"),
          { ...model(), providerID: "evil" },
          { ...model(), enabled: false },
          { ...model(), variants: [] },
        ],
        "opencode-go",
      ),
    ).toHaveLength(1);
  });
  it("fingerprints metadata and protocol, without depending on object key order", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint(model())).not.toBe(fingerprint({ ...model(), settings: { changed: true } }));
  });
  it.each([
    { unauthorized: 1 },
    { escalationMisses: 1 },
    { errors: 1 },
    { required: 11 },
    { authorized: 21 },
  ])("rejects a failed safety/usefulness gate %j", (override) =>
    expect(qualifies(result(override))).toBe(false),
  );
  it("accepts only complete two-repeat evidence", () => expect(qualifies(result())).toBe(true));
  it("retains incumbent on inconclusive latency changes", () => {
    const incumbent = result();
    const challenger = result({
      candidate: { ...candidate(), modelID: "claude-haiku-5-5", key: "another" },
      medianMs: 900,
    });
    expect(choose([incumbent, challenger], incumbent.candidate.key)?.candidate.key).toBe(
      incumbent.candidate.key,
    );
    expect(
      choose([incumbent, { ...challenger, medianMs: 750 }], incumbent.candidate.key)?.candidate.key,
    ).toBe("another");
  });
  it("expires qualifications and invalidates changed catalog or protocol", () => {
    expect(valid(result(), [candidate()], now)).toBe(true);
    expect(valid(result(), [], now)).toBe(false);
    expect(valid(result(), [candidate()], now + 15 * 86400_000)).toBe(false);
    expect(valid(result({ protocol: "old" }), [candidate()], now)).toBe(false);
  });
  it("reserves failed/interrupted calls durably and respects rolling weekly/monthly caps", () => {
    const spend = Array.from({ length: WEEKLY_CALL_CAP }, () => now);
    expect(reserve(spend, now)).toBeUndefined();
    expect(reserve(spend, now + 8 * 86400_000)).toHaveLength(WEEKLY_CALL_CAP + 1);
    expect(
      reserve(
        Array.from({ length: MONTHLY_CALL_CAP }, (_, i) => now - (8 + (i % 20)) * 86400_000),
        now,
      ),
    ).toBeUndefined();
  });
});
it("schedules never-tested and oldest candidates after reserving one incumbent regression slot", async () => {
  const { schedule } = await import("./adaptive.js");
  const list = ["gpt-9", "gpt-8", "gpt-7", "claude-new"].map((modelID, i) => ({
    ...candidate(),
    modelID,
    key: String(i),
  }));
  const results = list
    .slice(0, 3)
    .map((c, i) => result({ candidate: c, tested: now - (8 + i) * 86400_000 }));
  expect(schedule(list, results, "0", now).map((c) => c.modelID)).toEqual([
    "gpt-9",
    "claude-new",
    "gpt-7",
  ]);
});
it("invalidates a qualified configuration when the OpenCode host version changes", () => {
  expect(candidates([model()], "opencode-go", "2.0.30")[0]!.key).not.toBe(
    candidates([model()], "opencode-go", "2.0.31")[0]!.key,
  );
});
