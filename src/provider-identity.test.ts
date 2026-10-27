import { describe, expect, it } from "vitest";

import { fingerprint } from "./adaptive.js";
import { providerIdentity } from "./provider-identity.js";

const live = {
  id: "opencode-go",
  integrationID: "opencode-go",
  name: "OpenCode Go",
  activation: "auto",
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: "https://opencode.ai/inference/go/openai/v1" },
  headers: {},
  env: ["OPENCODE_API_KEY"],
  models: { "gpt-6-luna": { cost: { input: 0.1 } } },
};

describe("providerIdentity", () => {
  it("is stable across volatile metadata churn (host upgrades, catalog refreshes)", () => {
    const upgraded = {
      ...live,
      name: "OpenCode Go (renamed)",
      activation: "manual",
      complete: true,
      models: { "gpt-6-luna": { cost: { input: 0.2 } }, "gpt-7-orion": {} },
    };
    expect(fingerprint(providerIdentity(upgraded))).toBe(fingerprint(providerIdentity(live)));
  });
  it("changes when routing or substitution-relevant fields change", () => {
    const mutations = [
      { ...live, id: "evil-provider" },
      { ...live, integrationID: "other" },
      { ...live, package: "@evil/adapter" },
      { ...live, settings: { baseURL: "https://attacker.example/v1" } },
      { ...live, settings: { baseURL: live.settings.baseURL, extra: "x" } },
      { ...live, headers: { "X-Inject": "1" } },
      { ...live, env: ["OPENCODE_API_KEY", "EXTRA"] },
    ];
    for (const m of mutations)
      expect(fingerprint(providerIdentity(m))).not.toBe(fingerprint(providerIdentity(live)));
  });
  it("normalizes env given as an object and ignores key order", () => {
    const objectEnv = { ...live, env: { OPENCODE_API_KEY: "redacted" } };
    expect(fingerprint(providerIdentity(objectEnv))).toBe(fingerprint(providerIdentity(live)));
    const reordered = {
      ...live,
      settings: { baseURL: live.settings.baseURL },
      headers: { a: "1", b: "2" },
    };
    const reordered2 = { ...reordered, headers: { b: "2", a: "1" } };
    expect(fingerprint(providerIdentity(reordered))).toBe(
      fingerprint(providerIdentity(reordered2)),
    );
  });
  it("never includes credential values", () => {
    const withSecret = { ...live, headers: { Authorization: "Bearer secret" } };
    const withOtherSecret = { ...live, headers: { Authorization: "Bearer other" } };
    expect(fingerprint(providerIdentity(withSecret))).toBe(
      fingerprint(providerIdentity(withOtherSecret)),
    );
  });
  it("tolerates missing and malformed provider objects", () => {
    expect(() => providerIdentity(undefined)).not.toThrow();
    expect(() => providerIdentity(null)).not.toThrow();
    expect(() => providerIdentity({})).not.toThrow();
    expect(providerIdentity(undefined).settingKeys).toEqual([]);
  });
});
