import { DAY, latestResults, protocol, qualifies, valid } from "./adaptive.js";
import { parseState } from "./selection-store.js";
/** Local evidence report; catalog availability can only be established by the host. */
export function managementStatus(
  text: string,
  policy: { enabled?: boolean },
  installation: { phase?: string; build?: string },
  now = Date.now(),
) {
  const state = parseState(text);
  const current = latestResults(state.results).filter((r) => valid(r, [r.candidate], now));
  const policyEnabled = policy.enabled === true;
  const installationActive = installation.phase === "active";
  const installationMatchesBuild = installation.build === protocol.split(":")[1];
  const cooldownUntil = (state.cooldownUntil ?? 0) > now ? state.cooldownUntil : undefined;
  const selected = current.find((r) => r.candidate.key === state.incumbent);
  return {
    protocol,
    status: state.status,
    policyEnabled,
    installationActive,
    installationMatchesBuild,
    cooldownUntil,
    catalogAvailability: "unknown; not checked",
    reviewer:
      policyEnabled && installationActive && installationMatchesBuild && !cooldownUntil
        ? selected?.candidate
        : undefined,
    qualificationCalls30Days: state.spend.filter((t) => now - t < 30 * DAY).length,
    historicalPasses: state.results.filter(qualifies).length,
    currentEvidence: current.map((r) => ({
      model: r.candidate.modelID,
      tested: r.tested,
      authorized: r.authorized,
      required: r.required,
      medianMs: r.medianMs,
    })),
  };
}
