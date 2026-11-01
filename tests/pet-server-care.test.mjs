// tests/pet-server-care.test.mjs
// Contract for the page server care API (Task 5): /api/state gains
// care/expedition/collection/daily/frame/frames, /api/command gains the
// pet-* whitelist with strict 400s, static files stay inside page/, and
// close() is idempotent and actually refuses new connections.
//
// All requests go through node:http directly to 127.0.0.1: the shell has
// HTTP_PROXY set with an empty NO_PROXY, so Bun's fetch would be answered
// by the proxy (502) and can neither prove the server is up nor down.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

import { createPetAdapter, stageThresholds } from "../lib/pet.adapter.mjs";
import { createPetServer } from "../lib/pet.server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

const tempPaths = [];
function freshDbPath() {
  const filePath = join(tmpdir(), `pet-server-care-test-${randomUUID()}.db`);
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

let authToken = "";

// node:http request that never touches HTTP_PROXY.
function httpJson(port, path, { method = "GET", body, headers = {} } = {}) {
  const tokenHeaders = path.startsWith("/api/") && path !== "/api/ping" ? { "x-magpie-pet-token": authToken } : {};
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        timeout: 5000,
        headers: body === undefined ? { ...tokenHeaders, ...headers } : { "content-type": "application/json", ...tokenHeaders, ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // leave json null for non-JSON bodies
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function withRawDb(databasePath, fn) {
  const db = new Database(databasePath);
  db.run("PRAGMA busy_timeout = 5000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- group A --
// server over a fresh db with one spawned partner
const dbA = freshDbPath();
const adapterA = createPetAdapter({ databasePath: dbA, notifyGate: () => false });
await adapterA.runCommand("digital-pet-spawn");
const serverA = createPetServer({ adapter: adapterA, port: 0, notifyGate: () => false });
assert.equal(await serverA.start(), true);
authToken = serverA.apiToken;

await test("local service is loopback-only and token-guarded", async () => {
  const state = await httpJson(serverA.port, "/api/state");
  assert.equal(state.status, 200);
  assert.notEqual(state.headers["access-control-allow-origin"], "*");

  const evil = await httpJson(serverA.port, "/api/state", {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(evil.status, 403);

  const noToken = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-rename", args: "pwned" },
    headers: { "x-magpie-pet-token": "" },
  });
  assert.equal(noToken.status, 403);

  const preflight = await httpJson(serverA.port, "/api/command", {
    method: "OPTIONS",
    headers: {
      origin: "null",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type, x-magpie-pet-token",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "null");
  assert.match(preflight.headers["access-control-allow-methods"], /POST/);
  assert.match(preflight.headers["access-control-allow-headers"], /x-magpie-pet-token/i);
});

await test("state exposes default care snapshot, collection and frames after spawn", async () => {
  const res = await httpJson(serverA.port, "/api/state");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/json/);
  const state = res.json;
  assert.equal(state.ok, true);
  assert.equal(typeof state.partner.id, "string");

  const care = state.care;
  assert.equal(care.state.partnerId, state.partner.id);
  // a few milliseconds of natural decay may pass between spawn and this read
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.1, `${actual} !~ ${expected}`);
  near(care.state.satiety, 72);
  near(care.state.mood, 70);
  near(care.state.energy, 80);
  near(care.state.hygiene, 75);
  near(care.state.bond, 0);
  assert.equal(typeof care.summary.moodLabel, "string");

  assert.equal(state.expedition, null);
  assert.equal(typeof state.daily.date, "string");
  assert.equal(state.daily.goals.length, 3);

  assert.equal(state.collection.fragments, 0);
  // 新存档自带「阳光村落」
  assert.deepEqual(state.collection.unlocked, ["village"]);
  assert.equal(state.collection.equippedTheme, "village");

  // 帧目录已从上游 TUI 包恢复：当前物种应带一组具名像素帧
  assert.equal(typeof state.frame?.content, "string");
  assert.ok(state.frame.content.split("\n").length > 4, "expected multi-row pixel art");
  assert.ok(Object.keys(state.frames || {}).length >= 2, "expected several named frames");
  assert.equal(state.petName, null);
  assert.equal(Array.isArray(state.dex), true);
  assert.equal(state.dex.length, 650);
  // 手上这颗蛋也算背包里的一件（否则背包里空着，看不见自己有的蛋）
  assert.equal(state.dex.filter((d) => d.unlocked).length, 1);
  assert.equal(state.dex.find((d) => d.id === "0-001").current, true);
  assert.equal(state.dex.find((d) => d.id === "0-001").unlocked, true);
});

await test("bag only holds the forms you currently own; history stays locked", async () => {
  let partnerId = null;
  withRawDb(dbA, (db) => {
    partnerId = db.query("SELECT partner_id FROM partners WHERE retired_at IS NULL LIMIT 1").get().partner_id;
    db.run(
      `INSERT INTO partner_events (event_id, partner_id, kind, current_node_id, gauge, is_terminal, token_delta, receipt_key, created_at)
       VALUES (?, ?, 'evolved', '2-001', 0, 0, NULL, NULL, ?)`,
      ["dex-lineage-test", partnerId, new Date().toISOString()],
    );
  });

  const state = await httpJson(serverA.port, "/api/state");
  assert.equal(state.status, 200);
  // 只出现在进化史里的形态不算背包，但可以展示
  const history = state.json.dex.find((d) => d.id === "2-001");
  assert.equal(history.unlocked, false);
  assert.equal(history.viewable, true);
  // 手上这颗蛋也算背包里的一件，并且带持有数量
  const unlocked = state.json.dex.filter((d) => d.unlocked).map((d) => d.id);
  assert.deepEqual(unlocked, ["0-001"]);
  const eggRow = state.json.dex.find((d) => d.id === "0-001");
  assert.equal(typeof eggRow.owned, "number");
  assert.equal(eggRow.owned >= 1, true);
  assert.equal(state.json.partner.id, partnerId);
  assert.equal(state.json.partners.length, 1);
});

await test("rename stores a per-partner display name", async () => {
  const renamed = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-rename", args: "小豆子" },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.state.petName, "小豆子");
  assert.equal(renamed.json.state.care.petName, "小豆子");

  const invalid = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-rename", args: " ".repeat(30) },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.reason, "invalid-name");
});

await test("care commands mutate state, return {text,toasts,state} and respect cooldowns", async () => {
  const fed = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-feed-snack" },
  });
  assert.equal(fed.status, 200);
  assert.match(fed.headers["content-type"], /application\/json/);
  assert.ok(fed.json.text.length > 0);
  assert.ok(Array.isArray(fed.json.toasts));
  // 72 + 10, minus a few milliseconds of decay before the snapshot
  assert.ok(fed.json.state.care.state.satiety > 81.9 && fed.json.state.care.state.satiety <= 82);

  const again = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-feed-snack" },
  });
  assert.equal(again.status, 400);
  assert.equal(again.json.reason, "cooldown");
  assert.equal(typeof again.json.error, "string");

  const pet = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-pet-egg" },
  });
  assert.equal(pet.status, 200);
  assert.equal(pet.json.state.care.state.bond, 2);

  const unknown = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "rm -rf" },
  });
  assert.equal(unknown.status, 400);
  assert.equal(typeof unknown.json.error, "string");
  assert.equal(typeof unknown.json.reason, "string");
});

