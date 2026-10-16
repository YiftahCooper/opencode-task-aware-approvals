import { expect, it } from "vitest";

import { constrainReviewerContext } from "./reviewer-context.js";
it("replaces inherited instructions/options and removes tools while enforcing the actual maxTokens key", () => {
  const event = {
    system: [{ type: "text", text: "untrusted repository instructions" }],
    tools: { shell: {} },
    options: { maxTokens: 90000, unsafe: true },
    messages: [],
  };
  constrainReviewerContext(event as never);
  expect(event.tools).toEqual({});
  expect(event.options).toEqual({ maxTokens: 2048 });
  expect(JSON.stringify(event.system)).not.toContain("repository instructions");
});
