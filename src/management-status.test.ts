import { expect, it } from "vitest";

import { protocol, DAY, type Result } from "./adaptive.js";
import { managementStatus } from "./management-status.js";
import { emptyState } from "./selection-store.js";
const now = 1_800_000_000_000;
const pass: Result = {
  candidate: { key: "key", providerID: "opencode-go", modelID: "gpt-test", variant: "high" },
  protocol,
  tested: now,
  unauthorized: 0,
  escalationMisses: 0,
  errors: 0,
  authorized: 24,
  required: 12,
  medianMs: 10,
};
it("reports only latest current-build fresh passing evidence and unknown catalog availability", () => {
  const state = { ...emptyState(), incumbent: "key", results: [pass, { ...pass, errors: 1 }] };
  const status = managementStatus(
    JSON.stringify(state),
    { enabled: true },
    { phase: "active" },
    now,
  );
  expect(status.currentEvidence).toEqual([]);
  expect(status.historicalPasses).toBe(1);
  expect(status.catalogAvailability).toBe("unknown; not checked");
});
it.each(["expired", "protocol", "future"])("does not call %s evidence current", (kind) => {
  const r = { ...pass };
  if (kind === "expired") r.tested -= 14 * DAY;
  if (kind === "protocol") r.protocol = "old";
  if (kind === "future") r.tested++;
  expect(
    managementStatus(
      JSON.stringify({ ...emptyState(), results: [r] }),
      { enabled: true },
      { phase: "active" },
      now,
    ).currentEvidence,
  ).toEqual([]);
});
it("reports policy disabled, installation disabled and cooldown without claiming an active reviewer", () => {
  const status = managementStatus(
    JSON.stringify({
      ...emptyState(),
      incumbent: "key",
      results: [{ ...pass, tested: now - 15 * DAY }, pass],
      cooldownUntil: now + 1000,
    }),
    { enabled: false },
    { phase: "rolledback" },
    now,
  );
  expect(status.policyEnabled).toBe(false);
  expect(status.installationActive).toBe(false);
  expect(status.cooldownUntil).toBe(now + 1000);
  expect(status.currentEvidence).toHaveLength(1);
  expect(status.reviewer).toBeUndefined();
});
it("rejects malformed persisted state", () => {
  expect(() => managementStatus('{"results":[]}', {}, {})).toThrow();
});
