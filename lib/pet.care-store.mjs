// lib/pet.care-store.mjs
// SQLite persistence for the care layer (Task 4). Owns only the new
// magpie_pet_* tables; upstream tables (partners, usage_receipts, ...) are
// read defensively and never written. All gameplay math stays in
// pet.care-rules.mjs — this module only adds transactions and storage.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  applyCareAction,
  careSummary,
  claimExpedition as ruleClaimExpedition,
  createDefaultCareState,
  decayCareState,
  evaluateAchievements,
  evaluateDailyGoals,
  startExpedition as ruleStartExpedition,
} from "./pet.care-rules.mjs";

export const MIGRATION_VERSION = 7;

// Purely decorative unlockables, paid for with data fragments only.
export const DECORATIONS = {
  village: { price: 0 }, // 新手默认场景，免费且开局就有
  meadow: { price: 20 },
  gear: { price: 75 },
  night: { price: 50 },
  terminal: { price: 80 },
  ocean: { price: 120 },
  coast: { price: 140 },
  sunset: { price: 160 },
  snow: { price: 240 },
  forest: { price: 280 },
  tunnel: { price: 300 },
  sakura: { price: 320 },
  factory: { price: 360 },
  void: { price: 400 },
  castle: { price: 520 },
};

// Small fragment reward per completed daily goal, claimable once per day.
export const DAILY_GOAL_REWARDS = { care: 4, expedition: 6, feed: 4 };

// 每天最多能赚到的碎片数（探险 + 每日目标合计）；花掉的不算，隔天重置。
export const DAILY_FRAGMENT_CAP = 240;

