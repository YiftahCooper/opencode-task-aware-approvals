import { describe, expect, it, vi } from "vitest";

import { postJSON } from "./http.js";

describe("postJSON", () => {
  it("sends extra headers without letting them replace the key or the content type", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));

    await postJSON({
      fetch,
      url: "https://api.example/v1",
      apiKey: "real-key",
      body: {},
      headers: {
        "X-Feature": "true",
        Authorization: "Bearer other-key",
        "Content-Type": "text/plain",
      },
      timeoutMs: 1_000,
      label: "Test",
    });

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-feature")).toBe("true");
    expect(headers.get("authorization")).toBe("Bearer real-key");
    expect(headers.get("content-type")).toBe("application/json");
  });
});
