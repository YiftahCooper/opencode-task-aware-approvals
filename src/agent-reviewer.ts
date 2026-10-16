import type { PluginConfiguration } from "./config.js";
import { withTimeout } from "./deadline.js";
import {
  OversizeError,
  parseVerdict,
  type Reviewer,
  type ReviewRequest,
  type ReviewSessionClient,
  type ReviewVerdict,
  reviewCheck,
  reviewerPrompt,
} from "./reviewer.js";

export const reviewerAgentName = "auto-approval-reviewer";

export const reviewerAgentDescription = "Read-only reviewer for auto-approval decisions.";

export const reviewerAgentPrompt =
  "You are a security reviewer. You may inspect the workspace only through read, glob, grep, and lsp. Never modify files, run shell commands, access the network, use MCP tools, or delegate work.";

/** The only tools the reviewer may call; everything else is denied. */
export const reviewerAllowedTools = ["read", "glob", "grep", "lsp"] as const;

export class AgentReviewer implements Reviewer {
  readonly #client: ReviewSessionClient;
  readonly #configuration: PluginConfiguration;
  readonly #reviewerSessionIDs = new Set<string>();

  constructor(input: { client: ReviewSessionClient; configuration: PluginConfiguration }) {
    this.#client = input.client;
    this.#configuration = input.configuration;
  }

  isReviewerSession(input: { sessionID: string }): boolean {
    return this.#reviewerSessionIDs.has(input.sessionID);
  }

  async review(input: ReviewRequest): Promise<ReviewVerdict> {
    const check = reviewCheck();
    const text = reviewerPrompt({
      request: input,
      instructions: this.#configuration.reviewer.instructions,
      check,
    });
    const { maxInputBytes } = this.#configuration.reviewer.agent;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxInputBytes) {
      // An over-long prompt would be compacted or cut by the session, and the
      // reviewer would judge a summary.
      throw new OversizeError(
        `Operation too large for the agent reviewer (${bytes.toLocaleString("en-US")} bytes, limit ${maxInputBytes.toLocaleString("en-US")}).`,
      );
    }
    const deadline = Date.now() + this.#configuration.reviewer.timeoutMs;
    let expired = false;
    const creating = this.#client.create({
      model: this.#configuration.reviewer.agent.model ?? input.model,
    });
    void creating
      .then(async ({ sessionID }) => {
        if (!expired) return;
        await withTimeout({
          operation: this.#client.abort({ sessionID }).catch(() => undefined),
          timeoutMs: 2000,
        }).catch(() => undefined);
        await withTimeout({
          operation:
            this.#client.remove?.({ sessionID }).catch(() => undefined) ?? Promise.resolve(),
          timeoutMs: 2000,
        }).catch(() => undefined);
      })
      .catch(() => undefined);
    let sessionID: string;
    try {
      sessionID = (await withTimeout({ operation: creating, timeoutMs: deadline - Date.now() }))
        .sessionID;
    } catch (error) {
      expired = true;
      throw error;
    }
    this.#reviewerSessionIDs.add(sessionID);

    try {
      const response = await withTimeout({
        operation: this.#client.prompt({ sessionID, text }),
        timeoutMs: deadline - Date.now(),
      });
      return parseVerdict(response, check);
    } catch (error) {
      await withTimeout({
        operation: this.#client.abort({ sessionID }).catch(() => undefined),
        timeoutMs: 2000,
      }).catch(() => undefined);
      throw error;
    } finally {
      await withTimeout({
        operation: this.#client.remove?.({ sessionID }).catch(() => undefined) ?? Promise.resolve(),
        timeoutMs: 2000,
      }).catch(() => undefined);
      this.#reviewerSessionIDs.delete(sessionID);
    }
  }
}
