import { expect, it, vi } from "vitest";

import { fingerprint } from "./adaptive.js";

const { review } = vi.hoisted(() => ({
  review: vi.fn(async () => ({ verdict: "allow", reason: "fixture" })),
}));
vi.mock("./adaptive-controller.js", () => ({
  AdaptiveController: class {
    review = review;
    start() {}
    close() {}
  },
}));
vi.mock("./selection-store.js", async (original) => ({
  ...(await original<object>()),
  safeRead: async () =>
    JSON.stringify({
      enabled: true,
      providerID: "opencode-go",
      providerFingerprint: fingerprint({ fixture: true }),
    }),
}));

import plugin from "./task-aware.js";

it.each([
  { observedPrompt: true, change: undefined },
  { observedPrompt: true, change: "session.model.selected" },
  { observedPrompt: false, change: undefined },
  { observedPrompt: false, change: "session.model.selected" },
  { observedPrompt: false, change: "session.permissions" },
  { observedPrompt: false, change: "session.instructions.updated" },
])(
  "binds permission authority before asynchronous host history reads ($observedPrompt / $change)",
  async ({ observedPrompt, change }) => {
    review.mockClear();
    const hooks = new Map<string, Array<(event: any) => Promise<void> | void>>();
    const register = (name: string, hook: (event: any) => Promise<void> | void) => {
      hooks.set(name, [...(hooks.get(name) ?? []), hook]);
      return Promise.resolve({ dispose: async () => {} });
    };
    let releaseHistory!: (value: unknown[]) => void;
    let historyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      historyStarted = resolve;
    });
    let nextEvent!: (event: any) => void;
    let observed!: () => void;
    const observedEvent = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const events = {
      async *[Symbol.asyncIterator]() {
        yield await new Promise((resolve) => {
          nextEvent = resolve;
        });
        observed();
        await new Promise(() => {});
      },
    };
    const context = {
      options: {},
      location: { directory: "/fixture" },
      app: { version: "fixture" },
      provider: { get: async () => ({ data: { fixture: true } }) },
      model: { list: async () => ({ data: [] }) },
      agent: { transform: async () => {} },
      session: {
        hook: register,
        get: async () => ({ id: "root", model: { providerID: "opencode-go", id: "gpt-fixture" } }),
        context: vi
          .fn()
          .mockImplementationOnce(() => {
            historyStarted();
            return new Promise((resolve) => {
              releaseHistory = resolve;
            });
          })
          .mockResolvedValue([{ type: "user", text: "Run tests" }]),
      },
      permission: { hook: (name: string, hook: any) => register(`permission.${name}`, hook) },
      event: { subscribe: () => events },
    };
    const close = await plugin.setup(context as never);
    try {
      if (observedPrompt)
        for (const hook of hooks.get("prompt")!)
          await hook({ sessionID: "root", prompt: { text: "Run tests" } });
      const event = {
        sessionID: "root",
        action: "shell",
        resources: ["npm test"],
        metadata: {},
        effect: "ask",
      };
      const pending = hooks.get("permission.evaluate")![0]!(event);
      await started;
      // A host authority event can occur and settle before guardedReview starts.
      if (change) {
        nextEvent({ type: change, data: { sessionID: "root" } });
        await observedEvent;
      }
      releaseHistory([{ type: "user", text: "Run tests" }]);
      await pending;
      expect(event.effect).toBe(change ? "ask" : "allow");
      expect(review).toHaveBeenCalledTimes(change ? 0 : 1);
    } finally {
      await (close as () => Promise<void>)();
    }
  },
);
