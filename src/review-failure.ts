/** Controlled diagnostics only; never retain provider messages, prompts or credentials. */
export function failureKind(error: unknown): string {
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (/configuration changed|provider configuration/.test(text)) return "binding";
  if (/401|unauthorized|invalid.api.key|authentication/.test(text)) return "authentication";
  if (/429|rate.limit|usage.limit|quota|balance|credits/.test(text)) return "rate-limit";
  if (/fetch|network|enotfound|eai_again|dns|connection|econn/.test(text)) return "network";
  if (/timed out|timeout/.test(text)) return "timeout";
  if (/json|verdict|review check/.test(text)) return "format";
  if (/not.found|not.available|unknown.model/.test(text)) return "model-unavailable";
  return "transport";
}
