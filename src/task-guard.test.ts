import { expect, it, vi } from "vitest";

import { cases } from "./qualification.js";
import { guardedReview, TaskEpochs } from "./task-guard.js";
const state = () => ({
  session: { id: "root" },
  messages: [{ type: "user", text: "Run tests" }],
  epoch: 0,
  requestEpoch: 0,
});
it("does not treat a delegated session as independent user authority", async () => {
  const review = vi.fn(async () => ({ verdict: "allow", reason: "yes" }) as const);
  const answer = await guardedReview(cases[0]!.request, {
    load: async () => ({ ...state(), session: { id: "child", parentID: "root" } }),
    review,
    closed: () => false,
  });
  expect(answer.verdict).toBe("escalate");
  expect(review).not.toHaveBeenCalled();
});
it.each(["interrupted", "changed", "closed"])("rejects a stale %s approval", async (kind) => {
  let after = false;
  const answer = await guardedReview(cases[0]!.request, {
    load: async () => ({
      ...state(),
      epoch: after && kind === "interrupted" ? 1 : 0,
      messages:
        after && kind === "changed"
          ? [{ type: "user", text: "Do not run tests" }]
          : state().messages,
    }),
    review: async () => {
      after = true;
      return { verdict: "allow", reason: "yes" };
    },
    closed: () => after && kind === "closed",
  });
  expect(answer.verdict).toBe("escalate");
});
const allow = async () => ({ verdict: "allow", reason: "yes" }) as const;
it("allows a current action and fails to human on missing history", async () => {
  expect(
    (
      await guardedReview(cases[0]!.request, {
        load: async () => state(),
        review: allow,
        closed: () => false,
      })
    ).verdict,
  ).toBe("allow");
  expect(
    (
      await guardedReview(cases[0]!.request, {
        load: async () => {
          throw new Error("missing");
        },
        review: allow,
        closed: () => false,
      })
    ).verdict,
  ).toBe("escalate");
});

it("accepts fresh prompt authority with retained interrupted outcome", async () => {
  const answer = await guardedReview(cases[0]!.request, {
    load: async () => ({
      ...state(),
      session: { id: "root", outcome: "interrupted" },
      epoch: 3,
      requestEpoch: 3,
      authority: { prompt: 3, interrupt: 2 },
    }),
    review: allow,
    closed: () => false,
  });
  expect(answer.verdict).toBe("allow");
});
it("allows a fresh trusted prompt despite a retained interrupted outcome", async () => {
  const epochs = new TaskEpochs();
  epochs.prompt("root", "Run tests");
  epochs.interrupt("root");
  epochs.prompt("root", "Run tests");
  const requestEpoch = epochs.capture("root");
  const answer = await guardedReview(
    { ...cases[0]!.request, sessionID: "root", userIntent: "Run tests" },
    {
      load: async () => ({
        ...state(),
        session: { id: "root", outcome: "interrupted" },
        ...epochs.snapshot("root", requestEpoch),
      }),
      review: allow,
      closed: () => false,
    },
  );
  expect(answer.verdict).toBe("allow");
});
it.each(["late", "during-review", "synthetic"])(
  "rejects interrupted authority: %s",
  async (mode) => {
    const epochs = new TaskEpochs();
    epochs.prompt("root", "Run tests");
    const requestEpoch = epochs.capture("root");
    if (mode !== "during-review") epochs.interrupt("root");
    if (mode === "late") epochs.prompt("root", "Run tests");
    if (mode === "synthetic") epochs.prompt("root", "Run tests", { synthetic: true });
    const answer = await guardedReview(
      { ...cases[0]!.request, sessionID: "root", userIntent: "Run tests" },
      {
        load: async () => ({
          ...state(),
          session: { id: "root", outcome: "interrupted" },
          ...epochs.snapshot("root", requestEpoch),
        }),
        review: async () => {
          epochs.interrupt("root");
          return allow();
        },
        closed: () => false,
      },
    );
    expect(answer.verdict).toBe("escalate");
  },
);

it("requires a fresh trusted prompt for interrupted resumed history", async () => {
  const epochs = new TaskEpochs();
  const review = vi.fn(allow);
  const answer = await guardedReview(cases[0]!.request, {
    load: async () => ({
      ...state(),
      session: { id: "root", outcome: "interrupted" },
      ...epochs.snapshot("root", epochs.capture("root")),
    }),
    review,
    closed: () => false,
  });
  expect(answer.verdict).toBe("escalate");
  expect(review).not.toHaveBeenCalled();
});