// 重置点心和玩耍的可用次数；只扣碎片，不碰真实 token 统计。
export const RESET_CARE_USES_COST = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS magpie_pet_care_state (
  partner_id TEXT PRIMARY KEY,
  satiety REAL NOT NULL,
  mood REAL NOT NULL,
  energy REAL NOT NULL,
  hygiene REAL NOT NULL,
  bond REAL NOT NULL,
  cooldown_snack INTEGER NOT NULL DEFAULT 0,
  cooldown_play INTEGER NOT NULL DEFAULT 0,
  cooldown_clean INTEGER NOT NULL DEFAULT 0,
  cooldown_rest INTEGER NOT NULL DEFAULT 0,
  cooldown_pet_egg INTEGER NOT NULL DEFAULT 0,
  last_decay_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS magpie_pet_care_events (
  event_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  action TEXT,
  message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS magpie_pet_care_events_partner_created_at
  ON magpie_pet_care_events (partner_id, created_at);
CREATE TABLE IF NOT EXISTS magpie_pet_expeditions (
  expedition_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  claimed_at INTEGER,
  fragments INTEGER,
  bond INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS magpie_pet_expeditions_partner_status
  ON magpie_pet_expeditions (partner_id, status);
CREATE TABLE IF NOT EXISTS magpie_pet_inventory (
  item_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  equipped INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS magpie_pet_achievements (
  achievement_id TEXT PRIMARY KEY,
  unlocked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS magpie_pet_daily (
  date TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  reward_claimed INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  PRIMARY KEY (date, goal_id)
);
CREATE TABLE IF NOT EXISTS magpie_pet_fragment_daily (
  date TEXT PRIMARY KEY,
  earned INTEGER NOT NULL DEFAULT 0
);
`;

const MIGRATION_V2_SQL = `
CREATE TABLE IF NOT EXISTS magpie_pet_names (
  partner_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

// v3: 画布抚摸动作（care action "pet"）的独立冷却列。
const MIGRATION_V3_SQL = `
ALTER TABLE magpie_pet_care_state ADD COLUMN cooldown_pet INTEGER NOT NULL DEFAULT 0;
`;

const MIGRATION_V4_SQL = `
CREATE TABLE IF NOT EXISTS magpie_pet_fragment_daily (
  date TEXT PRIMARY KEY,
  earned INTEGER NOT NULL DEFAULT 0
);
`;

// 换蛋判定：把手上所有 baby II 及以上伙伴的阶段数字加起来当「孵蛋条件计数器」，
// 每次有伙伴进化（计数器变大）才解锁一颗蛋；领完把当时的值记进 snapshot。
const MIGRATION_V5_SQL = `
CREATE TABLE IF NOT EXISTS magpie_pet_egg_gate (
  control_id INTEGER PRIMARY KEY CHECK (control_id = 1),
  snapshot INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO magpie_pet_egg_gate (control_id, snapshot) VALUES (1, 0);
`;

// v6: 养成难度。只影响进化经验槽的填充速度，不改任何真实 token 统计。
export const DIFFICULTY_LEVELS = [
  { value: "0.1", label: "极速" },
  { value: "0.2", label: "简单" },
  { value: "0.5", label: "正常" },
  { value: "1", label: "普通" },
  { value: "2", label: "困难" },
  { value: "5", label: "漫长" },
];

// 三级菜单（难度齿轮里那个小按钮）里的「作弊」：填充速度是「极速」的 10 倍，
// 也就是 1 token 记 100 点经验。它**不进** DIFFICULTY_LEVELS —— 二级菜单只
// 列上面那六档。但适配器和 set 命令都必须认它，否则库里的 0.01 会被当成「普通」。
export const DIFFICULTY_CHEAT = { value: "0.01", label: "作弊" };
export const DIFFICULTY_KNOWN = [...DIFFICULTY_LEVELS, DIFFICULTY_CHEAT];
const MIGRATION_V6_SQL = `
CREATE TABLE IF NOT EXISTS magpie_pet_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// v7: 点心和玩耍可以连续使用，达到上限后才进入冷却。
const MIGRATION_V7_SQL = `
ALTER TABLE magpie_pet_care_state ADD COLUMN snack_burst_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE magpie_pet_care_state ADD COLUMN play_burst_used INTEGER NOT NULL DEFAULT 0;
`;

function localDateString(nowMs) {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDayRangeMs(nowMs) {
  const date = new Date(nowMs);
  const startMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return { startMs, endMs: startMs + DAY_MS };
}

function rowToCareState(row) {
  return {
    partnerId: row.partner_id,
    satiety: row.satiety,
    mood: row.mood,
    energy: row.energy,
    hygiene: row.hygiene,
    bond: row.bond,
    cooldowns: {
      snack: row.cooldown_snack,
      play: row.cooldown_play,
      clean: row.cooldown_clean,
      rest: row.cooldown_rest,
      petEgg: row.cooldown_pet_egg,
      pet: row.cooldown_pet ?? 0,
    },
    burstUses: {
      snack: row.snack_burst_used ?? 0,
      play: row.play_burst_used ?? 0,
    },
    lastDecayAt: row.last_decay_at,
    updatedAt: row.updated_at,
  };
}

function rowToExpedition(row) {
  return {
    expeditionId: row.expedition_id,
    partnerId: row.partner_id,
    kind: row.kind,
    status: row.status,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    claimedAt: row.claimed_at,
    fragments: row.fragments,
    bond: row.bond,
    note: row.note,
  };
}

export function createCareStore({ databasePath } = {}) {
  if (typeof databasePath !== "string" || databasePath.trim() === "") {
    throw new Error("createCareStore requires a databasePath");
  }
  mkdirSync(dirname(databasePath.trim()), { recursive: true });
  const db = new Database(databasePath.trim());
  db.run("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  let closed = false;

  function migrate() {
    const version = db.query("PRAGMA user_version").get().user_version;
    if (version >= MIGRATION_VERSION) return;
    const apply = db.transaction(() => {
      if (version < 1) {
        db.exec(MIGRATION_SQL);
        db.exec("PRAGMA user_version = 1");
      }
      if (version < 2) {
        db.exec(MIGRATION_V2_SQL);
        db.exec("PRAGMA user_version = 2");
      }
      if (version < 3) {
        db.exec(MIGRATION_V3_SQL);
        db.exec("PRAGMA user_version = 3");
      }
      if (version < 4) {
        db.exec(MIGRATION_V4_SQL);
        db.exec("PRAGMA user_version = 4");
      }
      if (version < 5) {
        db.exec(MIGRATION_V5_SQL);
        db.exec("PRAGMA user_version = 5");
      }
      if (version < 6) {
        db.exec(MIGRATION_V6_SQL);
        db.exec("PRAGMA user_version = 6");
      }
      if (version < 7) {
        db.exec(MIGRATION_V7_SQL);
        db.exec("PRAGMA user_version = 7");
      }
    });
    apply();
  }
  migrate();

  // 新手没有一个背景可看会很难受：默认送「阳光村落」并装上（已有装备的不动）
  function ensureStarterDecoration() {
    try {
      const equipped = db
        .query("SELECT item_id FROM magpie_pet_inventory WHERE kind = 'decoration' AND equipped = 1 LIMIT 1")
        .get();
      const owned = db.query("SELECT 1 FROM magpie_pet_inventory WHERE item_id = 'village'").get();
      if (!owned) {
        db.query(
          "INSERT INTO magpie_pet_inventory (item_id, kind, quantity, equipped) VALUES ('village', 'decoration', 1, ?)",
        ).run(equipped ? 0 : 1);
      } else if (!equipped) {
        db.query("UPDATE magpie_pet_inventory SET equipped = 1 WHERE item_id = 'village'").run();
      }
    } catch {
      // 没有 inventory 表就跳过（只在极早期存档出现）
    }
  }
  ensureStarterDecoration();

  function tableExists(name) {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return row !== null && row !== undefined;
  }

  function readCareState(partnerId) {
    const row = db.query("SELECT * FROM magpie_pet_care_state WHERE partner_id = ?").get(partnerId);
    return row ? rowToCareState(row) : null;
  }

  function writeCareState(state) {
    db.query(
      `INSERT INTO magpie_pet_care_state (
         partner_id, satiety, mood, energy, hygiene, bond,
         cooldown_snack, cooldown_play, cooldown_clean, cooldown_rest, cooldown_pet_egg, cooldown_pet,
         snack_burst_used, play_burst_used, last_decay_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(partner_id) DO UPDATE SET
         satiety = excluded.satiety, mood = excluded.mood, energy = excluded.energy,
         hygiene = excluded.hygiene, bond = excluded.bond,
         cooldown_snack = excluded.cooldown_snack, cooldown_play = excluded.cooldown_play,
         cooldown_clean = excluded.cooldown_clean, cooldown_rest = excluded.cooldown_rest,
         cooldown_pet_egg = excluded.cooldown_pet_egg, cooldown_pet = excluded.cooldown_pet,
         snack_burst_used = excluded.snack_burst_used, play_burst_used = excluded.play_burst_used,
         last_decay_at = excluded.last_decay_at, updated_at = excluded.updated_at`,
    ).run(
      state.partnerId,
      state.satiety,
      state.mood,
      state.energy,
      state.hygiene,
      state.bond,
      state.cooldowns.snack,
      state.cooldowns.play,
      state.cooldowns.clean,
      state.cooldowns.rest,
      state.cooldowns.petEgg,
      state.cooldowns.pet ?? 0,
      state.burstUses?.snack ?? 0,
      state.burstUses?.play ?? 0,
      state.lastDecayAt,
      state.updatedAt,
    );
  }

  function insertEvent(partnerId, kind, action, message, nowMs) {
    db.query(
      "INSERT INTO magpie_pet_care_events (event_id, partner_id, kind, action, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), partnerId, kind, action, message ?? null, nowMs);
  }

  function currentState(partnerId, nowMs) {
    const stored = readCareState(partnerId) ?? createDefaultCareState(partnerId, nowMs);
    return decayCareState(stored, nowMs);
  }

  function runningExpedition(partnerId) {
    const row = db
      .query("SELECT * FROM magpie_pet_expeditions WHERE partner_id = ? AND status = 'running'")
      .get(partnerId);
    return row ? rowToExpedition(row) : null;
  }

  function getFragments() {
    const row = db
      .query("SELECT quantity FROM magpie_pet_inventory WHERE item_id = 'fragments'")
      .get();
    return row ? row.quantity : 0;
  }

  function fragmentsEarnedToday(date) {
    try {
      return db.query("SELECT earned FROM magpie_pet_fragment_daily WHERE date = ?").get(date)?.earned ?? 0;
    } catch {
      return 0;
    }
  }

  // 收入受每日上限约束；花掉（delta < 0）不受影响。返回实际到手的数量。
  function addFragments(delta, nowMs = Date.now()) {
    db.query(
      "INSERT INTO magpie_pet_inventory (item_id, kind, quantity, equipped) VALUES ('fragments', 'currency', 0, 0) ON CONFLICT(item_id) DO NOTHING",
    ).run();
    let granted = delta;
    if (delta > 0) {
      const date = localDateString(nowMs);
      const remaining = Math.max(0, DAILY_FRAGMENT_CAP - fragmentsEarnedToday(date));
      granted = Math.min(delta, remaining);
      if (granted <= 0) return 0;
      db.query(
        "INSERT INTO magpie_pet_fragment_daily (date, earned) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET earned = earned + excluded.earned",
      ).run(date, granted);
    }
    db.query("UPDATE magpie_pet_inventory SET quantity = quantity + ? WHERE item_id = 'fragments'").run(granted);
    return granted;
  }

  function countEvolutions() {
    if (!tableExists("partners")) return 0;
    const row = db
      .query("SELECT COUNT(*) AS c FROM partners WHERE current_node_id NOT LIKE '0-%'")
      .get();
    return row.c;
  }

  function unlockAchievements(nowMs) {
    const counts = db
      .query(
        `SELECT
           COALESCE(SUM(CASE WHEN kind = 'care' THEN 1 ELSE 0 END), 0) AS total,
           COALESCE(SUM(CASE WHEN kind = 'care' AND action = 'clean' THEN 1 ELSE 0 END), 0) AS clean,
           COALESCE(SUM(CASE WHEN kind = 'expedition' THEN 1 ELSE 0 END), 0) AS expedition
         FROM magpie_pet_care_events`,
      )
      .get();
    const unlocked = evaluateAchievements({
      careEventCount: { total: counts.total, clean: counts.clean, expedition: counts.expedition },
      fragments: getFragments(),
      evolutionCount: countEvolutions(),
    });
    const newly = [];
    for (const id of unlocked) {
      const result = db
        .query("INSERT OR IGNORE INTO magpie_pet_achievements (achievement_id, unlocked_at) VALUES (?, ?)")
        .run(id, nowMs);
      if (result.changes > 0) {
        newly.push(id);
        insertEvent("global", "achievement", id, null, nowMs);
      }
    }
    return newly;
  }

  function listAchievements() {
    return db
      .query("SELECT achievement_id FROM magpie_pet_achievements ORDER BY unlocked_at, achievement_id")
      .all()
      .map((row) => row.achievement_id);
  }

  function readPetName(partnerId) {
    const row = db
      .query("SELECT name FROM magpie_pet_names WHERE partner_id = ?")
      .get(partnerId);
    return row ? row.name : null;
  }

  function writePetName(partnerId, name, nowMs) {
    db.query(
      `INSERT INTO magpie_pet_names (partner_id, name, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(partner_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ).run(partnerId, name, nowMs);
  }

  function countFedRequestsToday(partnerId, startMs, endMs) {
    if (!tableExists("usage_receipts")) return 0;
    // usage_receipts.created_at is a UTC ISO string; bracket the local day by
    // instant so the count matches the local calendar date.
    const row = db
      .query(
        "SELECT COUNT(*) AS c FROM usage_receipts WHERE partner_id = ? AND created_at >= ? AND created_at < ?",
      )
      .get(partnerId, new Date(startMs).toISOString(), new Date(endMs).toISOString());
    return row.c;
  }

  function computeDailyGoals(partnerId, nowMs) {
    const date = localDateString(nowMs);
    const { startMs, endMs } = localDayRangeMs(nowMs);
    const careEventsToday = db
      .query(
        "SELECT COUNT(*) AS c FROM magpie_pet_care_events WHERE partner_id = ? AND kind = 'care' AND created_at >= ? AND created_at < ?",
      )
      .get(partnerId, startMs, endMs).c;
    const expeditionClaimsToday = db
      .query(
        "SELECT COUNT(*) AS c FROM magpie_pet_care_events WHERE partner_id = ? AND kind = 'expedition' AND created_at >= ? AND created_at < ?",
      )
      .get(partnerId, startMs, endMs).c;
    const fedRequestsToday = countFedRequestsToday(partnerId, startMs, endMs);
    return evaluateDailyGoals({ careEventsToday, fedRequestsToday, expeditionClaimsToday }).map((goal) => {
      const stored = db
        .query("SELECT reward_claimed FROM magpie_pet_daily WHERE date = ? AND goal_id = ?")
        .get(date, goal.id);
      return { ...goal, rewardClaimed: stored?.reward_claimed === 1 };
    });
  }

  // Recomputes today's goals and grants each done goal's reward at most once.
  function sweepDailyGoals(partnerId, nowMs) {
    const date = localDateString(nowMs);
    const goals = computeDailyGoals(partnerId, nowMs);
    return goals.map((goal) => {
      db.query(
        `INSERT INTO magpie_pet_daily (date, goal_id, progress, done, reward_claimed, claimed_at)
         VALUES (?, ?, ?, ?, 0, NULL)
         ON CONFLICT(date, goal_id) DO UPDATE SET progress = excluded.progress, done = excluded.done`,
      ).run(date, goal.id, goal.progress, goal.done ? 1 : 0);
      let rewardClaimed = goal.rewardClaimed;
      if (goal.done && !rewardClaimed) {
        const reward = DAILY_GOAL_REWARDS[goal.id] ?? 0;
        if (reward > 0) addFragments(reward, nowMs);
        db.query(
          "UPDATE magpie_pet_daily SET reward_claimed = 1, claimed_at = ? WHERE date = ? AND goal_id = ?",
        ).run(nowMs, date, goal.id);
        insertEvent(partnerId, "daily", goal.id, null, nowMs);
        rewardClaimed = true;
      }
      return { ...goal, rewardClaimed };
    });
  }

  function assertReadable() {
    if (closed) throw new Error("care store is closed");
  }

  const txPerformAction = db.transaction((partnerId, action, nowMs, context) => {
    const state = currentState(partnerId, nowMs);
    const result = applyCareAction(state, action, nowMs, context ?? {});
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
    writeCareState(result.state);
    insertEvent(partnerId, "care", action, result.message, nowMs);
    sweepDailyGoals(partnerId, nowMs);
    const achievements = unlockAchievements(nowMs);
    return { ok: true, message: result.message, state: result.state, achievements };
  });

  const txResetCareUses = db.transaction((partnerId, nowMs) => {
    const state = currentState(partnerId, nowMs);
    const hasUses = (state.burstUses?.snack ?? 0) > 0 || (state.burstUses?.play ?? 0) > 0;
    const hasCooldown = (state.cooldowns.snack ?? 0) > nowMs || (state.cooldowns.play ?? 0) > nowMs;
    if (!hasUses && !hasCooldown) {
      return { ok: false, reason: "nothing-to-reset", message: "现在没有需要重置的照顾次数。" };
    }
    if (getFragments() < RESET_CARE_USES_COST) {
      return { ok: false, reason: "insufficient-fragments", message: "数据碎片不足，需要 2 个。" };
    }
    addFragments(-RESET_CARE_USES_COST, nowMs);
    const next = {
      ...state,
      cooldowns: { ...state.cooldowns, snack: 0, play: 0 },
      burstUses: { ...state.burstUses, snack: 0, play: 0 },
      updatedAt: nowMs,
    };
    writeCareState(next);
    const message = `消耗 ${RESET_CARE_USES_COST} 个数据碎片，点心和玩耍的可用次数已重置。`;
    insertEvent(partnerId, "system", "reset-care-uses", message, nowMs);
    return {
      ok: true,
      message,
      state: next,
      cost: RESET_CARE_USES_COST,
      fragments: getFragments(),
    };
  });

  const txStartExpedition = db.transaction((partnerId, kind, nowMs) => {
    const state = currentState(partnerId, nowMs);
    const result = ruleStartExpedition({
      careState: state,
      activeExpedition: runningExpedition(partnerId),
      kind,
      nowMs,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    writeCareState(result.careState);
    const expedition = result.expedition;
    db.query(
      `INSERT INTO magpie_pet_expeditions (expedition_id, partner_id, kind, status, started_at, ends_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      expedition.expeditionId,
      expedition.partnerId,
      expedition.kind,
      expedition.status,
      expedition.startedAt,
      expedition.endsAt,
    );
    insertEvent(partnerId, "expedition-start", kind, null, nowMs);
    return { ok: true, expedition, state: result.careState };
  });

  const txClaimExpedition = db.transaction((expeditionId, nowMs) => {
    const row = db
      .query("SELECT * FROM magpie_pet_expeditions WHERE expedition_id = ?")
      .get(expeditionId);
    const expedition = row ? rowToExpedition(row) : null;
    const result = ruleClaimExpedition({ expedition, nowMs, random: Math.random });
    if (!result.ok) return { ok: false, reason: result.reason };
    const state = currentState(expedition.partnerId, nowMs);
    const nextState = { ...state, bond: Math.min(100, state.bond + result.reward.bond), updatedAt: nowMs };
    writeCareState(nextState);
    // 每日上限：到手多少就记多少，界面和流水都按实发算
    const granted = addFragments(result.reward.fragments, nowMs);
    const reward = { ...result.reward, fragments: granted, capped: granted < result.reward.fragments };
    db.query(
      "UPDATE magpie_pet_expeditions SET status = 'claimed', claimed_at = ?, fragments = ?, bond = ?, note = ? WHERE expedition_id = ?",
    ).run(nowMs, reward.fragments, reward.bond, reward.note, expeditionId);
    insertEvent(expedition.partnerId, "expedition", expedition.kind, reward.note, nowMs);
    sweepDailyGoals(expedition.partnerId, nowMs);
    const achievements = unlockAchievements(nowMs);
    return { ok: true, expeditionId, reward, achievements };
  });

  const txEquipDecoration = db.transaction((decorationId, nowMs) => {
    const def = DECORATIONS[decorationId];
    if (!def) return { ok: false, reason: "unknown-decoration" };
    const owned = db
      .query("SELECT item_id FROM magpie_pet_inventory WHERE item_id = ? AND kind = 'decoration'")
      .get(decorationId);
    if (!owned) {
      const fragments = getFragments();
      if (fragments < def.price) return { ok: false, reason: "insufficient-fragments" };
      addFragments(-def.price);
      db.query(
        "INSERT INTO magpie_pet_inventory (item_id, kind, quantity, equipped) VALUES (?, 'decoration', 1, 0)",
      ).run(decorationId);
      insertEvent("global", "decoration", decorationId, null, nowMs);
    }
    db.query("UPDATE magpie_pet_inventory SET equipped = 0 WHERE kind = 'decoration'").run();
    db.query("UPDATE magpie_pet_inventory SET equipped = 1 WHERE item_id = ?").run(decorationId);
    const achievements = unlockAchievements(nowMs);
    return { ok: true, equippedTheme: decorationId, fragments: getFragments(), achievements };
  });

  return {
    getCareSnapshot(partnerId, nowMs) {
      assertReadable();
      // Read path only: decay is computed in memory, rewards/achievements are
      // granted by the write paths (actions, expedition claims), not by GET.
      const state = currentState(partnerId, nowMs);
      return {
        partnerId,
        petName: readPetName(partnerId),
        state,
        summary: careSummary(state),
        activeExpedition: runningExpedition(partnerId),
        daily: { date: localDateString(nowMs), goals: computeDailyGoals(partnerId, nowMs) },
        achievements: listAchievements(),
      };
    },

    performAction(partnerId, action, nowMs, context) {
      if (closed) return { ok: false, reason: "closed" };
      return txPerformAction(partnerId, action, nowMs, context);
    },

    resetCareUses(partnerId, nowMs) {
      if (closed) return { ok: false, reason: "closed" };
      return txResetCareUses(partnerId, nowMs);
    },

    startExpedition(partnerId, kind, nowMs) {
      if (closed) return { ok: false, reason: "closed" };
      return txStartExpedition(partnerId, kind, nowMs);
    },

    claimExpedition(expeditionId, nowMs) {
      if (closed) return { ok: false, reason: "closed" };
      return txClaimExpedition(expeditionId, nowMs);
    },

    equipDecoration(decorationId) {
      if (closed) return { ok: false, reason: "closed" };
      return txEquipDecoration(decorationId, Date.now());
    },

    getSetting(key, fallback = null) {
      assertReadable();
      const row = db.query("SELECT value FROM magpie_pet_settings WHERE key = ?").get(String(key));
      return row ? row.value : fallback;
    },

    setSetting(key, value) {
      if (closed) return { ok: false, reason: "closed" };
      db.query(
        "INSERT INTO magpie_pet_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(key), String(value));
      return { ok: true };
    },

    getPetName(partnerId) {
      assertReadable();
      return readPetName(partnerId);
    },

    renamePet(partnerId, name, nowMs) {
      if (closed) return { ok: false, reason: "closed" };
      const clean = String(name ?? "").trim().replace(/\s+/g, " ");
      if (clean.length < 1 || clean.length > 20) return { ok: false, reason: "invalid-name" };
      const run = db.transaction(() => {
        writePetName(partnerId, clean, nowMs);
        insertEvent(partnerId, "system", "rename", `给它取名为「${clean}」`, nowMs);
      });
      run();
      return { ok: true, name: clean };
    },

    getCollection() {
      assertReadable();
      const decorations = db
        .query("SELECT item_id, equipped FROM magpie_pet_inventory WHERE kind = 'decoration' ORDER BY item_id")
        .all();
      const equipped = decorations.find((row) => row.equipped === 1);
      const today = localDateString(Date.now());
      return {
        fragments: getFragments(),
        unlocked: decorations.map((row) => row.item_id),
        equippedTheme: equipped ? equipped.item_id : null,
        achievements: listAchievements(),
        earnedToday: fragmentsEarnedToday(today),
        dailyCap: DAILY_FRAGMENT_CAP,
      };
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
