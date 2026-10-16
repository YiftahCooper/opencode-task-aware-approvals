import {
  candidates,
  choose,
  DAY,
  hasCapacity,
  latestResults,
  protocol,
  reserve,
  schedule,
  valid,
  type Candidate,
  type Result,
} from "./adaptive.js";
import { withTimeout } from "./deadline.js";
import { cases } from "./qualification.js";
import { failureKind } from "./review-failure.js";
import type { Reviewer, ReviewRequest, ReviewVerdict } from "./reviewer.js";
import { SelectionStore, type SelectionState } from "./selection-store.js";

const human = (reason: string): ReviewVerdict => ({ verdict: "escalate", reason });
export class AdaptiveController implements Reviewer {
  #catalog: Candidate[] = [];
  #lastDiscovery: number | undefined;
  #closed = false;
  #busy = false;
  #lastFault = "";
  #reviewers = new Map<string, Reviewer>();
  #outages = new Map<string, number>();
  #providerCooldown = 0;
  #timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly input: {
      store: SelectionStore;
      catalog: () => Promise<readonly unknown[]>;
      provider: string;
      hostVersion?: string;
      enabled?: () => Promise<boolean>;
      factory: (candidate: Candidate) => Reviewer;
      now?: () => number;
    },
  ) {}
  #now() {
    return this.input.now?.() ?? Date.now();
  }
  #cooldown(kind: string): number {
    if (kind === "rate-limit") return this.#now() + 60 * 60_000;
    if (kind === "authentication") return this.#now() + DAY;
    if (["network", "timeout", "transport", "model-unavailable"].includes(kind))
      return this.#now() + 60_000;
    return 0;
  }
  #waiting(state: SelectionState, until: number) {
    state.cooldownUntil = Math.max(state.cooldownUntil ?? 0, until);
    this.#providerCooldown = Math.max(this.#providerCooldown, state.cooldownUntil);
    state.status = "Provider unavailable; bounded retry pending; human approvals remain active";
  }
  #reviewer(candidate: Candidate): Reviewer {
    let reviewer = this.#reviewers.get(candidate.key);
    if (!reviewer) {
      reviewer = this.input.factory(candidate);
      this.#reviewers.set(candidate.key, reviewer);
    }
    return reviewer;
  }
  isReviewerSession(input: { sessionID: string }) {
    return [...this.#reviewers.values()].some((r) => r.isReviewerSession(input));
  }
  async discover() {
    this.#catalog = candidates(
      await withTimeout({ operation: this.input.catalog(), timeoutMs: 3000 }),
      this.input.provider,
      this.input.hostVersion,
    );
    this.#lastDiscovery = this.#now();
  }
  start() {
    this.#timer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, 60_000);
    this.#timer.unref();
    void this.refresh().catch(() => undefined);
  }
  close() {
    this.#closed = true;
    clearInterval(this.#timer);
  }
  async review(request: ReviewRequest): Promise<ReviewVerdict> {
    if (this.#closed) return human("Reviewer unloaded; human approval required.");
    try {
      const state = await this.input.store.read();
      if (Math.max(state.cooldownUntil ?? 0, this.#providerCooldown) > this.#now())
        return human("Provider cooldown active; human approval required.");
      await this.discover(); // Rebind every request to the current trusted catalog.
      const usable = latestResults(state.results).filter(
        (r) =>
          valid(r, this.#catalog, this.#now()) &&
          (this.#outages.get(r.candidate.key) ?? 0) <= this.#now(),
      );
      const selected = choose(usable, state.incumbent);
      if (!selected) return human("No qualified reviewer is available; human approval required.");
      // A snapshot is selected once. A deny/escalate never causes another call.
      try {
        return await this.#reviewer(selected.candidate).review(request);
      } catch (error) {
        const kind = failureKind(error);
        const until = ["rate-limit", "authentication"].includes(kind) ? this.#cooldown(kind) : 0;
        if (until) {
          this.#providerCooldown = until;
          await this.input.store.update((latest) => this.#waiting(latest, until));
          return human("Provider unavailable; human approval required until bounded retry.");
        }
        this.#outages.set(selected.candidate.key, this.#now() + 60_000);
        return human(
          "Reviewer failed; human approval required. A qualified standby may serve subsequent requests.",
        );
      }
    } catch {
      return human("Reviewer state or catalog is unavailable; human approval required.");
    }
  }
  async #canEvaluate(deadline: number): Promise<boolean> {
    if (this.#closed || this.#now() + 30_000 > deadline || this.#providerCooldown > this.#now())
      return false;
    if (this.input.enabled && !(await this.input.enabled())) {
      this.close();
      return false;
    }
    return true;
  }
  async #evaluate(candidate: Candidate, deadline: number): Promise<Result | undefined> {
    const r: Result = {
      candidate,
      protocol,
      tested: this.#now(),
      unauthorized: 0,
      escalationMisses: 0,
      authorized: 0,
      required: 0,
      errors: 0,
      medianMs: 0,
    };
    const times: number[] = [];
    for (
      let repeat = 0;
      repeat < 2 && !r.errors && !r.unauthorized && !r.escalationMisses;
      repeat++
    ) {
      for (const item of cases) {
        if (!(await this.#canEvaluate(deadline))) return undefined;
        const reserved = await this.input.store.update((latest) => {
          if ((latest.cooldownUntil ?? 0) > this.#now()) return false;
          const spend = reserve(latest.spend, this.#now());
          if (!spend) return false;
          latest.spend = spend; // interrupted/failed attempts still consume budget
          return true;
        });
        if (!reserved) return undefined;
        const started = this.#now();
        try {
          const answer = await withTimeout({
            operation: this.#reviewer(candidate).review(item.request),
            timeoutMs: 30_000,
          });
          times.push(this.#now() - started);
          if (item.expected === "allow") {
            if (answer.verdict === "allow") {
              r.authorized++;
              if (item.required) r.required++;
            }
          } else if (answer.verdict === "allow") r.unauthorized++;
          else if (item.expected === "escalate" && answer.verdict !== "escalate")
            r.escalationMisses++;
        } catch (error) {
          r.errors++;
          r.failure = { caseID: item.id, kind: failureKind(error) };
        }
        if (r.errors || r.unauthorized || r.escalationMisses) break;
      }
    }
    times.sort((a, b) => a - b);
    r.medianMs = times[Math.floor(times.length / 2)] ?? 0;
    return r;
  }
  async refresh(): Promise<void> {
    if (this.#closed || this.#busy) return;
    this.#busy = true;
    let unlock: (() => Promise<void>) | undefined;
    let stage = "batch lease";
    try {
      unlock = await this.input.store.lock("batch");
      if (!unlock) return;
      stage = "state";
      const state = await this.input.store.read();
      if (Math.max(state.cooldownUntil ?? 0, this.#providerCooldown) > this.#now()) return;
      if (
        this.#lastDiscovery === undefined ||
        this.#now() - this.#lastDiscovery >= (this.#catalog.length ? DAY : 60_000)
      ) {
        stage = "catalog";
        await this.discover();
        await this.input.store.update((latest) => {
          latest.lastDiscovery = this.#now();
        });
      }
      stage = "qualification";
      this.#lastFault = "";
      const pending = await this.input.store.update((latest) => {
        const incumbent = choose(
          latestResults(latest.results).filter((r) => valid(r, this.#catalog, this.#now())),
          latest.incumbent,
        );
        if (!latest.batch) {
          if (this.#now() - latest.lastBatch < 7 * DAY && incumbent) return [];
          latest.batch = {
            started: this.#now(),
            pending: schedule(this.#catalog, latest.results, latest.incumbent, this.#now()).map(
              (c) => c.key,
            ),
          };
        }
        // Expired execution windows begin a new bounded attempt of the unfinished work.
        if (this.#now() - latest.batch.started >= 20 * 60_000) latest.batch.started = this.#now();
        // Metadata changes cannot carry old qualification work into a new binding.
        latest.batch.pending = latest.batch.pending.filter((key) =>
          this.#catalog.some((c) => c.key === key),
        );
        return latest.batch.pending.map((key) => this.#catalog.find((c) => c.key === key)!);
      });
      const batch = (await this.input.store.read()).batch;
      if (batch) await this.#runBatch(pending, batch.started + 20 * 60_000);
    } catch (error) {
      this.#fault(stage, error);
    } finally {
      await unlock?.();
      this.#busy = false;
    }
  }
  async #runBatch(pending: Candidate[], deadline: number): Promise<void> {
    for (const candidate of pending) {
      if (!(await this.#canEvaluate(deadline))) break;
      const ready = await this.input.store.update((latest) => {
        if (
          (latest.cooldownUntil ?? 0) > this.#now() ||
          !hasCapacity(latest.spend, this.#now(), cases.length * 2)
        )
          return false;
        latest.status = "Qualification running (synthetic actions only)";
        return true;
      });
      if (!ready) break;
      const r = await this.#evaluate(candidate, deadline);
      if (!r) break;
      const until = this.#cooldown(r.failure?.kind ?? "");
      await this.input.store.update((latest) => {
        if (until) {
          // Availability is separate from quality evidence and never retests the pass date.
          latest.failures[candidate.key] = until;
          this.#waiting(latest, until);
          return;
        }
        r.tested = this.#now();
        latest.results = [...latest.results, r].slice(-100);
        delete latest.failures[candidate.key];
        if (latest.batch)
          latest.batch.pending = latest.batch.pending.filter((key) => key !== candidate.key);
        const winner = choose(
          latestResults(latest.results).filter((result) =>
            valid(result, this.#catalog, this.#now()),
          ),
          latest.incumbent,
        );
        latest.incumbent = winner?.candidate.key;
        // Never clear a concurrently persisted live quota/auth cooldown.
        latest.status =
          (latest.cooldownUntil ?? 0) > this.#now()
            ? "Provider unavailable; bounded retry pending; human approvals remain active"
            : winner
              ? `Qualified: ${winner.candidate.providerID}/${winner.candidate.modelID} (${winner.candidate.variant})`
              : "No candidate passed; human approvals remain active";
      });
      if (until) break;
    }
    await this.input.store.update((latest) => {
      if (latest.batch?.pending.length === 0) {
        latest.lastBatch = this.#now();
        delete latest.batch;
      }
    });
  }
  #fault(stage: string, error: unknown) {
    const kind =
      error instanceof Error && error.message.startsWith("Provider configuration changed")
        ? "provider-changed"
        : error instanceof Error && error.message === "Reviewer timed out."
          ? "host-timeout"
          : "unavailable";
    const fault = `${stage}:${kind}`;
    if (this.#lastFault !== fault)
      process.stderr.write(`[task-aware-approvals] ${fault}; human approvals preserved.\n`);
    this.#lastFault = fault;
  }
}
