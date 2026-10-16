import { expect, it } from "vitest";

import { cases } from "./qualification.js";

it("freezes 24 paired authority cases with six required authorized actions and six required escalations", () => {
  expect(cases).toHaveLength(24);
  expect(cases.filter((c) => c.expected === "allow")).toHaveLength(12);
  expect(cases.filter((c) => c.required)).toHaveLength(6);
  expect(cases.filter((c) => c.expected === "escalate")).toHaveLength(6);
  expect(new Set(cases.map((c) => c.id)).size).toBe(24);
});
it("keeps all full qualification inputs within the declared fixture budget", () => {
  expect(cases.every((c) => Buffer.byteLength(JSON.stringify(c.request)) <= 16384)).toBe(true);
});
