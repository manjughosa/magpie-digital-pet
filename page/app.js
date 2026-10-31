// app.js — 宠物主页行为：轮询 /api/state、Canvas 像素渲染、命令接线。
// 安全约束：动态文本一律 textContent / DOM API，绝不把接口字段拼进 HTML。
"use strict";

const $ = (id) => document.getElementById(id);
// 页面跑在 magpie 的 sandbox="allow-scripts" 沙盒里：opaque origin 下
// window.location 读不到东西（query 由 boot.js 透传时会带口令），而
// 自定义 header 会触发 CORS preflight，在部分 WebView 沙盒里不放行。
// 所以 API 口令统一走 ?token= 查询参数；读不到 query 时退回页面注入的
// window.PET_TOKEN（正常同源打开时也有效）。
const apiToken = () => {
  try {
    const q = new URLSearchParams(location.search).get("token");
    if (q) return q;
  } catch {}
  return window.PET_TOKEN || "";
};

const fmt = (n) => {
  n = Number(n) || 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(n);
};

const timeOf = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
};

const fmtDuration = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
};

// ---------- theme ----------

const prefersDark = matchMedia("(prefers-color-scheme: dark)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function applyTheme() {
  const root = document.documentElement.classList;
  root.remove("theme-dark", "theme-light");
  let t = null;
  try {
    t = new URLSearchParams(location.search).get("theme");
  } catch {}
  if (t === "dark" || t === "light") root.add(`theme-${t}`);
  else root.add(prefersDark.matches ? "theme-dark" : "theme-light");
}
applyTheme();
prefersDark.addEventListener?.("change", applyTheme);
reducedMotion.addEventListener?.("change", () => {
  restartAnimation();
  renderScene();
});

const motionOK = () => !reducedMotion.matches;
const isDark = () => document.documentElement.classList.contains("theme-dark");

// ---------- deterministic hashing ----------

