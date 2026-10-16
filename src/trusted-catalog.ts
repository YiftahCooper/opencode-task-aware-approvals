import { fingerprint } from "./adaptive.js";
export function trustedCatalog(local: readonly unknown[], global: readonly unknown[]): unknown[] {
  const trusted = new Set(global.map(fingerprint));
  return local.filter((model) => trusted.has(fingerprint(model)));
}
