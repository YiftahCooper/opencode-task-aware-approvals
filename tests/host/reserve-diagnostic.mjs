import { reserve } from "../../src/adaptive.ts";
import { SelectionStore } from "../../src/selection-store.ts";
const store = new SelectionStore(process.argv[2]);
const release = await store.lock();
if (!release) throw new Error("Qualification in progress");
try {
  const state = await store.read();
  const spend = reserve(state.spend, Date.now());
  if (!spend) throw new Error("Budget exhausted");
  state.spend = spend;
  await store.write(state);
} finally {
  await release();
}
