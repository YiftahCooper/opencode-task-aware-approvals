# OpenCode task-aware approvals

A task-aware approval plugin for **OpenCode V2**, including stock T3 integrations that use the tested V2 host. When a native permission rule asks, the plugin compares the exact proposed action with the user's task and recent authorizations. Only an explicit reviewer allow resolves that ask. Deny, uncertainty, stale context and failures leave the human approval prompt in place. Native allow and deny rules retain their normal behavior.

This is the public source fork [YiftahCooper/opencode-task-aware-approvals](https://github.com/YiftahCooper/opencode-task-aware-approvals), based on dyoshikawa's MIT-licensed [opencode-auto-approval-plugin](https://github.com/dyoshikawa/opencode-auto-approval-plugin). Original authorship and Git history are preserved. The untouched upstream 0.7.0 source and documentation are available on [upstream-v0.7.0](https://github.com/YiftahCooper/opencode-task-aware-approvals/tree/upstream-v0.7.0).

**Distribution is GitHub source only. This package name has not been published to npm.** The public import, CommonJS main and `server.js` all select the fixed task-aware implementation. The explicit `opencode-task-aware-approvals/legacy` export retains the upstream configurable behavior for developers; it is a different product surface and does not provide this fork's fixed task-aware policy.

## Support and limits

- Synthetic host coverage: installed OpenCode **2.0.30 and 2.0.31 on Linux**; the current source passed on 2.0.31. Concurrent processes sharing private state must share a PID namespace; the supplied isolated live runner serializes its host lifetimes as documented in [TASK-AWARE.md](TASK-AWARE.md). Stock T3 starts its host normally; there is one plugin and no extra daemon, launcher or scheduler.
- Reviewer candidates: the already authenticated **OpenCode Go** provider's GPT/Claude models with an explicit `high` variant, bound to the trusted provider and global catalog. Project-added or modified models cannot silently redirect the reviewer.
- Reviewers have **no tools**. Inherited project/global reviewer instructions are removed. Review uses bounded context from actual user turns; delegated child sessions and missing authority escalate to a human.
- Only tested, current-build candidates can be promoted. Qualification expires after 14 days. Host/catalog/build changes require fresh evidence. Quota/rate-limit failures persist a one-hour provider cooldown; authentication failures wait 24 hours.
- Qualification reserves at most 144 calls per rolling week and 576 per 30 days, including failed/interrupted calls. At most three candidates run sequentially per batch, with a 20-minute batch deadline and 30-second call timeout. A live permission decision makes at most one reviewer call.
- Credentials remain host-owned. Model inference may incur costs. Passing a finite regression suite is not proof that a model will never make an unsafe decision. Reviewers cannot establish authority from their own claims, tool output or repository instructions.

**This repaired build requires NEW qualification.** Historical real-model and stock T3 acceptance was on OpenCode 2.0.30 with an earlier build; it does not qualify this build or establish real Go/T3 acceptance on 2.0.31. Source checks and synthetic host tests establish implementation behavior, not real-model acceptance or live activation.

## Build and verify

Use Node **24.18.0** and pnpm **10.30.3**. From a checkout:

```bash
export COREPACK_HOME="$PWD/../.backup-scratch/corepack"
corepack pnpm@10.30.3 install --frozen-lockfile --ignore-scripts --store-dir ../.backup-scratch/pnpm-store
corepack pnpm@10.30.3 cicheck
corepack pnpm@10.30.3 build
corepack pnpm@10.30.3 test:distribution
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/host -p 'test_helpers.py'
node scripts/package.mjs
```

Packaging prints the immutable release directory under `../releases/<version>-<build>/`. It verifies that `dist` matches current production inputs, stages the complete artifact in `../.backup-scratch/`, and publishes only a verified candidate. Existing identical releases are reusable; partial or differing releases are refused. The release includes pinned runtime dependencies and a SHA-256 inventory. Retain selected releases outside scratch; do not edit them.

The optional local host suite uses the actual installed V2 binary at `~/.opencode/bin/opencode`, Python with pytest, and bubblewrap. Its synthetic seed binds to that binary’s reported version; observed passing versions are 2.0.30 and 2.0.31. Run `TASK_AWARE_RELEASE=/absolute/release/path tests/host/run-isolated.sh synthetic`. It uses disposable profiles, a synthetic model and no external network. Upstream provides no official 2.0.30 release asset; CI does not download a different host or claim host acceptance. CI runs unit, type, lint, format, spelling, secret, installer, packaging and import-resolution checks.

## Install, status and rollback

Read [TASK-AWARE.md](TASK-AWARE.md) before qualification or activation. Keep the host stopped during changes. The installer supports an existing `opencode.json` or `opencode.jsonc` (including comments and trailing commas), preserves native `plugins` or legacy `plugin` entries, and refuses ambiguous simultaneous config files. New configs use native V2 registration. It adds no shell allow rule or Full Access policy.

From the built source or a selected release:

```bash
node scripts/manage.mjs install /absolute/release/path PROVIDER_FINGERPRINT /absolute/qualification/directory
node scripts/manage.mjs status
node scripts/manage.mjs rollback
```

`PROVIDER_FINGERPRINT` is the SHA-256 of the verified host provider metadata, not a credential. Qualification evidence is bound to that provider and the exact release build. Installing without an evidence directory leaves decisions manual until runtime qualification succeeds; it may start paid qualification calls when the enabled host next starts.

`status` distinguishes historical passes from fresh evidence for the CLI's own build, reports disabled policy/installation and cooldown, and reports catalog availability as unknown until the host checks it. Source status refuses stale compiled output. Use a release's own CLI to inspect evidence for that release.

To replace a prior installation, use `upgrade RELEASE PROVIDER_FINGERPRINT EVIDENCE_DIRECTORY`. Upgrade requires fresh evidence with the same trusted provider and a history extension preserving every current 30-day reservation (including duplicates) and non-diverging results. Disabled policy stays disabled. Rollback restores the last complete registration after an upgrade, or removes only the installed registration after an initial install. Spend remains recorded in either case.

Original config backup, receipt and state remain in `~/.local/state/opencode/task-aware-approvals/`. File and parent-directory fsync protect durable installer writes; an exclusive installer lock prevents concurrent own installers. Hash comparison against the initial config is best-effort external-editor conflict detection. An interrupted lock requires inspection while the host and installer are stopped; see recovery details in [TASK-AWARE.md](TASK-AWARE.md).