await test("pet-pet-egg is rejected with HTTP 400 once the partner leaves the egg stage", async () => {
  withRawDb(dbA, (db) => {
    db.run("UPDATE partners SET current_node_id = '1-001' WHERE retired_at IS NULL");
    // clear the cooldown from the earlier pet so the stage rule is what fires
    db.run("UPDATE magpie_pet_care_state SET cooldown_pet_egg = 0");
  });
  const res = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-pet-egg" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.reason, "wrong-stage");
  withRawDb(dbA, (db) => {
    db.run("UPDATE partners SET current_node_id = '0-001' WHERE retired_at IS NULL");
  });
});

await test("相克试炼: a wrong attribute costs half the bar, the next attempt always wins", async () => {
  // 3-001 Agumon 的属性是 vaccine；能克制它的只有 data
  const seedBattle = () => {
    withRawDb(dbA, (db) => {
      db.run("UPDATE partners SET current_node_id = '1-001', gauge = 10000000, battle_opponent_node_id = '3-001' WHERE retired_at IS NULL");
      db.run(
        "INSERT INTO partner_combat_progress (partner_id, node_id, victories, battle_id) VALUES ((SELECT partner_id FROM partners WHERE retired_at IS NULL LIMIT 1), '1-001', 2, 'test-battle-id') ON CONFLICT(partner_id) DO UPDATE SET node_id = '1-001', victories = 2, battle_id = 'test-battle-id'",
      );
    });
  };
  const losses = () =>
    withRawDb(dbA, (db) => {
      try {
        return db.query("SELECT losses FROM magpie_pet_battle_retries").get()?.losses ?? 0;
      } catch {
        return 0;
      }
    });

  // 没选属性 → 400
  seedBattle();
  const noPick = await httpJson(serverA.port, "/api/command", { method: "POST", body: { name: "pet-battle" } });
  assert.equal(noPick.status, 400);
  assert.equal(noPick.json.reason, "attribute-required");

  // 选了不克制的 vaccine → 败北，gauge 减半，记一次连败
  const lost = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-battle", args: "vaccine" },
  });
  assert.equal(lost.status, 200);
  assert.match(lost.json.text, /试炼失败/);
  assert.match(lost.json.text, /下一场必胜/);
  assert.equal(lost.json.state.partner.battle, null);
  assert.equal(lost.json.state.partner.gauge, 5000000, "loss must halve the gauge, not wipe it");
  assert.equal(losses(), 1);

  // 第二次：同样选错也必胜（连败规则保留）
  seedBattle();
  const rematch = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-battle", args: "vaccine" },
  });
  assert.equal(rematch.status, 200);
  assert.match(rematch.json.text, /相克成功/);
  assert.equal(rematch.json.state.partner.battle, null);
  assert.equal(rematch.json.state.partner.gauge, 0);
  assert.equal(losses(), 0, "win must clear the loss streak");

  // 选对了（data 克 vaccine）→ 直接成功
  seedBattle();
  const right = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-battle", args: "data" },
  });
  assert.equal(right.status, 200);
  assert.match(right.json.text, /相克成功/);
  assert.equal(right.json.state.partner.battle, null);

  const idle = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-battle", args: "data" },
  });
  assert.equal(idle.status, 400);
  assert.equal(idle.json.reason, "no-pending-battle");
});

