import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, lstat, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import type { Result } from "./adaptive.js";

export type SelectionState = {
  version: 1;
  generation: number;
  spend: number[];
  results: Result[];
  incumbent?: string;
  lastBatch: number;
  batch?: { pending: string[]; started: number };
  lastDiscovery: number;
  cooldownUntil?: number;
  failures: Record<string, number>;
  status: string;
};
export const emptyState = (): SelectionState => ({
  version: 1,
  generation: 0,
  spend: [],
  results: [],
  lastBatch: 0,
  lastDiscovery: 0,
  failures: {},
  status: "Awaiting qualification",
});
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
// Each persisted field is validated before any saved qualification can authorize work.
// oxlint-disable-next-line complexity
export function parseState(text: string): SelectionState {
  const s = JSON.parse(text);
  if (
    s.version !== 1 ||
    !Number.isInteger(s.generation) ||
    s.generation < 0 ||
    !Array.isArray(s.spend) ||
    s.spend.length > 576 ||
    !s.spend.every(number) ||
    !Array.isArray(s.results) ||
    s.results.length > 100 ||
    !number(s.lastBatch) ||
    !number(s.lastDiscovery) ||
    (s.batch !== undefined &&
      (!number(s.batch.started) ||
        !Array.isArray(s.batch.pending) ||
        s.batch.pending.length > 3 ||
        !s.batch.pending.every((key: unknown) => typeof key === "string"))) ||
    (s.cooldownUntil !== undefined && !number(s.cooldownUntil)) ||
    typeof s.status !== "string" ||
    !s.failures ||
    typeof s.failures !== "object" ||
    !Object.values(s.failures).every(number) ||
    (s.incumbent !== undefined && typeof s.incumbent !== "string")
  )
    throw new Error("Invalid selection state; human approval remains active.");
  for (const r of s.results) {
    if (
      !r.candidate ||
      !["key", "providerID", "modelID", "variant"].every(
        (k) => typeof r.candidate[k] === "string",
      ) ||
      typeof r.protocol !== "string" ||
      ![
        "tested",
        "unauthorized",
        "escalationMisses",
        "authorized",
        "required",
        "errors",
        "medianMs",
      ].every((k) => number(r[k]))
    )
      throw new Error("Invalid qualification evidence.");
  }
  return s;
}
async function safeRead(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > 256_000 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o022
    )
      throw new Error("Untrusted state/config file.");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
const atomic = async (target: string, text: string) => {
  const temp = `${target}.${process.pid}.tmp`;
  const f = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await f.writeFile(text);
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temp, target);
  const parent = await open(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
};

export class SelectionStore {
  constructor(readonly directory: string) {}
  async read(): Promise<SelectionState> {
    try {
      return parseState(await safeRead(join(this.directory, "selection.json")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await lstat(join(this.directory, "selection.previous.json"));
        } catch (prior) {
          if ((prior as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
          throw prior;
        }
        throw new Error(
          "Selection recovery required: current state is missing; prior spend must be preserved.",
          { cause: e },
        );
      }
      throw e;
    }
  }
  async write(state: SelectionState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "selection.json");
    const previous = await this.read();
    if (previous.generation !== state.generation) throw new Error("Selection generation changed.");
    const next = { ...state, generation: state.generation + 1 };
    parseState(JSON.stringify(next));
    await atomic(join(this.directory, "selection.previous.json"), JSON.stringify(previous));
    await atomic(path, JSON.stringify(next));
    state.generation = next.generation;
  }
  /** Only synchronous mutations belong here; never hold the state lock over inference. */
  async update<T>(change: (state: SelectionState) => T): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const release = await this.lock();
      if (!release) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      try {
        const state = await this.read();
        const before = JSON.stringify(state);
        const value = change(state);
        if (JSON.stringify(state) !== before) await this.write(state);
        return value;
      } finally {
        await release();
      }
    }
    throw new Error("Selection state busy; human approval required.");
  }
  async lock(scope: "state" | "batch" = "state"): Promise<(() => Promise<void>) | undefined> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o022
    )
      throw new Error("Untrusted selection directory.");
    const directory = join(this.directory, scope === "batch" ? "batch-locks" : "locks");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockInfo = await lstat(directory);
    if (lockInfo.isSymbolicLink() || lockInfo.uid !== process.getuid?.() || lockInfo.mode & 0o022)
      throw new Error("Untrusted lock directory.");
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().slice(0, 8);
    const start = await processStart(process.pid);
    const name = `claim-${process.pid}-${start}-${boot}-${randomUUID()}.json`;
    const path = join(directory, name);
    // Lamport bakery lock: each contender owns a never-reused pathname.
    // A late contender observes an existing ticket and must choose a higher one.
    // Concurrent choosers either yield or break equal tickets by unique name.
    const claim = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await claim.close(); // empty + live owner means choosing, never stale
    try {
      const before = await liveClaims(directory, boot);
      const ticket = Math.max(0, ...before.map((c) => c.ticket)) + 1;
      await atomic(path, JSON.stringify({ ticket }));
      const other = (await liveClaims(directory, boot)).some(
        (c) =>
          c.name !== name &&
          (c.ticket === 0 || c.ticket < ticket || (c.ticket === ticket && c.name < name)),
      );
      if (other) {
        await unlink(path);
        return undefined;
      }
      return async () => {
        await unlink(path).catch(() => undefined);
      };
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }
}
async function processStart(pid: number): Promise<string> {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const start = text
    .slice(text.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)[19];
  if (!start || !/^\d+$/.test(start)) throw new Error("Process identity unavailable.");
  return start;
}
async function liveClaims(
  directory: string,
  boot: string,
): Promise<Array<{ name: string; ticket: number }>> {
  const names = (await readdir(directory)).filter(
    (n) => n.startsWith("claim-") && n.endsWith(".json"),
  );
  if (names.length > 1000) throw new Error("Too many lock claims; recovery required.");
  const live: Array<{ name: string; ticket: number }> = [];
  for (const name of names) {
    const match = /^claim-(\d+)-(\d+)-([a-f0-9]{8})-[a-f0-9-]{36}\.json$/.exec(name);
    if (!match) throw new Error("Invalid lock owner; recovery required.");
    const path = join(directory, name);
    try {
      let alive = match[3] === boot;
      if (alive) {
        try {
          alive = (await processStart(Number(match[1]))) === match[2];
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === "ENOENT" ||
            (error as NodeJS.ErrnoException).code === "ESRCH"
          )
            alive = false;
          else throw error;
        }
      }
      if (!alive) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      let ticket = 0;
      try {
        const value = JSON.parse(await safeRead(path));
        if (Number.isSafeInteger(value.ticket) && value.ticket > 0) ticket = value.ticket;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      live.push({ name, ticket });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return live;
}
export { safeRead };