function hashString(s) {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- canvas scene ----------

const canvas = $("pet-canvas");
const ctx = canvas.getContext("2d");
const CW = canvas.width;
const CH = canvas.height;
const GROUND_Y = CH - 22;
const SPRITE_COLS = 16;
const SPRITE_ROWS = 8;
const PX = Math.floor(Math.min((CW - 48) / SPRITE_COLS, (GROUND_Y - 16) / SPRITE_ROWS));

let tick = 0;
let lastState = null;
let particlesCache = { key: null, list: [] };
let override = null; // { names: string[], until: number }

const EXPEDITION_LABELS = { patrol: "短巡逻", field: "数据原野", night: "深夜远征" };
const DECORATION_PRICES = {
  meadow: 10,
  night: 25,
  terminal: 40,
  ocean: 60,
  sunset: 80,
  snow: 120,
  sakura: 160,
  void: 200,
};
const GOAL_LABELS = {
  care: "照顾宠物 2 次",
  expedition: "完成 1 次探险",
  feed: "自动进食 10 个请求",
};
const ACTION_FRAMES = {
  "pet-feed-snack": ["eat_1", "eat_2"],
  "pet-play": ["happy", "walk_1"],
  "pet-clean": ["happy", "walk_2"],
  "pet-rest": ["sleep_1", "sleep_2"],
  "pet-pet-egg": ["walk_2", "walk_1"],
  "pet-battle": ["happy", "walk_1", "walk_2"],
  "pet-pet": ["happy", "walk_1"],
};
const ACTION_EFFECTS = {
  "pet-feed-snack": { color: "#f59e0b", shape: "crumb" },
  "pet-play": { color: "#facc15", shape: "star" },
  "pet-clean": { color: "#38bdf8", shape: "drop" },
  "pet-rest": { color: "#a78bfa", shape: "sleep" },
  "pet-pet-egg": { color: "#fb7185", shape: "heart" },
  "pet-battle": { color: "#f87171", shape: "star" },
  "pet-pet": { color: "#fb7185", shape: "heart" },
};
let actionEffect = null;

function habitatVariant() {
  const theme = lastState?.collection?.equippedTheme;
  return Object.hasOwn(DECORATION_PRICES, theme) ? theme : "";
}

function spriteHue(sprite) {
  if (habitatVariant() === "terminal") return 135; // 终端荧光绿
  return hashString(sprite || "egg") % 360;
}

function particlesFor(key) {
  if (particlesCache.key === key) return particlesCache.list;
  const rnd = mulberry32(hashString(`particles:${key}`));
  const list = [];
  for (let i = 0; i < 14; i += 1) {
    list.push({
      x: 12 + rnd() * (CW - 24),
      y: 8 + rnd() * (GROUND_Y - 30),
      r: 1 + rnd() * 1.8,
      phase: rnd() * Math.PI * 2,
    });
  }
  particlesCache = { key, list };
  return list;
}

function charShade(ch, hue) {
  const dark = isDark();
  if (ch === "█") return `hsl(${hue} ${dark ? 55 : 60}% ${dark ? 62 : 45}%)`;
  if (ch === "▀") return `hsl(${hue} ${dark ? 45 : 50}% ${dark ? 76 : 62}%)`;
  if (ch === "▄") return `hsl(${hue} ${dark ? 60 : 55}% ${dark ? 46 : 33}%)`;
  return null;
}

function drawParticles(key) {
  const variant = habitatVariant();
  const dark = isDark();
  for (const p of particlesFor(key)) {
    const twinkle = motionOK() ? 0.35 + 0.3 * Math.sin(tick * 0.7 + p.phase) : 0.5;
    let color;
    if (variant === "terminal") color = `hsla(135 80% 60% / ${twinkle})`;
    else if (variant === "night" || dark) color = `hsla(45 90% 80% / ${twinkle})`;
    else color = `hsla(35 70% 55% / ${twinkle * 0.8})`;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGround() {
  const variant = habitatVariant();
  const dark = isDark();
  let strip;
  let shadow;
  if (variant === "terminal") {
    strip = "hsla(135 70% 40% / 0.5)";
    shadow = "hsla(135 80% 50% / 0.25)";
  } else if (variant === "night" || dark) {
    strip = "rgba(0, 0, 0, 0.35)";
    shadow = "rgba(0, 0, 0, 0.45)";
  } else {
    strip = "rgba(90, 70, 35, 0.18)";
    shadow = "rgba(90, 70, 35, 0.22)";
  }
  ctx.fillStyle = strip;
  ctx.fillRect(0, GROUND_Y, CW, CH - GROUND_Y);
  // 宠物脚下的柔和阴影
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(CW / 2, GROUND_Y + 2, (SPRITE_COLS * PX) / 2.6, 5, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawGlow(hue) {
  // 蛋的呼吸光晕：跟着 tick 轻轻起伏
  const alpha = motionOK() ? 0.14 + 0.09 * Math.sin(tick * 0.9) : 0.18;
  const cx = CW / 2;
  const cy = GROUND_Y - (SPRITE_ROWS * PX) / 2;
  const r = (SPRITE_COLS * PX) / 1.7;
  const grad = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
  grad.addColorStop(0, `hsla(${hue} 80% 65% / ${alpha})`);
  grad.addColorStop(1, `hsla(${hue} 80% 65% / 0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawContent(content, hue, bob) {
  const lines = content.split("\n");
  const rows = lines.length;
  const cols = Math.max(...lines.map((l) => [...l].length));
  const ox = Math.round((CW - cols * PX) / 2);
  const oy = GROUND_Y - rows * PX + bob;
  lines.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      const color = charShade(ch, hue);
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(ox + col * PX, oy + row * PX, PX, PX);
    });
  });
}

function drawActionEffect() {
  if (!actionEffect) return;
  const now = Date.now();
  const elapsed = now - actionEffect.startedAt;
  const total = 1400;
  if (elapsed >= total) {
    actionEffect = null;
    return;
  }
  const progress = elapsed / total;
  const style = actionEffect.style;
  const rnd = mulberry32(hashString(`${actionEffect.kind}:${actionEffect.startedAt}`));
  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - progress * 0.85);
  ctx.fillStyle = style.color;
  ctx.strokeStyle = style.color;
  ctx.lineWidth = 2;
  for (let i = 0; i < 12; i += 1) {
    const angle = rnd() * Math.PI * 2;
    const radius = 28 + rnd() * 52 + progress * 28;
    const x = CW / 2 + Math.cos(angle) * radius;
    const y = GROUND_Y - 38 - Math.sin(angle) * radius * 0.42 - progress * 34;
    const size = 3 + rnd() * 3;
    if (style.shape === "star") {
      ctx.beginPath();
      for (let p = 0; p < 8; p += 1) {
        const a = (Math.PI / 4) * p;
        const r = p % 2 === 0 ? size * 1.7 : size * 0.65;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r;
        if (p === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    } else if (style.shape === "drop") {
      ctx.beginPath();
      ctx.ellipse(x, y, size * 0.7, size * 1.3, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (style.shape === "sleep") {
      ctx.font = `700 ${Math.round(size * 5)}px system-ui`;
      ctx.fillText("Z", x, y);
    } else if (style.shape === "heart") {
      ctx.beginPath();
      ctx.arc(x - size * 0.45, y, size * 0.55, 0, Math.PI * 2);
      ctx.arc(x + size * 0.45, y, size * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - size, y + size * 0.25);
      ctx.lineTo(x + size, y + size * 0.25);
      ctx.lineTo(x, y + size * 1.35);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// 缺帧兜底：按 node.id + stage 生成稳定的对称像素团，绝不空白。
function drawFallback(key, hue, bob) {
  const rnd = mulberry32(hashString(`fallback:${key}`));
  const rows = SPRITE_ROWS;
  const half = 6;
  const grid = [];
  for (let r = 0; r < rows; r += 1) {
    const rowArr = [];
    for (let c = 0; c < half; c += 1) {
      const dx = (c - (half - 0.5)) / half;
      const dy = (r - (rows - 1) / 2) / (rows / 2);
      const inside = dx * dx + dy * dy < 1;
      rowArr.push(inside && rnd() < 0.82 ? (rnd() < 0.6 ? "█" : rnd() < 0.5 ? "▀" : "▄") : " ");
    }
    grid.push(rowArr.join("") + [...rowArr].reverse().join(""));
  }
  drawContent(grid.join("\n"), hue, bob);
}

function pickFrameNames(state, frames) {
  const ok = (n) => typeof frames?.[n] === "string" && frames[n].length > 0;
  const regular = () => {
    const care = state?.care?.state;
    if (!care) return ["walk_1", "walk_2"];
    if (care.energy < 25) return ["sleep_1", "sleep_2", "walk_1", "walk_2"];
    if (care.hygiene < 25) return ["injured_1", "injured_2", "walk_1", "walk_2"];
    if (care.satiety < 25) return ["angry", "refuse", "walk_1", "walk_2"];
    if (care.mood >= 75) return ["happy", "walk_1", "walk_2"];
    return ["walk_1", "walk_2"];
  };
  if (override && Date.now() < override.until) {
    // 缺失姿态时回退到行走/待机常规帧，而不是直接走像素兜底
    const names = override.names.filter(ok);
    return names.length > 0 ? names : regular().filter(ok);
  }
  return regular().filter(ok);
}

function renderScene() {
  const s = lastState;
  ctx.clearRect(0, 0, CW, CH);
  const sprite = s?.partner?.node?.sprite || "egg";
  const stage = s?.partner?.node?.stage ?? 0;
  const hue = spriteHue(sprite);
  drawParticles(sprite);
  drawGround();
  const isEgg = stage === 0 || sprite === "egg";
  if (isEgg) drawGlow(hue);
  // 任何阶段都给一点呼吸式上下浮动；原来只在蛋期 bob，进化后看起来
  // 就像整张图卡死了。幅度 2px，跟蛋的浮动同量级。
  const bob = motionOK() ? Math.round(Math.sin(tick * 0.9) * 2) : 0;
  // 指针交互的位移/旋转/形变，叠加在呼吸浮动之上
  const nowMs = Date.now();
  let dx = 0;
  let dy = 0;
  let rot = 0;
  if (inter.dragging) dx = inter.dragX;
  else if (Math.abs(inter.dragX) > 0.5) {
    inter.dragX *= 0.82; // 松手后弹簧回位
    dx = inter.dragX;
  } else inter.dragX = 0;
  if (nowMs < inter.hopUntil) {
    const k = 1 - (inter.hopUntil - nowMs) / 450;
    dy = -Math.round(Math.sin(k * Math.PI) * 14);
  }
  if (nowMs < inter.spinUntil) {
    rot = (1 - (inter.spinUntil - nowMs) / 650) * Math.PI * 2;
  }
  const squash = inter.squish;
  inter.squish *= 0.8;
  // 悬停注视：宠物身上一层跟随呼吸的微光
  if (inter.hover && s?.partner && motionOK()) {
    ctx.save();
    ctx.globalAlpha = 0.1 + 0.05 * Math.sin(tick * 0.9);
    ctx.fillStyle = `hsl(${hue} 85% 70%)`;
    ctx.beginPath();
    ctx.ellipse(CW / 2, GROUND_Y - (SPRITE_ROWS * PX) / 2, (SPRITE_COLS * PX) / 1.9, (SPRITE_ROWS * PX) / 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  const frameSet = s?.frames || {};
  const available = pickFrameNames(s, frameSet);
  ctx.save();
  if (dx || dy || rot || squash > 0.05) {
    const cx = CW / 2;
    const cy = GROUND_Y - (SPRITE_ROWS * PX) / 2;
    ctx.translate(cx + dx, cy + dy);
    if (rot) ctx.rotate(rot);
    if (squash > 0.05) ctx.scale(1 + squash * 0.12, 1 - squash * 0.18);
    ctx.translate(-cx, -cy);
  }
  if (available.length > 0) {
    drawContent(frameSet[available[tick % available.length]], hue, bob);
  } else if (s?.partner) {
    drawFallback(`${s.partner.node.id}:${stage}`, hue, bob);
  }
  ctx.restore();
  // 快速划过的眩晕：绕头顶转圈的星星
  if (nowMs < inter.dizzyUntil && motionOK()) {
    for (let i = 0; i < 3; i += 1) {
      const a = tick * 0.8 + (i * Math.PI * 2) / 3;
      drawFxShape("star", CW / 2 + Math.cos(a) * 26, GROUND_Y - SPRITE_ROWS * PX - 6 + Math.sin(a) * 6, 3, "#f59e0b");
    }
  }
  renderFx();
  drawActionEffect();
}

// 低帧率循环：2.5fps 足够像素动画；减少动态偏好时完全停止循环。
let animTimer = null;
function restartAnimation() {
  if (animTimer) {
    clearInterval(animTimer);
    animTimer = null;
  }
  if (motionOK()) {
    animTimer = setInterval(() => {
      tick += 1;
      renderScene();
    }, 400);
  }
}
restartAnimation();

// ---------- canvas pointer interactions ----------
// 六种画布交互：抚摸（按住来回划）、点击（跳一下）、悬停（注视微光）、
// 拖拽（拎起来晃，松手弹回）、双击（转一圈）、快速划过（眩晕星星）。
// 全部先给视觉反馈；抚摸节流后调用 pet-pet 命令涨亲密。
const inter = {
  hover: false,
  dragging: false,
  downAt: 0,
  downX: 0,
  dragX: 0,
  hopUntil: 0,
  spinUntil: 0,
  dizzyUntil: 0,
  squish: 0,
  lastStrokeAt: 0,
  lastPetCmdAt: 0,
};
const fxParticles = []; // {x0,y0,vx,vy,born,life,color,shape}
let strokePrev = null;
let lastMove = null;

function petHitBox() {
  const half = (SPRITE_COLS * PX) / 2;
  return { x0: CW / 2 - half, x1: CW / 2 + half, y0: GROUND_Y - SPRITE_ROWS * PX, y1: GROUND_Y };
}
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * CW, y: ((e.clientY - r.top) / r.height) * CH };
}
function inPet(p) {
  const b = petHitBox();
  return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
}
function spawnFx(x, y, color, shape, n = 3) {
  for (let i = 0; i < n; i += 1) {
    fxParticles.push({
      x0: x + (Math.random() - 0.5) * 24,
      y0: y + (Math.random() - 0.5) * 10,
      vx: (Math.random() - 0.5) * 0.05,
      vy: -(0.06 + Math.random() * 0.08),
      born: Date.now(),
      life: 900 + Math.random() * 500,
      color,
      shape,
    });
  }
}
function drawFxShape(shape, x, y, size, color) {
  ctx.fillStyle = color;
  if (shape === "heart") {
    ctx.beginPath();
    ctx.arc(x - size * 0.45, y, size * 0.55, 0, Math.PI * 2);
    ctx.arc(x + size * 0.45, y, size * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - size, y + size * 0.25);
    ctx.lineTo(x + size, y + size * 0.25);
    ctx.lineTo(x, y + size * 1.35);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (shape === "star") {
    ctx.beginPath();
    for (let p = 0; p < 8; p += 1) {
      const a = (Math.PI / 4) * p;
      const r = p % 2 === 0 ? size * 1.7 : size * 0.65;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (p === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fill();
}
function renderFx() {
  const now = Date.now();
  for (let i = fxParticles.length - 1; i >= 0; i -= 1) {
    const f = fxParticles[i];
    const age = now - f.born;
    if (age > f.life) {
      fxParticles.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - age / f.life);
    drawFxShape(f.shape, f.x0 + f.vx * age, f.y0 + f.vy * age, 3.5, f.color);
    ctx.restore();
  }
}

canvas.addEventListener("pointerdown", (e) => {
  const p = canvasPoint(e);
  if (!inPet(p)) return;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  inter.downAt = Date.now();
  inter.downX = p.x;
  inter.dragging = false;
  strokePrev = p;
});
canvas.addEventListener("pointermove", (e) => {
  const p = canvasPoint(e);
  const over = inPet(p);
  inter.hover = over;
  canvas.style.cursor = inter.dragging ? "grabbing" : over ? "pointer" : "";
  const now = Date.now();
  if (inter.downAt) {
    // 拖拽：水平位移超过阈值才算拎起来，避免误触点击
    const dx = p.x - inter.downX;
    if (Math.abs(dx) > 12) {
      inter.dragging = true;
      inter.dragX = Math.max(-70, Math.min(70, dx));
    }
    // 抚摸：按住并在宠物身上来回划，间隔出爱心，节流后真正计数
    if (strokePrev) {
      const moved = Math.hypot(p.x - strokePrev.x, p.y - strokePrev.y);
      if (over && moved > 8 && now - inter.lastStrokeAt > 180) {
        inter.lastStrokeAt = now;
        spawnFx(p.x, p.y - 12, "#fb7185", "heart", 2);
        if (now - inter.lastPetCmdAt > 30_000) {
          inter.lastPetCmdAt = now;
          command("pet-pet");
        }
      }
      strokePrev = p;
    }
  } else if (motionOK()) {
    // 快速划过：不按键，指针高速掠过宠物 → 眩晕星星
    if (lastMove && over) {
      const v = Math.abs(p.x - lastMove.x) / Math.max(1, now - lastMove.t);
      if (v > 1.1 && now > inter.dizzyUntil - 400) {
        inter.dizzyUntil = now + 1200;
      }
    }
  }
  lastMove = { x: p.x, t: now };
});
function endPointer(e) {
  const p = e ? canvasPoint(e) : null;
  const held = Date.now() - (inter.downAt || 0);
  if (inter.downAt && !inter.dragging && p && inPet(p) && held < 400) {
    // 点击：跳一下 + 落地压扁回弹
    inter.hopUntil = Date.now() + 450;
    inter.squish = 1;
    spawnFx(p.x, p.y - 24, "#facc15", "star", 3);
  }
  inter.downAt = 0;
  inter.dragging = false;
  strokePrev = null;
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", () => {
  inter.hover = false;
  canvas.style.cursor = "";
  endPointer(null);
});
canvas.addEventListener("dblclick", (e) => {
  if (!inPet(canvasPoint(e))) return;
  inter.spinUntil = Date.now() + 650;
  spawnFx(CW / 2, GROUND_Y - SPRITE_ROWS * PX - 8, "#a78bfa", "star", 4);
});

// ---------- status & DOM painting ----------

function say(msg, ok) {
  const el = $("say");
  el.textContent = msg || "";
  el.className = ok ? "ok" : "";
}

function statusText(s) {
  if (!s.ok) return `读不到数据库：${s.error || "?"}`;
  if (!s.partner) return "还没有搭档 —— 到「管理」里孵一颗新蛋吧。";
  const exp = s.expedition;
  if (exp && exp.status === "running") {
    const left = exp.endsAt - Date.now();
    if (left > 0) return `它正在「${EXPEDITION_LABELS[exp.kind] || exp.kind}」探险，还要 ${fmtDuration(left)}。`;
    return "探险结束了，它带着收获回来了！";
  }
  const care = s.care?.state;
  if (!care) return "";
  const label = s.care.summary?.moodLabel || "";
  const hints = [];
  if (care.satiety < 25) hints.push("肚子有点饿");
  if (care.mood < 25) hints.push("想找人玩");
  if (care.energy < 25) hints.push("困得睁不开眼");
  if (care.hygiene < 25) hints.push("该洗个澡了");
  const tail = hints.length ? `——${hints.join("，")}。` : "。";
  return `它现在${label}${tail}`;
}

function paintHero(s) {
  const p = s.ok ? s.partner : null;
  if (!p) {
    $("pet-name").textContent = s.ok ? "还没有搭档" : "离线";
    $("pet-jp").textContent = "";
    $("pet-stage-badge").textContent = "";
    $("pet-pin-badge").hidden = true;
    $("pet-frozen-badge").hidden = true;
    $("evo-fill").style.width = "0%";
    $("evo-text").textContent = "";
    $("evo-pct").textContent = "";
    $("battle").hidden = true;
    return;
  }
  $("pet-name").textContent = s.petName || p.node.nameEn;
  // 中日名重复时只显示一次，不变成 "DemiVeemon · DemiVeemon" 这种假双名。
  const jp = p.node.nameJp;
  $("pet-jp").textContent = s.petName
    ? (jp && jp !== p.node.nameEn ? `${p.node.nameEn} · ${jp}` : p.node.nameEn)
    : jp;
  const renameInput = $("pet-rename-input");
  if (renameInput && document.activeElement !== renameInput) renameInput.value = s.petName || "";
  $("pet-stage-badge").textContent = `gen ${p.generation} · ${p.stageName}`;
  $("pet-pin-badge").hidden = !s.pinned;
  $("pet-frozen-badge").hidden = !s.frozen;
  $("evo-fill").style.width = `${Math.max(1.5, p.pct).toFixed(1)}%`;
  $("evo-text").textContent = `本阶段 ${fmt(p.gauge)} / ${fmt(p.threshold)} tokens`;
  $("evo-pct").textContent = `${p.pct.toFixed(2)}%`;
  $("battle").hidden = !p.battle;
  if (p.battle) $("battle-foe").textContent = p.battle.nameEn;
}

function paintCareBars(s) {
  const care = s.ok ? s.care?.state : null;
  document.querySelectorAll("#care-bars .care-row").forEach((row) => {
    const stat = row.dataset.stat;
    const value = care ? care[stat] : null;
    const fill = row.querySelector(".bar-fill");
    const val = row.querySelector(".care-val");
    if (value == null || !Number.isFinite(value)) {
      fill.style.width = "0%";
      val.textContent = "–";
      row.classList.remove("low");
      return;
    }
    fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    val.textContent = String(Math.round(value));
    row.classList.toggle("low", stat !== "bond" && value < 25);
  });
}

function paintDaily(s) {
  const ul = $("daily-list");
  ul.replaceChildren();
  const goals = s.ok ? s.daily?.goals : null;
  if (!goals || !goals.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "还没有搭档，暂无每日目标。";
    ul.append(li);
    return;
  }
  for (const goal of goals) {
    const li = document.createElement("li");
    if (goal.done) li.classList.add("done");
    const name = document.createElement("span");
    name.className = "goal-name";
    name.textContent = GOAL_LABELS[goal.id] || goal.id;
    const progress = document.createElement("span");
    progress.className = "goal-progress";
    progress.textContent = goal.done ? `${goal.target}/${goal.target} · 已完成` : `${goal.progress}/${goal.target}`;
    li.append(name, progress);
    ul.append(li);
  }
}

function paintCollection(s) {
  const c = s.ok ? s.collection : null;
  $("fragments").textContent = String(c?.fragments ?? 0);
  const total = 6;
  const got = c?.achievements?.length ?? 0;
  $("achievements").textContent = `成就 ${got}/${total}`;
  const equipped = c?.equippedTheme || "";
  const unlocked = new Set(c?.unlocked || []);
  document.querySelectorAll('[data-command="pet-decoration-equip"]').forEach((btn) => {
    const id = btn.dataset.args;
    const price = DECORATION_PRICES[id] ?? 0;
    btn.classList.toggle("equipped", equipped === id);
    if (equipped === id) btn.textContent = `${btn.dataset.label || ""} · 已装备`;
    else if (unlocked.has(id)) btn.textContent = `${btn.dataset.label || ""} · 点击装备`;
    else btn.textContent = `${btn.dataset.label || ""} · ${price} 碎片`;
  });
}

let dexPaintKey = "";
function paintDex(s) {
  const grid = $("dex-grid");
  if (!grid) return;
  const query = ($("dex-search")?.value || "").trim().toLowerCase();
  const filter = $("dex-filter")?.value || "unlocked";
  const items = (s.ok && Array.isArray(s.dex) ? s.dex : []).filter((item) => {
    if (filter === "unlocked" && !item.unlocked) return false;
    if (filter === "locked" && item.unlocked) return false;
    if (!query) return true;
    return [item.id, item.nameEn, item.nameJp].some((v) => String(v || "").toLowerCase().includes(query));
  });
  const key = JSON.stringify([query, filter, items.map((i) => [i.id, i.unlocked, i.current])]);
  if (key === dexPaintKey) return;
  dexPaintKey = key;
  grid.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "没有匹配的图鉴。";
    grid.append(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement("div");
    card.className = `dex-card${item.unlocked ? "" : " locked"}${item.current ? " current" : ""}`;
    const title = document.createElement("b");
    title.textContent = item.nameEn;
    const jp = document.createElement("span");
    jp.className = "muted small";
    jp.textContent = `${item.nameJp} · ${item.id} · stage ${item.stage}`;
    const status = document.createElement("span");
    status.className = "dex-status";
    if (!item.unlocked) {
      status.textContent = "未解锁";
      card.append(title, jp, status);
      grid.append(card);
      continue;
    }
    status.textContent = item.current ? "当前宠物" : "已解锁";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.command = "digital-pet-set";
    btn.dataset.args = item.id;
    // 这不是“换成这只宠物”，而是把一只退役形态钉住展示：真实伙伴被遮住
    // 且暂停生长。文案必须把这个语义写出来，否则用户会以为在换宠。
    btn.textContent = item.current ? "正在钉住展示" : "钉住展示这只";
    btn.title = "钉住后页面展示这只（真实伙伴被遮住并暂停生长），在「管理 → 取消钉住」里恢复。";
    btn.disabled = item.current;
    btn.addEventListener("click", () => command("digital-pet-set", item.id));
    card.append(title, jp, status, btn);
    grid.append(card);
  }
}

function paintExpedition(s) {
  const el = $("expedition-status");
  const exp = s.ok ? s.expedition : null;
  if (!exp) {
    el.textContent = "还没有进行中的探险。派它出去巡逻能带回数据碎片。";
    return;
  }
  const left = exp.endsAt - Date.now();
  if (left > 0) {
    el.textContent = `「${EXPEDITION_LABELS[exp.kind] || exp.kind}」进行中，剩余 ${fmtDuration(left)}。`;
  } else {
    el.textContent = `「${EXPEDITION_LABELS[exp.kind] || exp.kind}」已完成，快领取奖励！`;
  }
}

function paintLists(s) {
  const ev = $("events");
  ev.replaceChildren();
  if (!s.ok || !s.events || !s.events.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = s.ok ? "还没有记录。" : "读不到数据库。";
    ev.append(li);
  } else {
    for (const e of s.events) {
      const li = document.createElement("li");
      li.className = "ev";
      const time = document.createElement("time");
      time.textContent = timeOf(e.createdAt);
      const what = document.createElement("span");
      what.className = "what";
      what.textContent =
        e.kind === "spawned" ? `孵出 ${e.node.nameEn}` :
        e.kind === "usage_applied" ? `${e.node.nameEn} 进食` :
        e.kind;
      const tok = document.createElement("span");
      tok.className = "tok";
      tok.textContent = e.tokenDelta != null ? `+${fmt(e.tokenDelta)}` : "";
      li.append(time, what, tok);
      ev.append(li);
    }
  }
  const gens = $("gens");
  gens.replaceChildren();
  if (!s.ok || !s.partners || !s.partners.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "还没有搭档。";
    gens.append(li);
  } else {
    for (const g of s.partners.slice().reverse()) {
      const li = document.createElement("li");
      li.className = "gen";
      const gen = document.createElement("span");
      gen.className = "g";
      gen.textContent = `gen ${g.generation}`;
      const name = document.createElement("span");
      name.textContent = `${g.node.nameEn}${g.retired ? "" : " · 现役"}`;
      const when = document.createElement("span");
      when.className = "r";
      when.textContent = timeOf(g.createdAt);
      li.append(gen, name, when);
      gens.append(li);
    }
  }
}

function paint(s) {
  lastState = s;
  if (s.ok) {
    $("sub").textContent =
      `累计已喂 ${s.fedRequests} 个请求 · ${fmt(s.fedTokens)} tokens` +
      (s.fedCost > 0 ? ` · $${s.fedCost.toFixed(2)}` : "");
  }
  const habitat = $("habitat");
  habitat.classList.remove(...Object.keys(DECORATION_PRICES).map((id) => `habitat--${id}`));
  const variant = habitatVariant();
  if (variant) habitat.classList.add(`habitat--${variant}`);
  $("status-line").textContent = statusText(s);
  paintHero(s);
  paintCareBars(s);
  paintDaily(s);
  paintCollection(s);
  paintDex(s);
  paintExpedition(s);
  paintLists(s);
  updateButtons();
  renderScene();
}

// ---------- buttons: cooldown / availability ----------

const careButtons = () => [...document.querySelectorAll("#actions [data-command]")];
const expeditionStartButtons = () => [...document.querySelectorAll('[data-command="pet-expedition-start"]')];

function updateButtons() {
  const s = lastState;
  const now = Date.now();
  const partner = s?.ok ? s.partner : null;
  const care = s?.ok ? s.care?.state : null;
  const exp = s?.ok ? s.expedition : null;
  const expRunning = !!(exp && exp.status === "running");
  const expFinished = expRunning && exp.endsAt <= now;

  const hint = $("actions-hint");
  for (const btn of careButtons()) {
    const base = btn.dataset.label;
    const key = btn.dataset.cooldown;
    if (btn.id === "btn-pet-egg") {
      const isEgg = (partner?.node?.stage ?? -1) === 0;
      btn.hidden = !!partner && !isEgg;
    }
    if (!s || !s.ok) {
      btn.disabled = true;
      btn.textContent = base;
      continue;
    }
    if (!partner) {
      btn.disabled = true;
      btn.textContent = base;
      btn.title = "先孵一颗蛋";
      continue;
    }
    if (expRunning) {
      btn.disabled = true;
      btn.textContent = base;
      btn.title = "探险中，等它回来吧";
      continue;
    }
    const until = care?.cooldowns?.[key] ?? 0;
    if (until > now) {
      btn.disabled = true;
      btn.textContent = `${base} · ${fmtDuration(until - now)}`;
      btn.title = "冷却中";
      continue;
    }
    if (key === "play" && care && care.energy < 20) {
      btn.disabled = true;
      btn.textContent = base;
      btn.title = "它现在太困了，先休息一下";
      continue;
    }
    btn.disabled = false;
    btn.textContent = base;
    btn.title = "";
  }
  if (!s || !s.ok) hint.textContent = "";
  else if (!partner) hint.textContent = "先孵一颗蛋，再来照顾它。";
  else if (expRunning) hint.textContent = "它出门探险了，回来再照顾吧。";
  else hint.textContent = "";

  for (const btn of expeditionStartButtons()) {
    const base = btn.dataset.label;
    if (!s || !s.ok || !partner) {
      btn.disabled = true;
      btn.textContent = base;
    } else if (expRunning) {
      btn.disabled = true;
      btn.textContent = base;
      btn.title = "同一时刻只能有一场探险";
    } else if (care && care.energy < 15) {
      btn.disabled = true;
      btn.textContent = base;
      btn.title = "它现在太困了，先休息一下";
    } else {
      btn.disabled = false;
      btn.textContent = base;
      btn.title = "";
    }
  }

  const claim = $("btn-claim");
  claim.hidden = !expRunning;
  if (expRunning) {
    claim.disabled = !expFinished;
    claim.textContent = expFinished ? "领取探险奖励" : `探险中 · ${fmtDuration(exp.endsAt - now)}`;
  }

  const fragments = s?.ok ? s.collection?.fragments ?? 0 : 0;
  const unlocked = new Set(s?.ok ? s.collection?.unlocked || [] : []);
  document.querySelectorAll('[data-command="pet-decoration-equip"]').forEach((btn) => {
    const id = btn.dataset.args;
    const owned = unlocked.has(id);
    btn.disabled = !s?.ok || (!owned && fragments < (DECORATION_PRICES[id] ?? Infinity));
    btn.title = btn.disabled && s?.ok ? "碎片不够，去探险赚一点吧" : "";
  });

  const spawnBtn = document.querySelector('[data-command="digital-pet-spawn"]');
  if (spawnBtn) {
    if (!s || !s.ok) {
      spawnBtn.disabled = true;
      spawnBtn.title = "";
    } else if (!partner) {
      spawnBtn.disabled = false;
      spawnBtn.title = "孵出第一颗蛋";
    } else {
      const stage = partner.engineNode?.stage ?? partner.node?.stage ?? 0;
      spawnBtn.disabled = stage < 2;
      spawnBtn.title = stage < 2
        ? "当前伙伴达到 baby II 后才能孵下一颗蛋"
        : "当前伙伴会退役，需要二次确认";
    }
  }

  // 状态文案里的探险倒计时也随秒针刷新
  if (s?.ok) $("status-line").textContent = statusText(s);
  if (s?.ok) paintExpedition(s);
}

// ---------- commands ----------

let busy = false;
let spawnConfirmUntil = 0;

const commandButtons = () => document.querySelectorAll("[data-command]");

async function command(name, args) {
  if (busy) return;
  busy = true;
  commandButtons().forEach((b) => (b.disabled = true));
  // 服务端写库被锁时会整进程卡住；fetch 必须有时限，否则按钮永远
  // 停在禁用态，整个页面表现为“点一下全卡死”。
  const ctrl = new AbortController();
  const watchdog = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(`/api/command?token=${encodeURIComponent(apiToken())}`, {
      method: "POST",
      // text/plain 让请求保持 CORS simple request 语义（opaque origin
      // 下 application/json 会触发 preflight，部分 WebView 不放行）；
      // server 端按 body 内容解析，与 content-type 无关。
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name, args }),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      say(j?.error || `操作失败（HTTP ${r.status}）`);
      return;
    }
    const toast = (j?.toasts || [])
      .map((t) => [t.title, t.message].filter(Boolean).join(" — "))
      .filter(Boolean)
      .join("；");
    say(toast || j?.text || "完成", true);
    if (ACTION_FRAMES[name]) {
      override = { names: ACTION_FRAMES[name], until: Date.now() + 2400 };
    }
    if (ACTION_EFFECTS[name]) {
      actionEffect = { kind: name, style: ACTION_EFFECTS[name], startedAt: Date.now() };
    }
    if (j?.state) paint(j.state);
  } catch (e) {
    say(e?.name === "AbortError" ? "命令超时：宠物服务没响应，请稍后再试。" : `命令失败：${e?.message ?? e}`);
  } finally {
    clearTimeout(watchdog);
    busy = false;
    // 只恢复命令按钮，档案 tab 不参与命令禁用状态
    commandButtons().forEach((b) => (b.disabled = false));
    updateButtons();
  }
}

document.querySelectorAll("[data-command]").forEach((btn) => {
  // 记录静态基础文案，倒计时/装备状态刷新时还原；
  // 装饰按钮的初始文案带价格后缀，只保留名称部分
  btn.dataset.label =
    btn.dataset.command === "pet-decoration-equip"
      ? btn.textContent.split(" · ")[0]
      : btn.textContent;
  btn.addEventListener("click", () => {
    const name = btn.dataset.command;
    if (name === "digital-pet-spawn") {
      if (Date.now() > spawnConfirmUntil) {
        spawnConfirmUntil = Date.now() + 4000;
        btn.textContent = "再点一次确认孵新蛋";
        say("当前宠物会退役，4 秒内再次点击确认孵新蛋。");
        setTimeout(() => {
          if (Date.now() > spawnConfirmUntil) {
            btn.textContent = btn.dataset.label;
            spawnConfirmUntil = 0;
          }
        }, 4100);
        return;
      }
      spawnConfirmUntil = 0;
      btn.textContent = btn.dataset.label;
      command(name, btn.dataset.args);
      return;
    }
    if (name === "pet-rename") {
      const value = $("pet-rename-input").value.trim().replace(/\s+/g, " ");
      if (value.length < 1 || value.length > 20) {
        say("名字需要 1–20 个字符。");
        return;
      }
      command(name, value);
      return;
    }
    if (name === "digital-pet-set") {
      const id = $("set-id").value.trim();
      if (!/^[0-9]-[0-9]{1,3}$/.test(id)) {
        say("ID 形如 4-001");
        return;
      }
      command(name, id);
      return;
    }
    if (name === "pet-expedition-claim") {
      const expId = lastState?.expedition?.expeditionId;
      if (!expId) {
        say("现在没有可结算的探险。");
        return;
      }
      command(name, expId);
      return;
    }
    command(name, btn.dataset.args);
  });
});

$("dex-search")?.addEventListener("input", () => {
  dexPaintKey = "";
  if (lastState) paintDex(lastState);
});
$("dex-filter")?.addEventListener("change", () => {
  dexPaintKey = "";
  if (lastState) paintDex(lastState);
});

// ---------- archive tabs ----------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.hidden = panel.id !== `panel-${tab}`;
    });
  });
});

// ---------- polling ----------

// opaque origin（magpie 沙盒 iframe）下 sessionStorage 访问抛 SecurityError，
// 防护成纯内存标记即可；token 过期时无条件刷新一次，最坏是循环由
// server 换 token + 页面带新 token 打开后自然终止。
let tokenReloaded = false;

async function load() {
  const ctrl = new AbortController();
  const watchdog = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const r = await fetch(`/api/state?token=${encodeURIComponent(apiToken())}`, { cache: "no-store", signal: ctrl.signal });
    if (r.status === 403) {
      say("页面口令过期，正在刷新…");
      if (!tokenReloaded) {
        tokenReloaded = true;
        setTimeout(() => location.reload(), 300);
      }
      return;
    }
    tokenReloaded = false;
    paint(await r.json());
  } catch (e) {
    say(e?.name === "AbortError" ? "刷新超时：宠物服务没响应，下一轮再试。" : `刷新失败：${e?.message ?? e}`);
  } finally {
    clearTimeout(watchdog);
  }
}

load();
setInterval(load, 5000);
// 秒针：只刷新冷却/探险倒计时文案与禁用状态，不触碰布局
setInterval(updateButtons, 1000);
