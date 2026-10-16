import { expect, it } from "vitest";

import { failureKind } from "./review-failure.js";
it.each([
  ["Reviewer configuration changed before invocation", "binding"],
  ["Reviewer session failed: API error 401 unauthorized token=private", "authentication"],
  ["Reviewer session failed: HTTP 429 rate limit", "rate-limit"],
  ["Reviewer session failed: ENOTFOUND private.example", "network"],
  ["Reviewer response did not contain JSON.", "format"],
  ["Reviewer timed out.", "timeout"],
])(
  "reports a controlled failure category without retaining the error message",
  (message, expected) => expect(failureKind(new Error(message))).toBe(expected),
);
it("recognizes the actual Go quota response without retaining its message", () =>
  expect(failureKind(new Error("Reviewer session failed: Go usage limit exceeded"))).toBe(
    "rate-limit",
  ));
