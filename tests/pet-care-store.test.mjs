// tests/pet-care-store.test.mjs
// Contract for the SQLite care store (Task 4).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  createCareStore,
  DECORATIONS,
  DAILY_GOAL_REWARDS,
  DAILY_FRAGMENT_CAP,
  DIFFICULTY_LEVELS,
  DIFFICULTY_CHEAT,
  DIFFICULTY_KNOWN,
  RESET_CARE_USES_COST,
} from "../lib/pet.care-store.mjs";
import { EXPEDITIONS } from "../lib/pet.care-rules.mjs";

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

const MINUTE = 60 * 1000;
const tempPaths = [];
function freshDbPath() {
  const filePath = join(tmpdir(), `pet-care-store-test-${randomUUID()}.db`);
  tempPaths.push(filePath);
  return filePath;
}
function cleanup() {
  for (const filePath of tempPaths) {
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        rmSync(filePath + suffix, { force: true });
      } catch {
        // best effort cleanup
      }
    }
  }
}
process.on("exit", cleanup);

test("decoration catalog exposes fifteen fixed ids with explicit prices", () => {
  assert.deepEqual(Object.keys(DECORATIONS).sort(), [
    "castle",
    "coast",
    "factory",
    "forest",
    "gear",
    "meadow",
    "night",
    "ocean",
    "sakura",
    "snow",
    "sunset",
    "terminal",
    "tunnel",
    "village",
    "void",
  ]);
  // 开局场景免费
  assert.equal(DECORATIONS.village.price, 0);
  for (const def of Object.values(DECORATIONS)) {
    assert.equal(Number.isInteger(def.price) && def.price >= 0, true);
  }
});

test("reopening the database runs migrations once and keeps data", () => {
  const databasePath = freshDbPath();
  const first = createCareStore({ databasePath });
  first.performAction("p1", "snack", 1000, {});
  first.close();

  const second = createCareStore({ databasePath });
  const snapshot = second.getCareSnapshot("p1", 1000);
  assert.equal(snapshot.state.satiety, 82);
  assert.equal(snapshot.state.burstUses.snack, 1);
  second.close();

  const raw = new Database(databasePath, { readonly: true });
  const version = raw.query("PRAGMA user_version").get().user_version;
  const tables = raw
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'magpie_pet_%'")
    .all()
    .map((row) => row.name)
    .sort();
  const columns = raw
    .query("PRAGMA table_info(magpie_pet_care_state)")
    .all()
    .map((row) => row.name);
  raw.close();
  assert.equal(version, 7);
  assert.ok(columns.includes("cooldown_pet"), "v3 migration must add cooldown_pet");
  assert.ok(columns.includes("snack_burst_used"), "v7 migration must add snack_burst_used");
  assert.ok(columns.includes("play_burst_used"), "v7 migration must add play_burst_used");
  assert.deepEqual(tables, [
    "magpie_pet_achievements",
    "magpie_pet_care_events",
    "magpie_pet_care_state",
    "magpie_pet_daily",
    "magpie_pet_egg_gate",
    "magpie_pet_expeditions",
    "magpie_pet_fragment_daily",
    "magpie_pet_inventory",
    "magpie_pet_names",
    "magpie_pet_settings",
  ]);
});

test("getCareSnapshot creates the default state for an unknown partner", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const snapshot = store.getCareSnapshot("p-new", 5000);
  assert.equal(snapshot.partnerId, "p-new");
  assert.equal(snapshot.state.satiety, 72);
  assert.equal(snapshot.state.mood, 70);
  assert.equal(snapshot.state.energy, 80);
  assert.equal(snapshot.state.hygiene, 75);
  assert.equal(snapshot.state.bond, 0);
  assert.equal(snapshot.activeExpedition, null);
  assert.equal(snapshot.daily.goals.length, 3);
  for (const goal of snapshot.daily.goals) {
    assert.equal(goal.progress, 0);
    assert.equal(goal.done, false);
    assert.equal(goal.rewardClaimed, false);
  }
  store.close();
});

test("rename persists per partner and validates the input", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const named = store.renamePet("p1", "  小  豆子  ", 1000);
  assert.deepEqual(named, { ok: true, name: "小 豆子" });
  assert.equal(store.getPetName("p1"), "小 豆子");
  assert.equal(store.getPetName("p2"), null);
  assert.deepEqual(store.renamePet("p1", "", 1001), { ok: false, reason: "invalid-name" });
  assert.equal(store.getPetName("p1"), "小 豆子");
  store.close();
});

