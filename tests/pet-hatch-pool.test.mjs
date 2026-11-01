// tests/pet-hatch-pool.test.mjs
// 蛋阶段与孵化池：
//   - 新拿到的是一颗蛋（stage 0），喂够槽才孵出 baby I，而且这一步不进对决；
//   - 孵化时引擎随机挑分支，插件会把它纠成「孵化前没养过的那只」；
//   - 整池都养过时保留引擎的随机结果，不会卡在蛋。

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

const active = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query("SELECT partner_id, current_node_id, gauge, battle_opponent_node_id FROM partners WHERE retired_at IS NULL LIMIT 1")
      .get();
  } finally {
    db.close();
  }
};

const adapter = createPetAdapter({ dbPath, notifyGate: () => false });

// 1) 新蛋是蛋：不自动变 baby
await adapter.runCommand("digital-pet-spawn");
assert.equal(active().current_node_id, "0-001", "a fresh egg stays an egg");
assert.equal(active().gauge, 0);

// 2) 除 1-030 之外，所有 baby I 都标成「养过」
const babies = DIGIMON_DATA.filter((entry) => entry.stage === 1);
const onlyUnseen = "1-030";
const db = new Database(dbPath);
const partnerId = active().partner_id;
const insert = db.prepare(
  `INSERT INTO partner_events (event_id, partner_id, kind, current_node_id, gauge, is_terminal, token_delta, receipt_key, created_at)
   VALUES (?, ?, 'usage_applied', ?, 0, 0, NULL, NULL, ?)`,
);
const now = new Date().toISOString();
for (const entry of babies) {
  if (entry.id === onlyUnseen) continue;
  insert.run(`pool-seen-${entry.id}`, partnerId, entry.id, now);
}
db.close();

// 3) 喂够蛋的槽 → 孵成 baby I，且必须是那只没养过的；这一步没有对决
const eggThreshold = 5_000_000;
const fed = await adapter.feedUsage({
  id: `egg-hatch-${randomUUID()}`,
  tokens: { input: eggThreshold + 1, output: 0 },
  cost: 0,
  completedAt: Date.now(),
});
assert.equal(fed.kind, "fed");
const hatched = active();
assert.equal(hatched.current_node_id, onlyUnseen, "hatch must pick the only unseen baby");
assert.equal(hatched.gauge, 0);
assert.equal(hatched.battle_opponent_node_id, null, "egg -> baby I never opens a battle");

console.log("all pet-hatch-pool tests passed");
