import { fingerprint } from "./adaptive.js";
import { withTimeout } from "./deadline.js";
import type { ReviewRequest, ReviewVerdict } from "./reviewer.js";
export type TaskSnapshot = {
  session: {
    id: string;
    parentID?: string;
    outcome?: string;
    model?: unknown;
    agent?: unknown;
    metadata?: unknown;
    permissions?: unknown;
  };
  messages: unknown[];
  epoch: number;
  requestEpoch: number;
  authority?: { prompt: number; interrupt: number; intent?: string };
};
export async function guardedReview(
  request: ReviewRequest,
  input: {
    load: () => Promise<TaskSnapshot>;
    review: (r: ReviewRequest) => Promise<ReviewVerdict>;
    closed: () => boolean;
  },
): Promise<ReviewVerdict> {
  const human: ReviewVerdict = {
    verdict: "escalate",
    reason: "Task authority changed or is unavailable; human approval required.",
  };
  try {
    const before = await withTimeout({ operation: input.load(), timeoutMs: 1000 });
    if (
      input.closed() ||
      before.session.parentID ||
      before.requestEpoch !== before.epoch ||
      (before.authority &&
        (before.authority.interrupt >= before.authority.prompt ||
          (before.authority.intent !== undefined &&
            before.authority.intent !== request.userIntent))) ||
      (before.session.outcome === "interrupted" &&
        (!before.authority || before.authority.prompt <= before.authority.interrupt)) ||
      !request.userIntent?.trim()
    )
      return human;
    const decision = await withTimeout({ operation: input.review(request), timeoutMs: 28_000 });
    if (decision.verdict !== "allow") return decision;
    const after = await withTimeout({ operation: input.load(), timeoutMs: 1000 });
    if (input.closed() || fingerprint(before) !== fingerprint(after)) return human;
    return decision;
  } catch {
    return human;
  }
}

/** Authority comes only from host prompt hooks and interrupt events, never model text. */
export class TaskEpochs {
  #sessions = new Map<
    string,
    { epoch: number; prompt: number; interrupt: number; intent?: string }
  >();
  #state(sessionID: string) {
    let state = this.#sessions.get(sessionID);
    if (!state) {
      state = { epoch: 0, prompt: 0, interrupt: 0 };
      this.#sessions.set(sessionID, state);
    }
    return state;
  }
  capture(sessionID: string): number {
    return this.#state(sessionID).epoch;
  }
  change(sessionID: string): void {
    this.#state(sessionID).epoch++;
  }
  interrupt(sessionID: string): void {
    const state = this.#state(sessionID);
    state.interrupt = ++state.epoch;
  }
  prompt(sessionID: string, text: string, metadata?: Record<string, unknown>): void {
    if (metadata?.synthetic || metadata?.ignored) return;
    const state = this.#state(sessionID);
    state.prompt = ++state.epoch;
    state.intent = text;
  }
  snapshot(
    sessionID: string,
    requestEpoch: number,
  ): Pick<TaskSnapshot, "epoch" | "requestEpoch" | "authority"> {
    const state = this.#state(sessionID);
    return {
      epoch: state.epoch,
      requestEpoch,
      ...(state.prompt || state.interrupt
        ? {
            authority: {
              prompt: state.prompt,
              interrupt: state.interrupt,
              intent: state.intent,
            },
          }
        : {}),
    };
  }
}