await test("pet-display only changes display, never pins; unpin clears both", async () => {
  // 塞一只退役伙伴让图鉴里有第二只可展示
  withRawDb(dbA, (db) => {
    db.run(
      "INSERT INTO partners (partner_id, generation, current_node_id, gauge, is_terminal, created_at, retired_at) VALUES ('partner-display-test', 99, '1-001', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
    );
  });
  try {

  const show = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-display", args: "1-001" },
  });
  assert.equal(show.status, 200);
  assert.equal(show.json.state.displaying, "1-001");
  assert.equal(show.json.state.pinned, null, "display switch must never set the pin");
  assert.equal(show.json.state.partner.node.id, "1-001");

  const back = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-display", args: "1-001" },
  });
  assert.equal(back.status, 200);
  assert.equal(back.json.state.displaying, null, "clicking the shown one again returns to the real partner");

  const locked = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-display", args: "7-001" },
  });
  assert.equal(locked.status, 400);
  assert.equal(locked.json.reason, "not-unlocked");

  // 钉住 + 展示叠加时，取消钉住两个一起清
  await httpJson(serverA.port, "/api/command", { method: "POST", body: { name: "pet-display", args: "1-001" } });
  withRawDb(dbA, (db) => {
    db.run("UPDATE vpet_control_state SET cheat_node_id = '1-001' WHERE control_id = 1");
  });
  const unpin = await httpJson(serverA.port, "/api/command", { method: "POST", body: { name: "pet-unpin" } });
  assert.equal(unpin.status, 200);
  assert.equal(unpin.json.state.pinned, null);
  assert.equal(unpin.json.state.displaying, null);

  } finally {
    withRawDb(dbA, (db) => {
      db.run("DELETE FROM partners WHERE partner_id = 'partner-display-test'");
      db.run("UPDATE vpet_control_state SET cheat_node_id = NULL WHERE control_id = 1");
      db.run("CREATE TABLE IF NOT EXISTS magpie_pet_display_state (control_id INTEGER PRIMARY KEY CHECK (control_id = 1), node_id TEXT)");
      db.run("DELETE FROM magpie_pet_display_state");
    });
  }
});