test("performAction allows four snacks before cooldown and persists the count", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  const first = store.performAction("p1", "snack", t0, {});
  assert.equal(first.ok, true);
  assert.equal(first.state.satiety, 82);
  assert.equal(first.state.burstUses.snack, 1);
  assert.equal(typeof first.message, "string");

  for (let i = 1; i < 4; i += 1) {
    const result = store.performAction("p1", "snack", t0 + i * 1000, {});
    assert.equal(result.ok, true);
  }
  const refused = store.performAction("p1", "snack", t0 + 4 * 1000, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "cooldown");

  // One hour later the stored state decays by 2 satiety per hour.
  const decayed = store.getCareSnapshot("p1", t0 + 60 * MINUTE);
  assert.ok(Math.abs(decayed.state.satiety - 98) < 0.01, `${decayed.state.satiety} !~ 98`);
  store.close();
});

test("resetCareUses costs two fragments and clears only snack/play uses and cooldowns", () => {
  const databasePath = freshDbPath();
  const store = createCareStore({ databasePath });
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i += 1) {
    assert.equal(store.performAction("p1", "snack", t0 + i, {}).ok, true);
  }
  assert.ok(store.getCareSnapshot("p1", t0 + 4).state.cooldowns.snack > t0 + 4);

  const raw = new Database(databasePath);
  raw.run(
    "INSERT INTO magpie_pet_inventory (item_id, kind, quantity, equipped) VALUES ('fragments', 'currency', 5, 0) ON CONFLICT(item_id) DO UPDATE SET quantity = 5",
  );
  raw.close();

  const reset = store.resetCareUses("p1", t0 + 10);
  assert.equal(reset.ok, true);
  assert.equal(reset.cost, RESET_CARE_USES_COST);
  assert.equal(reset.fragments, 3);
  const snapshot = store.getCareSnapshot("p1", t0 + 10);
  assert.equal(snapshot.state.cooldowns.snack, 0);
  assert.equal(snapshot.state.cooldowns.play, 0);
  assert.deepEqual(snapshot.state.burstUses, { snack: 0, play: 0 });
  assert.equal(store.getCollection().fragments, 3);

  const noop = store.resetCareUses("p1", t0 + 11);
  assert.equal(noop.ok, false);
  assert.equal(noop.reason, "nothing-to-reset");
  assert.equal(store.getCollection().fragments, 3);
  store.close();
});

test("resetCareUses refuses without enough fragments and leaves uses untouched", () => {
  const databasePath = freshDbPath();
  const store = createCareStore({ databasePath });
  const t0 = 1_000_000;
  assert.equal(store.performAction("p1", "snack", t0, {}).ok, true);

  const raw = new Database(databasePath);
  raw.run(
    "INSERT INTO magpie_pet_inventory (item_id, kind, quantity, equipped) VALUES ('fragments', 'currency', 1, 0) ON CONFLICT(item_id) DO UPDATE SET quantity = 1",
  );
  raw.close();

  const reset = store.resetCareUses("p1", t0 + 1);
  assert.equal(reset.ok, false);
  assert.equal(reset.reason, "insufficient-fragments");
  const snapshot = store.getCareSnapshot("p1", t0 + 1);
  assert.equal(snapshot.state.burstUses.snack, 1);
  assert.equal(store.getCollection().fragments, 1);
  store.close();
});

test("care state is stored independently per partner", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  store.performAction("p1", "snack", t0, {});
  store.performAction("p1", "snack", t0 + 11 * MINUTE, {});

  const p1 = store.getCareSnapshot("p1", t0 + 11 * MINUTE);
  const p2 = store.getCareSnapshot("p2", t0 + 11 * MINUTE);
  assert.equal(p1.state.satiety > 72, true);
  assert.equal(p2.state.satiety, 72);
  assert.equal(p2.state.bond, 0);

  // Switching back to p1 keeps the earlier progress.
  const p1Again = store.getCareSnapshot("p1", t0 + 11 * MINUTE);
  assert.equal(p1Again.state.satiety, p1.state.satiety);
  store.close();
});

