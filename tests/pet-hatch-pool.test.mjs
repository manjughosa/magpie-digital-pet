// tests/pet-hatch-pool.test.mjs
// Hatch pool contract: the next egg prefers a form the dex has never seen
// (lineage = partners' current forms + every node in partner_events). Once the
// whole baby pool has been seen, it must NOT keep handing out the first entry
// of the catalog — it picks a random baby instead of leaving the egg stuck at
// stage 0.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { createPetAdapter, DIGIMON_DATA } from "../lib/pet.adapter.mjs";

const dbPath = join(tmpdir(), `pet-hatch-pool-test-${randomUUID()}.db`);
process.on("exit", () => {
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      // best effort cleanup
    }
  }
});

const activeNode = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query("SELECT current_node_id FROM partners WHERE retired_at IS NULL LIMIT 1")
      .get()?.current_node_id;
  } finally {
    db.close();
  }
};

const adapter = createPetAdapter({ dbPath, notifyGate: () => false });

// first egg: stays Digiegg until a baby form has been seen
await adapter.runCommand("digital-pet-spawn");
assert.equal(activeNode(), "0-001", "the very first egg has no pool to pick from");

// mark the whole baby pool as seen, then hatch again
const babies = DIGIMON_DATA.filter((entry) => entry.stage <= 2);
const db = new Database(dbPath);
const partnerId = db.query("SELECT partner_id FROM partners WHERE retired_at IS NULL LIMIT 1").get().partner_id;
const insert = db.prepare(
  `INSERT INTO partner_events (event_id, partner_id, kind, current_node_id, gauge, is_terminal, token_delta, receipt_key, created_at)
   VALUES (?, ?, 'usage_applied', ?, 0, 0, NULL, NULL, ?)`,
);
const now = new Date().toISOString();
for (const entry of babies) insert.run(`pool-seen-${entry.id}`, partnerId, entry.id, now);
db.close();

await adapter.runCommand("digital-pet-spawn");
const picked = activeNode();
const pickedEntry = DIGIMON_DATA.find((entry) => entry.id === picked);
assert.ok(pickedEntry, `hatch produced a catalog node (${picked})`);
assert.equal(pickedEntry.stage, 1, "exhausted pool still hatches a stage-1 baby, never a stranded egg");

// a repeated exhaustion must be able to produce different species (random),
// not always the catalog's first baby
const seenFirst = new Set();
for (let i = 0; i < 8; i += 1) {
  await adapter.runCommand("digital-pet-spawn");
  const id = activeNode();
  assert.notEqual(id, "0-001", "egg must not be stranded on a later hatch");
  seenFirst.add(id);
}
assert.ok(seenFirst.size >= 2, `random fallback must vary the species, got ${[...seenFirst].join(",")}`);

console.log("all pet-hatch-pool tests passed");
