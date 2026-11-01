// magpie-digital-pet · sidebar page server
//
// The page-chat pattern: magpie's plugin pages run in a sandboxed iframe with
// CSP connect-src 'none' — the only networking they may do is navigating
// themselves. So the sidebar "page" is a guide page (page/index.html + boot.js)
// that jumps to this local HTTP server, which serves the real dashboard and
// a small JSON API over pet.db.
//
// Binds 127.0.0.1 only. Fixed default port (3571) so the guide page can jump
// blindly — several host processes may load the plugin; the first one serves,
// the others see EADDRINUSE and quietly step aside (their watchers still run).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { createPetAdapter, nodeById, stageThresholds, DIGIMON_DATA } from "./pet.adapter.mjs";
import { createCareStore } from "./pet.care-store.mjs";
import { EXPEDITIONS } from "./pet.care-rules.mjs";
import { DECORATIONS } from "./pet.care-store.mjs";
import { chooseFrame, getSpriteFrames, loadMonsterFrames } from "./pet.frames.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../lib
const UI_ROOT = join(dirname(HERE), "page");

const DEFAULT_PORT = 3571;

// omnipet CC BY-NC PNG 精灵帧根目录（独立资产库，与插件代码分离部署）
const SPRITES_ROOT = join(dirname(HERE), "sprites");
const spriteMap = JSON.parse(readFileSync(join(HERE, "sprite-map.json"), "utf8"));

// 数码兽属性（Vaccine / Data / Virus），来自 digimon.net 官方图鉴；
// 进化对决的「相克试炼」靠它判定。抓不到的记 null（按"无属性"处理）。
const DIGIMON_ATTRIBUTES = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "digimon-attributes.json"), "utf8"));
  } catch {
    return {};
  }
})();
// 相克三角：疫苗 → 病毒 → 数据 → 疫苗
const ATTRIBUTE_COUNTERS = { vaccine: "virus", virus: "data", data: "vaccine" };
const ATTRIBUTE_LABELS = { vaccine: "疫苗", data: "数据", virus: "病毒" };
function attributeOf(nodeId) {
  const raw = DIGIMON_ATTRIBUTES[nodeId];
  return typeof raw === "string" ? raw.toLowerCase() : null;
}

// engine stage thresholds, read from the same settings file the engine uses
const STAGE_THRESHOLDS = stageThresholds();
const STAGE_NAMES = ["egg", "baby I", "baby II", "child", "adult", "perfect", "ultimate", "super ultimate"];
// Hatching a new egg is unlocked from baby II upward (stage 2+), not at baby II
// only: evolving past that stage keeps the unlock. A fresh egg starts at stage
// 0, so the gate closes again until the new partner itself reaches baby II.
const MIN_HATCH_STAGE = 2;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
};