test("claimExpedition is idempotent and a second running expedition is refused", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  const started = store.startExpedition("p1", "patrol", t0);
  assert.equal(started.ok, true);
  assert.equal(started.expedition.status, "running");
  assert.equal(started.state.energy, 70);

  const busy = store.startExpedition("p1", "field", t0 + 1);
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, "expedition-active");

  const early = store.claimExpedition(started.expedition.expeditionId, t0 + 299_999);
  assert.equal(early.ok, false);
  assert.equal(early.reason, "not-finished");

  const claimed = store.claimExpedition(started.expedition.expeditionId, t0 + 300_000);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.reward.fragments, EXPEDITIONS.patrol.fragments);
  assert.equal(claimed.reward.bond, EXPEDITIONS.patrol.bond);
  assert.equal(typeof claimed.reward.note, "string");

  const fragmentsAfterClaim = store.getCollection().fragments;
  const again = store.claimExpedition(started.expedition.expeditionId, t0 + 600_000);
  assert.equal(again.ok, false);
  assert.equal(again.reason, "already-claimed");
  assert.equal(store.getCollection().fragments, fragmentsAfterClaim);

  const missing = store.claimExpedition("exp-does-not-exist", t0 + 600_000);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "no-expedition");

  const snapshot = store.getCareSnapshot("p1", t0 + 600_000);
  assert.equal(snapshot.activeExpedition, null);
  assert.equal(snapshot.state.bond, EXPEDITIONS.patrol.bond);
  store.close();
});

test("care-10 achievement unlocks exactly once", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  let lastNewly = [];
  for (let i = 0; i < 10; i += 1) {
    const result = store.performAction("p1", "snack", t0 + i * 11 * MINUTE, {});
    assert.equal(result.ok, true);
    lastNewly = result.achievements;
  }
  assert.deepEqual(lastNewly, ["care-10"]);

  const eleventh = store.performAction("p1", "snack", t0 + 10 * 11 * MINUTE, {});
  assert.equal(eleventh.ok, true);
  assert.deepEqual(eleventh.achievements, []);

  const achievements = store.getCollection().achievements;
  assert.equal(achievements.filter((id) => id === "care-10").length, 1);
  assert.equal(achievements.filter((id) => id === "first-care").length, 1);
  store.close();
});

test("writes are rejected after close and close is idempotent", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  store.close();
  store.close();
  assert.deepEqual(store.performAction("p1", "snack", 1000, {}), { ok: false, reason: "closed" });
  assert.deepEqual(store.resetCareUses("p1", 1000), { ok: false, reason: "closed" });
  assert.deepEqual(store.startExpedition("p1", "patrol", 1000), { ok: false, reason: "closed" });
  assert.deepEqual(store.claimExpedition("exp-x", 1000), { ok: false, reason: "closed" });
  assert.deepEqual(store.equipDecoration("meadow"), { ok: false, reason: "closed" });
});

test("store works on a database without the upstream tables", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  const result = store.performAction("p1", "snack", t0, {});
  assert.equal(result.ok, true);
  const snapshot = store.getCareSnapshot("p1", t0);
  const feed = snapshot.daily.goals.find((goal) => goal.id === "feed");
  assert.deepEqual(feed, { id: "feed", target: 10, progress: 0, done: false, rewardClaimed: false });
  assert.deepEqual(snapshot.achievements, ["first-care"]);
  store.close();
});

test("a fresh save ships with the village scene owned and equipped", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const collection = store.getCollection();
  assert.deepEqual(collection.unlocked, ["village"]);
  assert.equal(collection.equippedTheme, "village");
  assert.equal(collection.fragments, 0);
  store.close();
});

test("equipDecoration refuses unknown ids and never spends fragments when insufficient", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;

  const unknown = store.equipDecoration("galaxy");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unknown-decoration");

  // One patrol claim + the daily expedition goal — still short of the cheapest theme.
  const started = store.startExpedition("p1", "patrol", t0);
  store.claimExpedition(started.expedition.expeditionId, t0 + 300_000);
  const balance = EXPEDITIONS.patrol.fragments + DAILY_GOAL_REWARDS.expedition;
  assert.equal(store.getCollection().fragments, balance);
  assert.equal(balance < DECORATIONS.meadow.price, true);

  const poor = store.equipDecoration("meadow");
  assert.equal(poor.ok, false);
  assert.equal(poor.reason, "insufficient-fragments");
  assert.equal(store.getCollection().fragments, balance);

  // A night expedition adds enough for the meadow theme.
  const second = store.startExpedition("p1", "night", t0 + 300_001);
  store.claimExpedition(second.expedition.expeditionId, t0 + 300_001 + EXPEDITIONS.night.durationMs);
  assert.equal(store.getCollection().fragments, balance + EXPEDITIONS.night.fragments);
  assert.ok(balance + EXPEDITIONS.night.fragments >= DECORATIONS.meadow.price);

  const equipped = store.equipDecoration("meadow");
  assert.equal(equipped.ok, true);
  assert.equal(equipped.equippedTheme, "meadow");
  const collection = store.getCollection();
  assert.equal(collection.fragments, balance + EXPEDITIONS.night.fragments - DECORATIONS.meadow.price);
  assert.deepEqual(collection.unlocked, ["meadow", "village"]);
  assert.equal(collection.equippedTheme, "meadow");

  // Re-equipping an unlocked decoration is free.
  const again = store.equipDecoration("meadow");
  assert.equal(again.ok, true);
  assert.equal(store.getCollection().fragments, collection.fragments);
  store.close();
});

