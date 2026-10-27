/**
 * Stable, security-relevant projection of a host provider object.
 *
 * The full provider payload embeds volatile metadata (model catalog entries,
 * display names, activation flags) that changes with host upgrades and
 * models.dev refreshes. Fingerprinting it directly fails the plugin closed on
 * every host upgrade even when nothing security-relevant changed.
 *
 * The identity projection keeps only what a redirect or substitution attack
 * would have to change: which provider/integration/SDK adapter is used, where
 * it points (baseURL), and which credential/setting/header names exist.
 * Credential values are never included: they rotate, and rotating them must
 * not invalidate trust.
 */
export type ProviderIdentity = {
  id: unknown;
  integrationID: unknown;
  package: unknown;
  baseURL: unknown;
  settingKeys: string[];
  headerNames: string[];
  envNames: string[];
};

export function providerIdentity(provider: unknown): ProviderIdentity {
  const p = (provider ?? {}) as {
    id?: unknown;
    integrationID?: unknown;
    package?: unknown;
    settings?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    env?: unknown;
  };
  const envNames = Array.isArray(p.env)
    ? p.env.filter((v): v is string => typeof v === "string")
    : Object.keys((p.env ?? {}) as Record<string, unknown>);
  return {
    id: p.id,
    integrationID: p.integrationID,
    package: p.package,
    baseURL: p.settings?.baseURL,
    settingKeys: Object.keys(p.settings ?? {}).toSorted(),
    headerNames: Object.keys(p.headers ?? {}).toSorted(),
    envNames: envNames.toSorted(),
  };
}