function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function openReadOnly(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

// bun:sqlite 是同步调用，busy_timeout 设几秒就把宿主进程的事件循环
// 卡几秒（页面、watcher、同进程所有插件全冻住）。写操作统一走这里：
// 短超时 + 失败重试，任何路径都保证 close，不再泄漏连接。
async function withWritableDb(dbFile, fn, { attempts = 3, busyMs = 800 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rw = new Database(dbFile);
    rw.run(`PRAGMA busy_timeout = ${busyMs}`);
    try {
      return fn(rw);
    } catch (e) {
      lastErr = e;
      if (!/locked|busy/i.test(String(e?.message ?? e))) throw e;
      if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    } finally {
      try { rw.close(); } catch {}
    }
  }
  throw lastErr;
}

function nodeInfo(id) {
  const node = nodeById(id);
  if (!node) return { id, nameEn: id, nameJp: id, stage: 0, sprite: "egg", url: "" };
  return {
    id: node.id,
    nameEn: node.name_en,
    nameJp: node.name_jp,
    stage: node.stage,
    sprite: node.sprite,
    url: node.url,
  };
}

// the whole dashboard in one object
function readState(dbPath) {
  try {
    const db = openReadOnly(dbPath);
    try {
      const trainer = db.query("SELECT total_tokens FROM trainer_state WHERE trainer_id = 1").get();
      const control = db.query("SELECT frozen, cheat_node_id FROM vpet_control_state WHERE control_id = 1").get();
      const partner = db
        .query(
          `SELECT partner_id, generation, current_node_id, gauge, is_terminal,
                  pending_evolution_target_id, battle_opponent_node_id, created_at
           FROM partners
           WHERE partner_id = (SELECT principal_id FROM partner_team WHERE team_id = 1)
             AND retired_at IS NULL LIMIT 1`,
        )
        .get();
      const receipts = db.query("SELECT COUNT(*) c, SUM(token_delta) t, SUM(cost) s FROM usage_receipts").get();
      const events = db
        .query(
          `SELECT kind, current_node_id, gauge, token_delta, created_at
           FROM partner_events ORDER BY created_at DESC, event_id DESC LIMIT 12`,
        )
        .all();
      const partners = db
        .query(
          `SELECT generation, current_node_id, retired_at, created_at
           FROM partners ORDER BY generation ASC`,
        )
        .all();
      // 「曾经持有过」的形态：只用来判断能不能展示，不算进背包
      const lineage = db
        .query(
          `SELECT current_node_id AS id FROM partner_events WHERE current_node_id IS NOT NULL
           UNION
           SELECT current_node_id AS id FROM partners`,
        )
        .all()
        .map((row) => row.id);

      // 纯展示覆盖（图鉴“显示这只”）：与钉住（cheat_node_id，管理卡专属）
      // 完全分家——它只换页面显示，不带钉住徽标、不影响生长语义。
      let displayNodeId = null;
      try {
        displayNodeId =
          db.query("SELECT node_id FROM magpie_pet_display_state WHERE control_id = 1").get()?.node_id ?? null;
      } catch {
        displayNodeId = null; // 表还没建：没有任何覆盖
      }
      // 出战锁定（钉住）：记录「谁在吃经验」。与展示覆盖、与引擎的 cheat 位都分开。
      let pin = null;
      try {
        pin = db.query("SELECT partner_id, node_id FROM magpie_pet_pin WHERE control_id = 1").get() ?? null;
      } catch {
        pin = null; // 表还没建：没锁过
      }
      // 伙伴进化后，pin 里存的 node_id 会过期；以伙伴行当前形态为准
      if (pin) {
        try {
          const current = db.query("SELECT current_node_id FROM partners WHERE partner_id = ?").get(pin.partner_id);
          if (current?.current_node_id) pin = { ...pin, node_id: current.current_node_id };
        } catch {
          // 伙伴行没了：退回存的 node_id
        }
      }
      // 开发者模式：magpie_pet_dev_mode.unlock_all = 1 时图鉴全部解锁，
      // 只影响展示，不写伙伴表、不影响任何生长与成就。
      let unlockAll = false;
      try {
        unlockAll =
          db.query("SELECT unlock_all FROM magpie_pet_dev_mode WHERE control_id = 1").get()?.unlock_all === 1;
      } catch {
        unlockAll = false; // 表还没建：正常模式
      }
      const engineNode = partner ? nodeInfo(partner.current_node_id) : null;
      const shownId = displayNodeId ?? control?.cheat_node_id ?? null;
      const node = shownId ? nodeInfo(shownId) : engineNode;
      // 展示的形态如果对应某个伙伴存档，就把它自己的 gen / gauge 一起报上去：
      // 面板跟着「正在显示的那只」走，吃经验的仍然只有出战那只。
      let shownPartner = null;
      if (shownId) {
        try {
          shownPartner =
            db
              .query(
                `SELECT partner_id, generation, current_node_id, gauge, is_terminal, battle_opponent_node_id, created_at
                 FROM partners WHERE current_node_id = ?
                 ORDER BY (retired_at IS NULL) DESC, generation DESC LIMIT 1`,
              )
              .get(shownId) ?? null;
        } catch {
          shownPartner = null;
        }
      }
      const viewPartner = shownPartner ?? (shownId ? null : partner);
      const viewNode = shownId ? node : engineNode;
      const threshold = viewNode ? STAGE_THRESHOLDS[viewNode.stage] ?? 0 : 0;
      const gauge = viewPartner ? viewPartner.gauge : null;
      const pct = gauge === null || threshold <= 0 ? null : Math.min(100, (gauge / threshold) * 100);
      return {
        ok: true,
        trainerTokens: trainer?.total_tokens ?? 0,
        fedRequests: receipts?.c ?? 0,
        fedTokens: receipts?.t ?? 0,
        fedCost: Number.isFinite(Number(receipts?.s)) ? Number(receipts.s) : 0,
        frozen: control?.frozen === 1,
        pinned: pin?.node_id ?? null,
        pinnedPartnerId: pin?.partner_id ?? null,
        displaying: displayNodeId,
        unlockAll,
        lineage,
        partner: partner
          ? {
              id: partner.partner_id,
              // 面板显示的是「展示中的那只」；它没有存档时 gauge/pct 为 null
              generation: viewPartner ? viewPartner.generation : null,
              node,
              engineNode,
              stageName: STAGE_NAMES[viewNode?.stage] ?? "?",
              displayingOther: Boolean(displayNodeId && engineNode && displayNodeId !== engineNode.id),
              growing: Boolean(viewPartner && viewPartner.partner_id === partner.partner_id),
              gauge,
              threshold,
              pct,
              engineGauge: partner.gauge,
              engineGeneration: partner.generation,
              isTerminal: partner.is_terminal === 1,
              battle: partner.battle_opponent_node_id
                ? {
                    ...nodeInfo(partner.battle_opponent_node_id),
                    attribute: attributeOf(partner.battle_opponent_node_id),
                    attributeLabel: ATTRIBUTE_LABELS[attributeOf(partner.battle_opponent_node_id)] ?? "无属性",
                    // 只读：这场是首次试炼（可能失败）还是连败后的最终试炼（必胜）
                    retry: (() => {
                      try {
                        return (
                          (db
                            .query("SELECT losses FROM magpie_pet_battle_retries WHERE partner_id = ?")
                            .get(partner.partner_id)?.losses ?? 0) >= 1
                        );
                      } catch {
                        return false;
                      }
                    })(),
                  }
                : null,
              ownAttribute: node ? attributeOf(node.id) : null,
              createdAt: partner.created_at,
            }
          : null,
        events: events.map((e) => ({
          kind: e.kind,
          node: nodeInfo(e.current_node_id),
          gauge: e.gauge,
          tokenDelta: e.token_delta,
          createdAt: e.created_at,
        })),
        partners: partners.map((p) => ({
          generation: p.generation,
          node: nodeInfo(p.current_node_id),
          retired: p.retired_at !== null,
          createdAt: p.created_at,
        })),
        thresholds: STAGE_THRESHOLDS,
        fmt: { trainer: fmtTokens(trainer?.total_tokens ?? 0), fed: fmtTokens(receipts?.t ?? 0) },
      };
    } finally {
      db.close();
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

const COMMANDS = new Set(["digital-pet-spawn", "digital-pet-freeze", "digital-pet-unfreeze", "digital-pet-set"]);

// page care whitelist: page command -> care action. petEgg additionally
// carries the current stage so the egg-only rule is enforced server-side.
const CARE_COMMANDS = new Map([
  ["pet-feed-snack", "snack"],
  ["pet-play", "play"],
  ["pet-clean", "clean"],
  ["pet-rest", "rest"],
  ["pet-pet-egg", "petEgg"],
  ["pet-pet", "pet"],
]);
const EXPEDITION_KINDS = new Set(Object.keys(EXPEDITIONS));
const DECORATION_IDS = new Set(Object.keys(DECORATIONS));
const API_TOKEN = randomBytes(32).toString("hex");
const TOKEN_HEADER = "x-magpie-pet-token";

// First-frame preference for the dashboard sprite, from the live care state.
// The page can still switch to any of the other frames shipped in `frames`.
function framePreference(careState) {
  if (!careState) return ["walk_1", "walk_2", "happy"];
  if (careState.energy < 25) return ["sleep_1", "sleep_2", "walk_1", "walk_2"];
  if (careState.satiety < 25) return ["angry", "eat_1", "eat_2", "walk_1", "walk_2"];
  if (careState.hygiene < 25) return ["injured_1", "injured_2", "walk_1", "walk_2"];
  if (careState.mood >= 75) return ["happy", "walk_1", "walk_2"];
  return ["walk_1", "walk_2", "happy"];
}

export function createPetServer({ databasePath, dbPath, adapter: sharedAdapter, port = DEFAULT_PORT, notifyGate, retryMs = 30_000, pollNow } = {}) {
  const adapter = sharedAdapter ?? createPetAdapter({ databasePath, dbPath, notifyGate });
  const dbFile = adapter.databasePath;
  const careStore = createCareStore({ databasePath: dbFile });
  const frames = loadMonsterFrames();

  // upstream snapshot merged with the care layer; never throws past readState
  function readFullState() {
    const state = readState(dbFile);
    const partnerId = state.ok && state.partner ? state.partner.id : null;
    const nowMs = Date.now();
    let care = null;
    let expedition = null;
    let daily = null;
    if (partnerId) {
      const snapshot = careStore.getCareSnapshot(partnerId, nowMs);
      care = snapshot;
      expedition = snapshot.activeExpedition;
      daily = snapshot.daily;
    }
    let collection = null;
    try {
      collection = careStore.getCollection();
    } catch {
      // store already closed; leave collection null
    }
    let frame = null;
    let allFrames = {};
    const sprite = state.ok && state.partner ? state.partner.node?.sprite : null;
    const spriteFrames = sprite ? getSpriteFrames(frames, sprite) : undefined;
    if (spriteFrames) {
      allFrames = spriteFrames;
      const picked = chooseFrame(frames, sprite, framePreference(care?.state));
      if (picked) frame = { ...picked, available: Object.keys(spriteFrames) };
    }
    const unlockedIds = new Set();
    if (state.ok) {
      // 每一代伙伴的当前形态都算背包（蛋也算：你手上确实有这么一颗）
      for (const p of state.partners || []) if (p.node?.id) unlockedIds.add(p.node.id);
      // 只认真正在役的那只（engineNode）；展示覆盖不能把别人算进背包。
      // 蛋也算背包里的一件：不然手上明明有颗蛋，背包里空空如也。
      if (state.partner?.engineNode?.id) {
        unlockedIds.add(state.partner.engineNode.id);
      }
      // 背包 = 当前持有的形态；进化史里的旧形态不占背包（蛋 stage 0 也不算）
    }
    const viewableIds = new Set(unlockedIds);
    if (state.ok) {
      for (const id of state.lineage || []) {
        if (id && (nodeById(id)?.stage ?? 0) > 0) viewableIds.add(id);
      }
    }
    // 同一物种可能被你持有多只（比如两颗蛋）：图鉴按物种合并显示，但要把数量带上
    const ownedCounts = new Map();
    for (const p of state.ok ? state.partners || [] : []) {
      const id = p.node?.id;
      if (id) ownedCounts.set(id, (ownedCounts.get(id) ?? 0) + 1);
    }
    const dex = DIGIMON_DATA.map((d) => ({
      id: d.id,
      nameEn: d.name_en,
      nameJp: d.name_jp,
      stage: d.stage,
      sprite: d.sprite,
      unlocked: state.unlockAll === true || unlockedIds.has(d.id),
      owned: ownedCounts.get(d.id) ?? 0,
      // 曾经持有过：能点开看，但不占背包
      viewable: state.unlockAll === true || viewableIds.has(d.id),
      current: state.ok && state.partner?.node?.id === d.id,
    }));
    // PNG 精灵帧（omnipet CC BY-NC）：有映射的物种给 URL 列表，没有的空着
    // 先按物种名查，再按 "物种名#阶段" 查（同名多阶段只有其中一阶段有图时用）
    let pngFrames = null;
    const node = state.ok ? state.partner?.node : null;
    const nameEn = node?.nameEn ?? null;
    const dir = nameEn ? spriteMap[nameEn] ?? spriteMap[`${nameEn}#${node?.stage}`] : null;
    if (dir) {
      const spriteDir = join(SPRITES_ROOT, dir);
      try {
        const files = readdirSync(spriteDir).filter((f) => /^\d+\.png$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
        if (files.length > 0) {
          pngFrames = files.map((f) => `/sprites/${encodeURIComponent(dir)}/${f}`);
        }
      } catch { /* dir unreadable, stay null */ }
    }
    return { ...state, care, expedition, collection, daily, frame, frames: allFrames, petName: care?.petName ?? null, dex, pngFrames };
  }

  function sendCareResult(res, result, achievements) {
    return send(res, 200, {
      text: result.message ?? "",
      toasts: (achievements ?? result.achievements ?? []).map((id) => ({ title: "成就解锁", message: id })),
      state: readFullState(),
    });
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new Error("body too large");
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  }

  // The magpie page frame is sandboxed with an opaque origin, so Origin: null
  // alone is not proof of anything. Every /api/* route except /api/ping needs
  // the per-process token that only the served HTML gets; Host must be this
  // server's own loopback name, and CORS is never wildcarded.
  function hostAllowed(req) {
    const actual = server.address()?.port;
    if (!actual) return false;
    const host = String(req.headers.host || "").toLowerCase();
    return host === `127.0.0.1:${actual}` || host === `localhost:${actual}`;
  }

  function ownOrigins() {
    const actual = server.address()?.port;
    if (!actual) return new Set();
    return new Set([`http://127.0.0.1:${actual}`, `http://localhost:${actual}`]);
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    return origin === undefined || origin === "null" || ownOrigins().has(origin);
  }

  function tokenOK(req) {
    // 沙盒页（opaque origin）的 fetch 不可靠：自定义 header 触发 CORS
    // preflight，部分 WebView 拒绝放行；所以页面把口令放在 ?token= 查询
    // 参数里，与 header 具有同等效力（同样不缓存、只报本机页）。
    const fromQuery = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("token");
    const got = Buffer.from(String(req.headers[TOKEN_HEADER] || fromQuery || ""));
    const want = Buffer.from(API_TOKEN);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  function corsHeaders(req) {
    const origin = req.headers.origin;
    const allow = origin === "null" ? "null" : origin && ownOrigins().has(origin) ? origin : "null";
    return {
      "access-control-allow-origin": allow,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": `content-type, ${TOKEN_HEADER}`,
      vary: "Origin",
    };
  }

  function send(res, status, body, type = "application/json; charset=utf-8", cors = true) {
    const data = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
    res.writeHead(status, {
      ...(cors ? corsHeaders(res.req) : {}),
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  }

  function sendPreflight(res) {
    res.writeHead(204, {
      ...corsHeaders(res.req),
      "access-control-max-age": "600",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end();
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;
    if (!hostAllowed(req)) return send(res, 403, { error: "只服务本机宠物页" }, undefined, false);
    if (!originAllowed(req)) return send(res, 403, { error: "只服务本机宠物页" });
    if (req.method === "OPTIONS") return sendPreflight(res);
    if (path.startsWith("/api/") && path !== "/api/ping" && !tokenOK(req)) {
      return send(res, 403, { error: "口令不对：请重新打开宠物页", reload: true });
    }
    try {
      if (path === "/api/ping" && req.method === "GET") {
        return send(res, 200, { ok: true });
      }
      if (path === "/api/state" && req.method === "GET") {
        return send(res, 200, readFullState());
      }
      if (path === "/api/command" && req.method === "POST") {
        const body = await readBody(req);
        const name = String(body.name || "");
        const args = body.args === undefined ? undefined : String(body.args).slice(0, 64);

        // --- care layer commands (Task 5); everything validated server-side
        if (
          CARE_COMMANDS.has(name) ||
          name === "pet-expedition-start" ||
          name === "pet-expedition-claim" ||
          name === "pet-decoration-equip" ||
          name === "pet-rename"
        ) {
          const nowMs = Date.now();
          const current = readState(dbFile);
          const partnerId = current.ok && current.partner ? current.partner.id : null;

          if (CARE_COMMANDS.has(name)) {
            if (!partnerId) return send(res, 400, { error: "没有活跃的伙伴可以照顾。", reason: "no-active-partner" });
            const action = CARE_COMMANDS.get(name);
            const context = action === "petEgg" ? { stage: current.partner.engineNode?.stage ?? current.partner.node?.stage } : {};
            const result = careStore.performAction(partnerId, action, nowMs, context);
            if (!result.ok) return send(res, 400, { error: result.message ?? "操作失败。", reason: result.reason });
            return sendCareResult(res, result);
          }

          if (name === "pet-expedition-start") {
            const kind = String(args ?? "");
            if (!EXPEDITION_KINDS.has(kind)) {
              return send(res, 400, { error: `unknown expedition kind: ${kind}`, reason: "unknown-expedition" });
            }
            if (!partnerId) return send(res, 400, { error: "没有活跃的伙伴可以探险。", reason: "no-active-partner" });
            const result = careStore.startExpedition(partnerId, kind, nowMs);
            if (!result.ok) return send(res, 400, { error: `无法开始探险：${result.reason}`, reason: result.reason });
            return send(res, 200, {
              text: `出发去${kind}探险了！`,
              toasts: [],
              state: readFullState(),
            });
          }

          if (name === "pet-expedition-claim") {
            const expeditionId = String(args ?? "");
            if (!expeditionId) {
              return send(res, 400, { error: "claim 需要 expeditionId", reason: "no-expedition" });
            }
            const result = careStore.claimExpedition(expeditionId, nowMs);
            if (!result.ok) return send(res, 400, { error: `无法结算探险：${result.reason}`, reason: result.reason });
            const cappedNote = result.reward.capped
              ? `（今日碎片已达上限，本次实得 ${result.reward.fragments}）`
              : "";
            return sendCareResult(res, { ...result, message: `${result.reward.note}${cappedNote}` });
          }

          if (name === "pet-rename") {
            if (!partnerId) return send(res, 400, { error: "没有活跃的伙伴可以命名。", reason: "no-active-partner" });
            const result = careStore.renamePet(partnerId, args, nowMs);
            if (!result.ok) return send(res, 400, { error: "名字需要 1–20 个字符。", reason: result.reason });
            return send(res, 200, { text: `给它取名为「${result.name}」`, toasts: [], state: readFullState() });
          }

          // pet-decoration-equip
          const decorationId = String(args ?? "");
          if (!DECORATION_IDS.has(decorationId)) {
            return send(res, 400, { error: `unknown decoration: ${decorationId}`, reason: "unknown-decoration" });
          }
          const result = careStore.equipDecoration(decorationId);
          if (!result.ok) return send(res, 400, { error: `无法装备装饰：${result.reason}`, reason: result.reason });
          return send(res, 200, {
            text: `已换上「${decorationId}」主题。`,
            toasts: (result.achievements ?? []).map((id) => ({ title: "成就解锁", message: id })),
            state: readFullState(),
          });
        }

        // --- evolution battle resolution
        // 上游引擎把对决做成 OpenCode TUI 里的小游戏，host 侧没有暴露
        // 结算入口；gauge 到顶后 battle_opponent_node_id 一直挂着，宠物
        // 卡死不能进化。这里在页面上直接迎战（上游的种-specific combat
        // stats 未导出，用中性 50/50），按引擎 commit() 的同款 SQL 落库：
        //   首战胜率 50%，败北不清零——gauge 倒回一半，下一场必胜
        //   （连败计数存在本地表 magpie_pet_battle_retries，胜利即清零）。
        //   胜 → 随机走一条 next_evolutions 分支并清零 gauge。
        if (name === "pet-battle") {
          const outcome = await withWritableDb(dbFile, (rw) => {
          rw.run(
            "CREATE TABLE IF NOT EXISTS magpie_pet_battle_retries (partner_id TEXT PRIMARY KEY, losses INTEGER NOT NULL DEFAULT 0)",
          );
            const partner = rw
              .query(
                `SELECT partner_id, current_node_id, gauge, is_terminal, battle_opponent_node_id
                 FROM partners
                 WHERE partner_id = (SELECT principal_id FROM partner_team WHERE team_id = 1)
                   AND retired_at IS NULL LIMIT 1`,
              )
              .get();
            if (!partner?.battle_opponent_node_id) {
              return { status: 400, payload: { error: "当前没有待战的进化对决。", reason: "no-pending-battle" } };
            }
            const current = nodeById(partner.current_node_id);
            const opponent = nodeById(partner.battle_opponent_node_id);
            if (!current || !opponent) {
              return { status: 400, payload: { error: "对决数据不完整，无法开战。", reason: "battle-data-missing" } };
            }
            const retries = rw
              .query("SELECT losses FROM magpie_pet_battle_retries WHERE partner_id = ?")
              .get(partner.partner_id);
            // 「相克试炼」：对手属性亮出来，玩家在 疫苗 / 数据 / 病毒 里选一个。
            // 克制对手即胜；选错打回 50%，下一场必胜（沿用原连败计数）。
            const pick = String(args ?? "").toLowerCase();
            if (!(pick in ATTRIBUTE_COUNTERS)) {
              return {
                status: 400,
                payload: { error: "相克试炼要选一个属性：vaccine / data / virus", reason: "attribute-required" },
              };
            }
            const opponentAttribute = attributeOf(opponent.id);
            const forced = (retries?.losses ?? 0) >= 1;
            const won = forced || opponentAttribute === null || ATTRIBUTE_COUNTERS[pick] === opponentAttribute;
            const pickLabel = ATTRIBUTE_LABELS[pick] ?? pick;
            const now = new Date().toISOString();
            const label = (n) => n?.name_en ?? "?";

            if (!won) {
              // 败北：对手退去，gauge 倒回一半，记下连败
              const halfGauge = Math.floor(partner.gauge / 2);
              const progress = rw
                .query("SELECT victories FROM partner_combat_progress WHERE partner_id = ? AND node_id = ?")
                .get(partner.partner_id, partner.current_node_id);
              rw.query(
                `UPDATE partners SET gauge = ?, pending_evolution_target_id = NULL,
                 battle_opponent_node_id = NULL WHERE partner_id = ?`,
              ).run(halfGauge, partner.partner_id);
              rw.query(
                `INSERT INTO partner_combat_progress (partner_id, node_id, victories, battle_id)
                 VALUES (?, ?, ?, NULL)
                 ON CONFLICT(partner_id) DO UPDATE SET node_id = excluded.node_id,
                   victories = excluded.victories, battle_id = NULL`,
              ).run(partner.partner_id, partner.current_node_id, progress?.victories ?? 0);
              rw.query(
                "INSERT INTO magpie_pet_battle_retries (partner_id, losses) VALUES (?, 1) ON CONFLICT(partner_id) DO UPDATE SET losses = losses + 1",
              ).run(partner.partner_id);
              rw.query(
                `INSERT INTO partner_events (event_id, partner_id, kind, current_node_id, gauge,
                   is_terminal, token_delta, receipt_key, created_at)
                 VALUES (?, ?, 'usage_applied', ?, ?, ?, NULL, NULL, ?)`,
              ).run(`event-battle-${partner.partner_id}-${now}`, partner.partner_id, partner.current_node_id, halfGauge, partner.is_terminal, now);
              return {
                status: 200,
                payload: {
                  text: `你选了${pickLabel}，没能克制 ${label(opponent)}（${ATTRIBUTE_LABELS[attributeOf(opponent.id)] ?? "无属性"}）：试炼失败，进度倒回一半，下一场必胜。`,
                  toasts: [],
                  state: readFullState(),
                },
              };
            }

            // 胜利：连败清零，随机走一条进化分支
            rw.query(
              "INSERT INTO magpie_pet_battle_retries (partner_id, losses) VALUES (?, 0) ON CONFLICT(partner_id) DO UPDATE SET losses = 0",
            ).run(partner.partner_id);
            let nextNodeId = partner.current_node_id;
            let victories = 0;
            let evolved = false;
            const progress = rw
              .query("SELECT victories FROM partner_combat_progress WHERE partner_id = ? AND node_id = ?")
              .get(partner.partner_id, partner.current_node_id);
            victories = Math.min(1e6, (progress?.victories ?? 0) + 1);
            const targets = current.next_evolutions ?? [];
            if (targets.length > 0) {
              nextNodeId = targets[Math.floor(Math.random() * targets.length)] ?? partner.current_node_id;
              evolved = nextNodeId !== partner.current_node_id;
            }
            if (evolved) victories = 0;
            rw.query(
              `UPDATE partners SET current_node_id = ?, gauge = 0, is_terminal = ?,
               pending_evolution_target_id = NULL, battle_opponent_node_id = NULL
               WHERE partner_id = ?`,
            ).run(nextNodeId, partner.is_terminal, partner.partner_id);
            rw.query(
              `INSERT INTO partner_combat_progress (partner_id, node_id, victories, battle_id)
               VALUES (?, ?, ?, NULL)
               ON CONFLICT(partner_id) DO UPDATE SET node_id = excluded.node_id,
                 victories = excluded.victories, battle_id = NULL`,
            ).run(partner.partner_id, nextNodeId, victories);
            rw.query(
              `INSERT INTO partner_events (event_id, partner_id, kind, current_node_id, gauge,
                 is_terminal, token_delta, receipt_key, created_at)
               VALUES (?, ?, 'usage_applied', ?, ?, ?, NULL, NULL, ?)`,
            ).run(`event-battle-${partner.partner_id}-${now}`, partner.partner_id, nextNodeId, 0, partner.is_terminal, now);
            const text = evolved
              ? `相克成功（${pickLabel}）！${label(current)} 进化成 ${label(nodeById(nextNodeId))}。`
              : `相克成功（${pickLabel}）！击败了 ${label(opponent)}，但 ${label(current)} 暂无可进化路线。`;
            return { status: 200, payload: { text, toasts: [], state: readFullState() } };
          });
          return send(res, outcome.status, outcome.payload);
        }

        // --- dex display switch (pure display, NOT a pin)
        // 图鉴的“显示这只”：只改 magpie_pet_display_state，不碰
        // vpet_control_state.cheat_node_id——钉住（已钉住·不生长）只能从
        // 管理卡的“钉住此 ID”产生。再点一次当前展示的那只 = 切回真实伙伴。
        if (name === "pet-display") {
          const nodeId = String(args ?? "");
          const current = readState(dbFile);
          const owned = new Set((current.partners ?? []).map((p) => p.node?.id));
          if (current.partner?.engineNode?.id) owned.add(current.partner.engineNode.id);
          for (const id of current.lineage ?? []) if (id) owned.add(id);
          if (!nodeById(nodeId)) {
            return send(res, 400, { error: `unknown id: ${nodeId}`, reason: "invalid-args" });
          }
          // 开发者模式（unlock_all）下全图鉴都可展示
          if (!current.unlockAll && !owned.has(nodeId)) {
            return send(res, 400, { error: "这只还没解锁，不能展示。", reason: "not-unlocked" });
          }
          try {
            const engineId = current.partner?.engineNode?.id ?? null;
            const next =
              current.displaying === nodeId || (!current.displaying && engineId === nodeId) ? null : nodeId;
            await withWritableDb(dbFile, (rw) => {
              rw.run(
                "CREATE TABLE IF NOT EXISTS magpie_pet_display_state (control_id INTEGER PRIMARY KEY CHECK (control_id = 1), node_id TEXT)",
              );
              if (next === null) {
                rw.run("DELETE FROM magpie_pet_display_state WHERE control_id = 1");
              } else {
                rw.run(
                  "INSERT INTO magpie_pet_display_state (control_id, node_id) VALUES (1, ?) ON CONFLICT(control_id) DO UPDATE SET node_id = excluded.node_id",
                  next,
                );
              }
            });
            const text =
              next === null
                ? "已切回当前伙伴。"
                : `正在展示 ${nodeById(next)?.name_en ?? next}（只是看看，不钉住、不影响生长）。`;
            return send(res, 200, { text, toasts: [], state: readFullState() });
          } catch (e) {
            return send(res, 400, { error: `无法切换展示：${e?.message ?? e}`, reason: "display-failed" });
          }
        }

        // --- 立即刷新：手动触发一轮用量拉取，不用等定时那轮
        if (name === "pet-poll-now") {
          if (typeof pollNow !== "function") {
            return send(res, 400, { error: "这个进程没有接上 watcher，刷新不了。", reason: "no-watcher" });
          }
          try {
            const fed = await pollNow();
            return send(res, 200, {
              text: fed > 0 ? `刷新完成，喂进 ${fed} 笔新用量。` : "刷新完成，没有新用量。",
              toasts: [],
              state: readFullState(),
            });
          } catch (e) {
            return send(res, 400, { error: `刷新失败：${e?.message ?? e}`, reason: "poll-failed" });
          }
        }

        // --- 出战锁定：钉住 = 选谁吃经验（不是暂停生长）
        // 引擎只喂 partner_team.principal 且 retired_at IS NULL 的那只，所以换个
        // 出战伙伴 = 让目标解除退役、把原来那只标记退役、再改 principal。
        if (name === "pet-pin") {
          const nodeId = String(args ?? "");
          try {
            const result = await withWritableDb(dbFile, (rw) => {
              const target =
                rw
                  .query("SELECT partner_id, current_node_id, retired_at FROM partners WHERE current_node_id = ? ORDER BY (retired_at IS NULL) DESC, generation DESC LIMIT 1")
                  .get(nodeId) ?? null;
              if (!target) return null;
              const now = new Date().toISOString();
              rw.run("UPDATE partners SET retired_at = COALESCE(retired_at, ?) WHERE partner_id <> ?", [now, target.partner_id]);
              rw.run("UPDATE partners SET retired_at = NULL WHERE partner_id = ?", [target.partner_id]);
              rw.run(
                "INSERT INTO partner_team (team_id, principal_id, reserve_id, reserve_paused_at, revision) VALUES (1, ?, NULL, NULL, 1) ON CONFLICT(team_id) DO UPDATE SET principal_id = excluded.principal_id, revision = partner_team.revision + 1",
                [target.partner_id],
              );
              // 引擎的 cheat 位在这里不再表示「钉住」，顺手清掉，免得被当成封盘
              rw.run("UPDATE vpet_control_state SET cheat_node_id = NULL WHERE control_id = 1");
              rw.run(
                "CREATE TABLE IF NOT EXISTS magpie_pet_pin (control_id INTEGER PRIMARY KEY CHECK (control_id = 1), partner_id TEXT NOT NULL, node_id TEXT NOT NULL)",
              );
              rw.run(
                "INSERT INTO magpie_pet_pin (control_id, partner_id, node_id) VALUES (1, ?, ?) ON CONFLICT(control_id) DO UPDATE SET partner_id = excluded.partner_id, node_id = excluded.node_id",
                [target.partner_id, nodeId],
              );
              return { id: target.partner_id, node: nodeId };
            });
            if (!result) {
              return send(res, 400, { error: `${nodeById(nodeId)?.name_en ?? nodeId} 不是你的伙伴，没法设为出战。`, reason: "not-a-partner" });
            }
            return send(res, 200, {
              text: `已设为出战：${nodeById(result.node)?.name_en ?? result.node}。经验从现在起算给它。`,
              toasts: [],
              state: readFullState(),
            });
          } catch (e) {
            return send(res, 400, { error: `无法切换出战：${e?.message ?? e}`, reason: "pin-failed" });
          }
        }
        if (name === "pet-unpin") {
          try {
            const fallback = await withWritableDb(dbFile, (rw) => {
              rw.run(
                "CREATE TABLE IF NOT EXISTS magpie_pet_pin (control_id INTEGER PRIMARY KEY CHECK (control_id = 1), partner_id TEXT NOT NULL, node_id TEXT NOT NULL)",
              );
              rw.run("DELETE FROM magpie_pet_pin WHERE control_id = 1");
              rw.run("UPDATE vpet_control_state SET cheat_node_id = NULL WHERE control_id = 1");
              // 没锁任何一只时默认第一只（generation 最小）出战
              const first = rw.query("SELECT partner_id, current_node_id FROM partners ORDER BY generation ASC LIMIT 1").get() ?? null;
              if (first) {
                const now = new Date().toISOString();
                rw.run("UPDATE partners SET retired_at = COALESCE(retired_at, ?) WHERE partner_id <> ?", [now, first.partner_id]);
                rw.run("UPDATE partners SET retired_at = NULL WHERE partner_id = ?", [first.partner_id]);
                rw.run(
                  "INSERT INTO partner_team (team_id, principal_id, reserve_id, reserve_paused_at, revision) VALUES (1, ?, NULL, NULL, 1) ON CONFLICT(team_id) DO UPDATE SET principal_id = excluded.principal_id, revision = partner_team.revision + 1",
                  [first.partner_id],
                );
              }
              // 展示覆盖也一并清掉：取消锁定就是回到真实伙伴，不留残影
              rw.run(
                "CREATE TABLE IF NOT EXISTS magpie_pet_display_state (control_id INTEGER PRIMARY KEY CHECK (control_id = 1), node_id TEXT)",
              );
              rw.run("DELETE FROM magpie_pet_display_state WHERE control_id = 1");
              return first;
            });
            const name = fallback ? nodeById(fallback.current_node_id)?.name_en ?? fallback.current_node_id : null;
            return send(res, 200, {
              text: name ? `已取消出战锁定，回到默认出战：${name}。` : "已取消出战锁定。",
              toasts: [],
              state: readFullState(),
            });
          } catch (e) {
            return send(res, 400, { error: `无法取消出战锁定：${e?.message ?? e}`, reason: "unpin-failed" });
          }
        }
        if (name === "digital-pet-spawn") {
          const current = readState(dbFile);
          const stage = current.ok && current.partner
            ? current.partner.engineNode?.stage ?? current.partner.node?.stage ?? 0
            : null;
          if (stage !== null && stage < MIN_HATCH_STAGE) {
            return send(res, 400, {
              error: "当前伙伴达到 baby II（含以上阶段）后才能获取新的蛋。",
              reason: "stage-required",
            });
          }
          const createdAt = current.ok && current.partner ? Date.parse(current.partner.createdAt) : NaN;
          if (Number.isFinite(createdAt) && Date.now() - createdAt < 60_000) {
            const waitSec = Math.ceil((60_000 - (Date.now() - createdAt)) / 1000);
            return send(res, 400, { error: `刚获取过新的蛋，${waitSec} 秒后才能再获取。`, reason: "spawn-cooldown" });
          }
          // 引擎拿 event-retired-<generation> 当主键。伙伴被「设为出战」复活过之后，
          // 再孵蛋就会撞上历史那条退役记录 → UNIQUE constraint failed。
          // 孵之前把撞车的老行改成带时间戳的唯一 id：历史留在册上，新行也能写。
          try {
            await withWritableDb(dbFile, (rw) => {
              const active = rw
                .query(
                  `SELECT generation FROM partners
                   WHERE partner_id = (SELECT principal_id FROM partner_team WHERE team_id = 1)
                     AND retired_at IS NULL LIMIT 1`,
                )
                .get();
              if (!active) return;
              const id = `event-retired-${active.generation}`;
              const clash = rw.query("SELECT created_at FROM partner_events WHERE event_id = ?").get(id);
              if (!clash) return;
              const suffix = String(clash.created_at ?? Date.now()).replace(/[^0-9A-Za-z]/g, "");
              rw.run("UPDATE partner_events SET event_id = ? WHERE event_id = ?", [`${id}@${suffix}`, id]);
            });
          } catch {
            // 修不了就让引擎自己报错，别把孵化整个挡死
          }
        }

        // --- original engine commands, unchanged
        if (!COMMANDS.has(name)) return send(res, 400, { error: `unknown command: ${name}`, reason: "unknown-command" });
        if (name === "digital-pet-set" && !/^[0-9]-[0-9]{1,3}$/.test(String(args ?? ""))) {
          return send(res, 400, { error: "set 需要一个 Digimon ID，例如 4-001", reason: "invalid-args" });
        }
        const result = await adapter.runCommand(name, args);
        return send(res, 200, {
          text: result.text,
          toasts: result.toasts.map((t) => ({ title: t?.title, message: t?.message })),
          state: readFullState(),
        });
      }

      // PNG sprite frames: /sprites/<dir>/<frame>.png served from SPRITES_ROOT
      if (path.startsWith("/sprites/")) {
        const spriteRel = decodeURIComponent(path.slice(9));
        const file = resolve(SPRITES_ROOT, spriteRel);
        const inside = relative(SPRITES_ROOT, file);
        if (inside.startsWith("..") || isAbsolute(inside)) {
          return send(res, 403, { error: "forbidden" });
        }
        const data = await readFile(file).catch(() => null);
        if (!data) return send(res, 404, "not found", "text/plain; charset=utf-8");
        return send(res, 200, data, "image/png");
      }

      // static: the dashboard itself (page/app.html and friends). Resolve the
      // decoded URL against UI_ROOT and only serve files strictly inside it.
      let rel;
      try {
        rel = decodeURIComponent(path).replace(/^\/+/, "");
      } catch {
        return send(res, 400, { error: "bad path", reason: "bad-path" });
      }
      const file = resolve(UI_ROOT, rel === "" ? "app.html" : rel);
      const insideRoot = relative(UI_ROOT, file);
      if (insideRoot.startsWith("..") || isAbsolute(insideRoot)) {
        return send(res, 403, { error: "forbidden" });
      }
      let data = await readFile(file).catch(() => null);
      if (!data) return send(res, 404, "not found", "text/plain; charset=utf-8");
      if (file.endsWith("app.html")) {
        const html = data.toString("utf8");
        const tokenScript = `<script>window.PET_TOKEN=${JSON.stringify(API_TOKEN)};</script>`;
        // 用文件 mtime 当版本号：改完前端刷新即生效，不会被旧缓存坑
        const assetStamp = (() => {
          try {
            return String(Math.floor(statSync(join(UI_ROOT, "app.js")).mtimeMs));
          } catch {
            return API_TOKEN.slice(0, 8);
          }
        })();
        const stamped = html
          .replace('href="app.css"', `href="app.css?v=${assetStamp}"`)
          .replace('src="app.js"', `src="app.js?v=${assetStamp}"`);
        data = Buffer.from(stamped.replace("</head>", `${tokenScript}</head>`), "utf8");
      }
      return send(res, 200, data, MIME[extname(file).toLowerCase()] || "application/octet-stream");
    } catch (e) {
      return send(res, 500, { error: String(e?.message ?? e) });
    }
  });

  // track live sockets so close() can drop keep-alive connections instead of
  // waiting for the client to let go
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const bind = (p) =>
    new Promise((resolve, reject) => {
      const onErr = (err) => {
        server.removeListener("listening", onOk);
        reject(err);
      };
      const onOk = () => {
        server.removeListener("error", onErr);
        resolve();
      };
      server.once("error", onErr);
      server.once("listening", onOk);
      server.listen(p, "127.0.0.1");
    });

  let retryTimer = null;
  let serving = false;
  let boundPort = port;

  async function tryBindOnce() {
    try {
      await bind(port);
      boundPort = server.address()?.port ?? port;
      serving = true;
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      console.log(`[magpie-digital-pet] sidebar page at http://127.0.0.1:${boundPort}/ · db ${dbFile}`);
      return true;
    } catch (e) {
      if (e?.code !== "EADDRINUSE") {
        console.log("[magpie-digital-pet] server bind failed:", e?.message ?? e);
        if (retryTimer) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
        return false;
      }
      // another host process holds the port right now. Hosts come and go
      // (a CLI `plugin add` host lives seconds); keep retrying quietly and
      // take the port over when it frees up.
      return false;
    }
  }

  async function start() {
    const bound = await tryBindOnce();
    if (bound) return true;
    if (!retryTimer) {
      console.log(`[magpie-digital-pet] port ${port} busy; will retry until it frees`);
      retryTimer = setInterval(
        () => {
          if (serving) return;
          tryBindOnce().catch(() => {});
        },
        Math.max(200, retryMs),
      );
      if (typeof retryTimer?.unref === "function") retryTimer.unref();
    }
    return false;
  }

  let closed = false;

  return {
    get port() {
      return boundPort;
    },
    databasePath: dbFile,
    adapter,
    apiToken: API_TOKEN,
    start,
    close: async () => {
      if (closed) return;
      closed = true;
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      careStore.close();
    },
  };
}

export const PET_PAGE_PORT = DEFAULT_PORT;