test("fragments stop at the daily cap, spending is not limited", () => {
  const dbPath = freshDbPath();
  const store = createCareStore({ databasePath: dbPath });
  // 固定在今天 10:00，避免 t0 + 30 分钟跨过午夜导致「今日已得」算到明天
  const anchor = new Date();
  anchor.setHours(10, 0, 0, 0);
  const t0 = anchor.getTime();
  const night = EXPEDITIONS.night.durationMs;

  // 先正常领一次，让当日计数行落库
  const first = store.startExpedition("p1", "night", t0);
  store.claimExpedition(first.expedition.expeditionId, t0 + night);
  // 探险 18 + 顺手完成的「探险 1 次」每日目标 6
  assert.equal(store.getCollection().earnedToday, EXPEDITIONS.night.fragments + DAILY_GOAL_REWARDS.expedition);

  // 把「今日已得」直接顶到 230，再领 18：只能拿到 10
  const raw = new Database(dbPath);
  raw.run("UPDATE magpie_pet_fragment_daily SET earned = 230");
  raw.close();

  const before = store.getCollection().fragments;
  const second = store.startExpedition("p1", "night", t0 + 2_000_000);
  const claim = store.claimExpedition(second.expedition.expeditionId, t0 + 2_000_000 + night);
  assert.equal(claim.ok, true);
  assert.equal(claim.reward.fragments, 10);
  assert.equal(claim.reward.capped, true);
  assert.equal(store.getCollection().earnedToday, DAILY_FRAGMENT_CAP);
  assert.equal(store.getCollection().fragments, before + 10);

  // 到顶之后再领，实发 0
  const third = store.startExpedition("p1", "night", t0 + 4_000_000);
  const capped = store.claimExpedition(third.expedition.expeditionId, t0 + 4_000_000 + night);
  assert.equal(capped.ok, true);
  assert.equal(capped.reward.fragments, 0);
  assert.equal(capped.reward.capped, true);
  assert.equal(store.getCollection().fragments, before + 10);

  // 花碎片不受上限影响
  const wallet = store.getCollection().fragments;
  const equipped = store.equipDecoration("meadow");
  assert.equal(equipped.ok, true);
  assert.equal(store.getCollection().fragments, wallet - DECORATIONS.meadow.price);
  store.close();
});

test("daily goal rewards are granted once per day", () => {
  const store = createCareStore({ databasePath: freshDbPath() });
  const t0 = 1_000_000;
  store.performAction("p1", "snack", t0, {});
  store.performAction("p1", "snack", t0 + 11 * MINUTE, {});

  const expected = DAILY_GOAL_REWARDS.care;
  assert.equal(store.getCollection().fragments, expected);

  const first = store.getCareSnapshot("p1", t0 + 11 * MINUTE);
  const care = first.daily.goals.find((goal) => goal.id === "care");
  assert.deepEqual(care, { id: "care", target: 2, progress: 2, done: true, rewardClaimed: true });

  // Repeated snapshots on the same day never grant the reward twice.
  store.getCareSnapshot("p1", t0 + 12 * MINUTE);
  store.getCareSnapshot("p1", t0 + 13 * MINUTE);
  assert.equal(store.getCollection().fragments, expected);
  store.close();
});

// 三级菜单的「作弊」档：×0.01，填充速度是「极速」的 10 倍。它能被设置、能被
// 适配器认出来，但**不**进二级菜单的六档。
test("cheat gear is a known level, kept out of the six-gear menu", () => {
  assert.equal(DIFFICULTY_LEVELS.length, 6, "二级菜单只列六档");
  assert.ok(!DIFFICULTY_LEVELS.some((l) => l.value === "0.01"), "作弊档不进二级菜单");
  assert.equal(DIFFICULTY_CHEAT.value, "0.01");
  assert.equal(DIFFICULTY_CHEAT.label, "作弊");
  assert.ok(DIFFICULTY_KNOWN.some((l) => l.value === "0.01"), "适配器与 set 命令都必须认它");
  assert.equal(1 / Number(DIFFICULTY_CHEAT.value), 10 / Number(DIFFICULTY_LEVELS[0].value));
  const store = createCareStore({ databasePath: freshDbPath() });
  store.setSetting("difficulty", DIFFICULTY_CHEAT.value);
  assert.equal(store.getSetting("difficulty", "1"), "0.01");
  store.close();
});

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("all pet-care-store tests passed");
