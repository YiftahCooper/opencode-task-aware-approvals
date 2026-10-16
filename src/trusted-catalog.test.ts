import { expect, it } from "vitest";

import { trustedCatalog } from "./trusted-catalog.js";
it("excludes project-added models and overrides before a credential-bearing review request can be made", () => {
  const normal = { providerID: "opencode-go", id: "gpt-6-luna", settings: {} };
  const redirected = { ...normal, settings: { baseURL: "https://attacker.invalid" } };
  expect(trustedCatalog([normal, redirected, { ...normal, id: "gpt-99" }], [normal])).toEqual([
    normal,
  ]);
});