await test("panel follows the displayed partner: its own generation, gauge and stage bar", async () => {
  withRawDb(dbA, (db) => {
    db.run(
      `INSERT INTO partners (partner_id, generation, current_node_id, gauge, is_terminal, created_at, retired_at)
       VALUES ('partner-view-test', 7, '2-001', 1234567, 0, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
    );
    // 出战那只挪到别的节点，确保「展示覆盖」和它在役形态不是同一个
    db.run("UPDATE partners SET current_node_id = '0-001', gauge = 0 WHERE retired_at IS NULL");
    db.run("CREATE TABLE IF NOT EXISTS magpie_pet_display_state (control_id INTEGER PRIMARY KEY CHECK (control_id = 1), node_id TEXT)");
    db.run(
      "INSERT INTO magpie_pet_display_state (control_id, node_id) VALUES (1, '2-001') ON CONFLICT(control_id) DO UPDATE SET node_id = excluded.node_id",
    );
  });
  try {
    const shown = await httpJson(serverA.port, "/api/state");
    const p = shown.json.partner;
    assert.equal(p.node.id, "2-001", "display override shows the other species");
    assert.equal(p.displayingOther, true);
    // 面板跟着展示的那只：gen / gauge / 槽 都是它自己的
    assert.equal(p.generation, 7);
    assert.equal(p.gauge, 1234567);
    assert.equal(p.threshold, stageThresholds()[2]);
    assert.equal(p.stageName, "baby II");
    assert.equal(p.growing, false, "展示中的那只不是出战伙伴");
    // 出战那只的数字仍然单独给出来
    assert.equal(p.engineGauge >= 0, true);
    assert.equal(typeof p.engineGeneration, "number");
  } finally {
    withRawDb(dbA, (db) => {
      db.run("DELETE FROM magpie_pet_display_state");
      db.run("DELETE FROM partners WHERE partner_id = 'partner-view-test'");
    });
  }
});

await test("dev unlock_all flag unlocks the whole dex and the display switch", async () => {
  const before = await httpJson(serverA.port, "/api/state");
  const lockedBefore = before.json.dex.filter((d) => !d.unlocked).length;
  assert.ok(lockedBefore > 600, "fixture should start nearly all locked");

  withRawDb(dbA, (db) => {
    db.run("CREATE TABLE IF NOT EXISTS magpie_pet_dev_mode (control_id INTEGER PRIMARY KEY CHECK (control_id = 1), unlock_all INTEGER NOT NULL DEFAULT 0)");
    db.run("INSERT INTO magpie_pet_dev_mode (control_id, unlock_all) VALUES (1, 1)");
  });
  try {
    const unlocked = await httpJson(serverA.port, "/api/state");
    assert.equal(unlocked.json.unlockAll, true);
    assert.equal(unlocked.json.dex.filter((d) => !d.unlocked).length, 0, "every dex entry must be unlocked");

    const show = await httpJson(serverA.port, "/api/command", {
      method: "POST",
      body: { name: "pet-display", args: "7-001" },
    });
    assert.equal(show.status, 200, "dev mode must allow displaying any species");
    assert.equal(show.json.state.displaying, "7-001");
    await httpJson(serverA.port, "/api/command", { method: "POST", body: { name: "pet-display", args: "7-001" } });
  } finally {
    withRawDb(dbA, (db) => {
      db.run("DELETE FROM magpie_pet_dev_mode");
      db.run("CREATE TABLE IF NOT EXISTS magpie_pet_display_state (control_id INTEGER PRIMARY KEY CHECK (control_id = 1), node_id TEXT)");
      db.run("DELETE FROM magpie_pet_display_state");
    });
  }
});

await test("expedition commands validate kind, single active expedition and double claims", async () => {
  const badKind = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-start", args: "moon" },
  });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.json.reason, "unknown-expedition");

  const start = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-start", args: "patrol" },
  });
  assert.equal(start.status, 200);
  const expedition = start.json.state.expedition;
  assert.equal(expedition.kind, "patrol");
  assert.equal(expedition.status, "running");

  const second = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-start", args: "field" },
  });
  assert.equal(second.status, 400);
  assert.equal(second.json.reason, "expedition-active");

  const wrongId = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-claim", args: "exp-does-not-exist" },
  });
  assert.equal(wrongId.status, 400);
  assert.equal(wrongId.json.reason, "no-expedition");

  const early = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-claim", args: expedition.expeditionId },
  });
  assert.equal(early.status, 400);
  assert.equal(early.json.reason, "not-finished");

  withRawDb(dbA, (db) => {
    db.query("UPDATE magpie_pet_expeditions SET ends_at = 0 WHERE expedition_id = ?").run(expedition.expeditionId);
  });
  const claim = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-claim", args: expedition.expeditionId },
  });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.state.expedition, null);
  assert.ok(claim.json.state.collection.fragments >= 3);

  const duplicate = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-expedition-claim", args: expedition.expeditionId },
  });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.json.reason, "already-claimed");
});

await test("decoration equip validates the id and the fragment balance", async () => {
  const badId = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-decoration-equip", args: "rainbow" },
  });
  assert.equal(badId.status, 400);
  assert.equal(badId.json.reason, "unknown-decoration");

  // patrol claim paid 3 (+5 daily-goal rewards) — not enough for meadow (10)
  const poor = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-decoration-equip", args: "meadow" },
  });
  assert.equal(poor.status, 400);
  assert.equal(poor.json.reason, "insufficient-fragments");

  withRawDb(dbA, (db) => {
    db.run(
      "INSERT INTO magpie_pet_inventory (item_id, kind, quantity, equipped) VALUES ('fragments', 'currency', 100, 0) ON CONFLICT(item_id) DO UPDATE SET quantity = quantity + 100",
    );
  });
  const equip = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-decoration-equip", args: "meadow" },
  });
  assert.equal(equip.status, 200);
  assert.equal(equip.json.state.collection.equippedTheme, "meadow");
  assert.ok(equip.json.state.collection.unlocked.includes("meadow"));
});

await test("unknown pet-expedition-* commands are rejected as unknown-command without side effects", async () => {
  // regression: the care whitelist used startsWith("pet-expedition-"), so any
  // pet-expedition-* name fell through to the decoration-equip branch and
  // spent fragments. Unknown names must be rejected before any mutation.
  const before = await httpJson(serverA.port, "/api/state");
  assert.equal(before.status, 200);
  const fragmentsBefore = before.json.collection.fragments;
  const themeBefore = before.json.collection.equippedTheme;

  for (const name of ["pet-expedition-nonsense", "pet-expedition-claimm"]) {
    const res = await httpJson(serverA.port, "/api/command", {
      method: "POST",
      body: { name, args: "meadow" },
    });
    assert.equal(res.status, 400, `${name} must be rejected`);
    assert.equal(res.json.reason, "unknown-command", `${name} reason`);
  }

  const after = await httpJson(serverA.port, "/api/state");
  assert.equal(after.status, 200);
  assert.equal(after.json.collection.fragments, fragmentsBefore);
  assert.equal(after.json.collection.equippedTheme, themeBefore);
});

await test("engine set is a display cheat, not the 出战 lock; unbinding returns to the default partner", async () => {
  const set = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "digital-pet-set", args: "1-001" },
  });
  assert.equal(set.status, 200);
  assert.ok(set.json.state.partner);
  // 引擎的 cheat 位只换展示，不参与「出战锁定」
  assert.equal(set.json.state.pinned, null, "engine cheat must not read as the 出战 lock");
  assert.equal(set.json.state.partner.node.id, "1-001");
  assert.equal(set.json.state.partner.engineNode.id, "0-001");
  assert.ok(set.json.state.care);

  const badSet = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "digital-pet-set", args: "DROP TABLE" },
  });
  assert.equal(badSet.status, 400);
  assert.equal(typeof badSet.json.reason, "string");

  const unpin = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "pet-unpin" },
  });
  assert.equal(unpin.status, 200);
  assert.equal(unpin.json.state.pinned, null);
  assert.equal(unpin.json.state.partner.node.id, "0-001");
});

await test("pet-poll-now triggers one manual poll and reports how many rows landed", async () => {
  let calls = 0;
  const pollServer = createPetServer({
    adapter: adapterA,
    port: 0,
    notifyGate: () => false,
    pollNow: async () => {
      calls += 1;
      return 2;
    },
  });
  assert.equal(await pollServer.start(), true);
  try {
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: pollServer.port, path: "/api/command", method: "POST", headers: { "content-type": "text/plain", "x-magpie-pet-token": pollServer.apiToken } },
        (r) => {
          let text = "";
          r.on("data", (c) => (text += c));
          r.on("end", () => resolve({ status: r.statusCode, json: JSON.parse(text) }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ name: "pet-poll-now" }));
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 1, "one click = exactly one poll");
    assert.ok(res.json.text.includes("2"), "reports how many rows were fed");
  } finally {
    await pollServer.close();
  }
});

await test("pin chooses which partner grows; unpin falls back to the first partner", async () => {
  withRawDb(dbA, (db) => {
    db.run(
      `INSERT INTO partners (partner_id, generation, current_node_id, gauge, is_terminal, created_at, retired_at)
       VALUES ('partner-pin-test', 50, '1-003', 12345, 0, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
    );
    db.run("CREATE TABLE IF NOT EXISTS magpie_pet_pin (control_id INTEGER PRIMARY KEY CHECK (control_id = 1), partner_id TEXT NOT NULL, node_id TEXT NOT NULL)");
    db.run("DELETE FROM magpie_pet_pin");
  });
  try {
    const pin = await httpJson(serverA.port, "/api/command", {
      method: "POST",
      body: { name: "pet-pin", args: "1-003" },
    });
    assert.equal(pin.status, 200);
    assert.equal(pin.json.state.pinned, "1-003");
    // 钉住 = 换吃经验的那只：退役的清掉，principal 换过去
    assert.equal(pin.json.state.partner.engineNode.id, "1-003");
    assert.equal(pin.json.state.partner.gauge, 12345);

    // 只换视角不动出战锁定
    await httpJson(serverA.port, "/api/command", { method: "POST", body: { name: "pet-display", args: "0-001" } });
    const shown = await httpJson(serverA.port, "/api/state");
    assert.equal(shown.json.state?.pinned ?? shown.json.pinned, "1-003");
    assert.equal(shown.json.partner.engineNode.id, "1-003");
    assert.equal(shown.json.partner.node.id, "0-001", "display override still only affects the sprite/name side");

    const unpin = await httpJson(serverA.port, "/api/command", {
      method: "POST",
      body: { name: "pet-unpin" },
    });
    assert.equal(unpin.status, 200);
    assert.equal(unpin.json.state.pinned, null);
    // 没有锁定 = 默认第一只（generation 最小）出战
    assert.equal(unpin.json.state.partner.engineNode.id, "0-001");

    const stranger = await httpJson(serverA.port, "/api/command", {
      method: "POST",
      body: { name: "pet-pin", args: "7-001" },
    });
    assert.equal(stranger.status, 400);
    assert.equal(stranger.json.reason, "not-a-partner");
  } finally {
    withRawDb(dbA, (db) => {
      db.run("DELETE FROM partners WHERE partner_id = 'partner-pin-test'");
      db.run("DELETE FROM magpie_pet_pin");
    });
  }
});

await test("spawn is gated by the egg counter alone and hands out an unknown egg", async () => {
  // 开局（伙伴还是蛋）→ 计数器 0，没变化过，不给
  const first = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "digital-pet-spawn" },
  });
  assert.equal(first.status, 400);
  assert.equal(first.json.reason, "egg-counter-unchanged");

  // 把这只养到 baby II（计数器 0 → 2）就解锁一次
  withRawDb(dbA, (db) => {
    db.run("UPDATE partners SET current_node_id = '2-001' WHERE retired_at IS NULL");
  });
  const before = await httpJson(serverA.port, "/api/state");
  assert.equal(before.json.eggCounter, 2);
  assert.equal(before.json.eggReady, true);

  const spawn = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "digital-pet-spawn" },
  });
  assert.equal(spawn.status, 200);
  const state = spawn.json.state;
  assert.equal(state.partner.generation, 2);
  assert.equal(state.partner.node.id, "0-001", "新拿到的就是一颗未知的蛋");
  assert.equal(state.partner.node.stage, 0);
  assert.equal(state.partner.gauge, 0);
  assert.equal(state.partner.battle, null);
  assert.equal(state.care.state.partnerId, state.partner.id);

  // 领完快照，计数器没再动 → 不给第二颗
  const again = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "digital-pet-spawn" },
  });
  assert.equal(again.status, 400);
  assert.equal(again.json.reason, "egg-counter-unchanged");

  // 让上一代再进化一次（2 → 3），计数器变化 → 又给一颗
  withRawDb(dbA, (db) => {
    db.run("UPDATE partners SET current_node_id = '3-001' WHERE partner_id = 'partner-1'");
  });
  const third = await httpJson(serverA.port, "/api/command", {
    method: "POST",
    body: { name: "digital-pet-spawn" },
  });
  assert.equal(third.status, 200);
  assert.equal(third.json.state.partner.node.id, "0-001");
});

