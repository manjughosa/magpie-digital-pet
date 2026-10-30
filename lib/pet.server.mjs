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

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { createPetAdapter, nodeById } from "./pet.adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../lib
const UI_ROOT = join(dirname(HERE), "page");

const DEFAULT_PORT = 3571;

// engine stage thresholds, mirrored for display only (upstream defaults)
const STAGE_THRESHOLDS = [5e6, 1e7, 2e7, 4e7, 75e6, 125e6, 2e8, 3e8];
const STAGE_NAMES = ["egg", "baby I", "baby II", "child", "adult", "perfect", "ultimate", "super ultimate"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
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

      const node = partner ? nodeInfo(partner.current_node_id) : null;
      const threshold = node ? STAGE_THRESHOLDS[node.stage] ?? 0 : 0;
      return {
        ok: true,
        trainerTokens: trainer?.total_tokens ?? 0,
        fedRequests: receipts?.c ?? 0,
        fedTokens: receipts?.t ?? 0,
        fedCost: Number.isFinite(Number(receipts?.s)) ? Number(receipts.s) : 0,
        frozen: control?.frozen === 1,
        pinned: control?.cheat_node_id ?? null,
        partner: partner
          ? {
              generation: partner.generation,
              node,
              stageName: STAGE_NAMES[node?.stage] ?? "?",
              gauge: partner.gauge,
              threshold,
              pct: threshold > 0 ? Math.min(100, (partner.gauge / threshold) * 100) : 0,
              isTerminal: partner.is_terminal === 1,
              battle: partner.battle_opponent_node_id
                ? nodeInfo(partner.battle_opponent_node_id)
                : null,
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

export function createPetServer({ databasePath, dbPath, port = DEFAULT_PORT, notifyGate, retryMs = 30_000 } = {}) {
  const adapter = createPetAdapter({ databasePath, dbPath, notifyGate });
  const dbFile = adapter.databasePath;

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

  function send(res, status, body, type = "application/json; charset=utf-8") {
    const data = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;
    try {
      if (path === "/api/ping" && req.method === "GET") {
        return send(res, 200, { ok: true, db: dbFile });
      }
      if (path === "/api/state" && req.method === "GET") {
        return send(res, 200, readState(dbFile));
      }
      if (path === "/api/command" && req.method === "POST") {
        const body = await readBody(req);
        const name = String(body.name || "");
        if (!COMMANDS.has(name)) return send(res, 400, { error: `unknown command: ${name}` });
        const args = body.args === undefined ? undefined : String(body.args).slice(0, 64);
        if (name === "digital-pet-set" && !/^[0-9]-[0-9]{1,3}$/.test(String(args ?? ""))) {
          return send(res, 400, { error: "set 需要一个 Digimon ID，例如 4-001" });
        }
        const result = await adapter.runCommand(name, args);
        return send(res, 200, {
          text: result.text,
          toasts: result.toasts.map((t) => ({ title: t?.title, message: t?.message })),
          state: readState(dbFile),
        });
      }

      // static: the dashboard itself (page/app.html and friends)
      const rel = path.replace(/^\/+/, "");
      const file = join(UI_ROOT, rel === "" ? "app.html" : rel);
      if (!file.startsWith(UI_ROOT)) return send(res, 403, { error: "forbidden" });
      const data = await readFile(file).catch(() => null);
      if (!data) return send(res, 404, "not found", "text/plain; charset=utf-8");
      return send(res, 200, data, MIME[extname(file).toLowerCase()] || "application/octet-stream");
    } catch (e) {
      return send(res, 500, { error: String(e?.message ?? e) });
    }
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

  async function tryBindOnce() {
    try {
      await bind(port);
      serving = true;
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      console.log(`[magpie-digital-pet] sidebar page at http://127.0.0.1:${port}/ · db ${dbFile}`);
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

  return {
    port,
    databasePath: dbFile,
    adapter,
    start,
    close: async () => {
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export const PET_PAGE_PORT = DEFAULT_PORT;
