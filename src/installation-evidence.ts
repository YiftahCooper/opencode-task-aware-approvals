import { join } from "node:path";

import { DAY, fingerprint, latestResults, valid } from "./adaptive.js";
import { parseState, safeRead, SelectionStore } from "./selection-store.js";

function historyExtends(
  current: import("./selection-store.js").SelectionState,
  evidence: import("./selection-store.js").SelectionState,
): boolean {
  const remaining = [...evidence.spend];
  const preservesSpend = current.spend
    .filter((t) => Date.now() - t < 30 * DAY)
    .every((t) => {
      const index = remaining.indexOf(t);
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    });
  return (
    preservesSpend &&
    evidence.results.length >= current.results.length &&
    current.results.every((r, i) => fingerprint(r) === fingerprint(evidence.results[i])) &&
    evidence.lastBatch >= current.lastBatch &&
    evidence.lastDiscovery >= current.lastDiscovery &&
    (evidence.cooldownUntil ?? 0) >= (current.cooldownUntil ?? 0) &&
    Object.entries(current.failures).every(([key, count]) => (evidence.failures[key] ?? 0) >= count)
  );
}
/** One-time handoff from the isolated real-model run, before enabling the plugin. */
export async function adoptEvidence(input: {
  source: string;
  destination: string;
  providerFingerprint: string;
  upgrade?: boolean;
}): Promise<void> {
  const trusted = JSON.parse(await safeRead(join(input.source, "trusted.json")));
  if (
    trusted.enabled !== true ||
    trusted.providerID !== "opencode-go" ||
    trusted.providerFingerprint !== input.providerFingerprint
  )
    throw new Error("Qualification provider does not match this installation.");
  const evidence = parseState(await safeRead(join(input.source, "selection.json")));
  const selected = latestResults(evidence.results).find(
    (r) => r.candidate.key === evidence.incumbent,
  );
  if (
    !selected ||
    selected.candidate.providerID !== trusted.providerID ||
    selected.candidate.modelID === "gpt-fixture" ||
    !valid(selected, [selected.candidate], Date.now())
  )
    throw new Error("Current real-model qualification evidence is required.");
  const target = new SelectionStore(input.destination);
  const batchUnlock = await target.lock("batch");
  if (!batchUnlock)
    throw new Error("Qualification batch is active; stop the host before installation.");
  let unlock: (() => Promise<void>) | undefined;
  try {
    unlock = await target.lock();
    if (!unlock)
      throw new Error("Installation state is busy; keep approvals manual and retry while idle.");
    const current = await target.read();
    // A prepared install may have completed this copy before being interrupted.
    // Never replace another history or reset calls merely to make activation pass.
    if (fingerprint({ ...current, generation: 0 }) === fingerprint({ ...evidence, generation: 0 }))
      return;
    if (current.generation || current.spend.length || current.results.length) {
      if (!input.upgrade || !historyExtends(current, evidence))
        throw new Error(
          "Existing selection history differs; require a non-diverging history extension preserving reservations.",
        );
    }
    await target.write({ ...evidence, generation: current.generation });
  } finally {
    await unlock?.();
    await batchUnlock();
  }
}
