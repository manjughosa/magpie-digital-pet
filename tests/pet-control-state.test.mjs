// tests/pet-control-state.test.mjs
// Regression: the engine inserts its singleton vpet_control_state row only in
// migration v3. If a save loses that row afterwards, every feed is rejected
// with "Digital Pet control state row is missing" and the gauge silently stays
// at 0 forever. The adapter re-asserts the row on start and once more when a
// feed is rejected, so a lost row heals instead of freezing the pet.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { createPetAdapter } from "../lib/pet.adapter.mjs";

const dbPath = join(tmpdir(), `pet-control-state-test-${randomUUID()}.db`);
process.on("exit", () => {
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      // best effort cleanup
    }
  }
});

const adapter = createPetAdapter({ dbPath, notifyGate: () => false });
await adapter.runCommand("digital-pet-spawn");

const rw = new Database(dbPath);
assert.equal(rw.query("SELECT COUNT(*) c FROM vpet_control_state").get().c, 1, "migration created the control row");
rw.run("DELETE FROM vpet_control_state");
rw.close();

const result = await adapter.feedUsage({
  id: `control-state-${randomUUID()}`,
  tokens: { input: 1200, output: 300 },
  cost: 0,
  completedAt: Date.now(),
});
assert.equal(result.kind, "fed", "usage is accepted after the row is repaired");

const ro = new Database(dbPath, { readonly: true });
const row = ro.query("SELECT control_id, frozen, cheat_node_id FROM vpet_control_state").get();
assert.deepEqual({ ...row }, { control_id: 1, frozen: 0, cheat_node_id: null });
assert.equal(ro.query("SELECT COUNT(*) c FROM usage_receipts").get().c, 1);
ro.close();

console.log("all pet-control-state tests passed");