await test("static files are confined to the page directory", async () => {
  // WHATWG URL normalizes %2e%2e away before we see it; either way the
  // package.json outside page/ must not be served
  const escape = await httpJson(serverA.port, "/%2e%2e/package.json");
  assert.notEqual(escape.status, 200);
  assert.ok(!escape.text.includes('"name"'));

  // %2f survives URL normalization; after decoding it must hit the 403 guard
  const escapeSlash = await httpJson(serverA.port, "/%2e%2e%2fpackage.json");
  assert.equal(escapeSlash.status, 403);
  assert.ok(!escapeSlash.text.includes('"name"'));

  const escapeDeep = await httpJson(serverA.port, "/%2e%2e%2f%2e%2e%2fpackage.json");
  assert.equal(escapeDeep.status, 403);

  const page = await httpJson(serverA.port, "/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
});

await serverA.close();

// ---------------------------------------------------------------- group B --
// server over a fresh db with NO partner at all
const dbB = freshDbPath();
const serverB = createPetServer({ databasePath: dbB, port: 0, notifyGate: () => false });
assert.equal(await serverB.start(), true);
authToken = serverB.apiToken;

await test("state without an active partner reports nulls but keeps the collection readable", async () => {
  const res = await httpJson(serverB.port, "/api/state");
  assert.equal(res.status, 200);
  const state = res.json;
  assert.equal(state.care, null);
  assert.equal(state.expedition, null);
  assert.equal(state.daily, null);
  assert.equal(state.collection.fragments, 0);
  assert.equal(state.frame, null);
  assert.deepEqual(state.frames, {});

  const play = await httpJson(serverB.port, "/api/command", {
    method: "POST",
    body: { name: "pet-play" },
  });
  assert.equal(play.status, 400);
  assert.equal(play.json.reason, "no-active-partner");
});

await test("close() is idempotent and refuses new connections afterwards", async () => {
  const before = await httpJson(serverB.port, "/api/ping");
  assert.equal(before.status, 200);
  await serverB.close();
  await serverB.close(); // idempotent
  let refused = false;
  try {
    await httpJson(serverB.port, "/api/ping");
  } catch {
    refused = true;
  }
  assert.equal(refused, true);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
