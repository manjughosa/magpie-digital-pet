// tests/page-contract.test.mjs
// Static contract for the pet dashboard page (Task 6): app.html keeps only
// structure and static templates, app.js renders dynamic text via DOM APIs
// (never interpolating API fields into innerHTML), app.css ships both light
// and dark themes, and every command button is wired through data-command.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const html = readFileSync(join(ROOT, "page", "app.html"), "utf8");
const css = readFileSync(join(ROOT, "page", "app.css"), "utf8");
const js = readFileSync(join(ROOT, "page", "app.js"), "utf8");

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error.message);
  }
}

test("app.html contains no inline script logic", () => {
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim())
    .filter((body) => body.length > 0);
  assert.deepEqual(inline, [], "inline <script> bodies must be empty");
  assert.match(html, /<script[^>]*src=["']app\.js["'][^>]*>/, "app.js must be loaded externally");
  assert.match(html, /<link[^>]*href=["']app\.css["']/, "app.css must be linked");
});

test("app.html exposes the required DOM regions", () => {
  for (const id of ["habitat", "pet-canvas", "care-bars", "actions", "daily-goals", "panel-collection", "events", "gens"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /<canvas[^>]*id="pet-canvas"/, "#pet-canvas must be a <canvas>");
});

test("dynamic text is rendered via DOM APIs, never innerHTML interpolation", () => {
  assert.ok(js.includes("textContent"), "app.js should set dynamic text via textContent");
  const assignments = [...js.matchAll(/innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  const bad = assignments.filter((value) => value !== '""' && value !== "''");
  assert.deepEqual(bad, [], `innerHTML may only clear nodes, got: ${bad.join(", ")}`);
  // belt and braces: no tagged/untagged template HTML builders fed to the DOM
  assert.ok(!/insertAdjacentHTML/.test(js), "insertAdjacentHTML is not allowed");
});

test("app.css provides both light and dark themes", () => {
  assert.match(css, /\.theme-light\b/);
  assert.match(css, /\.theme-dark\b/);
});

test("every gameplay button is a data-command button; archive tabs are separate", () => {
  const buttons = [...html.matchAll(/<button\b[^>]*>/gi)].map((m) => m[0]);
  assert.ok(buttons.length >= 10, "expected a full set of buttons");
  for (const btn of buttons) {
    if (/\bclass="[^"]*tab-btn/.test(btn)) continue;
    // 右上角养成难度齿轮：只是开菜单，本身不发命令（选项按钮由 app.js 生成）
    if (/\bid="difficulty-gear"/.test(btn)) continue;
    // 三级菜单那个「更多…」：也只开合子菜单，不发命令
    if (/\bid="cheat-more"/.test(btn)) continue;
    // 不可逆确认框的「取消」：只关框（真正执行的是带 data-command 的那个确认键）
    if (/\bid="gate-cancel"/.test(btn)) continue;
    assert.ok(/\bdata-command="[^"]+"/.test(btn), `button missing data-command: ${btn}`);
  }
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["dex", "events", "gens", "collection", "actions"]);
});

test("all pet-* and digital-pet-* commands have buttons", () => {
  const commands = new Set(
    [...html.matchAll(/data-command="([^"]+)"/g)].map((m) => m[1]),
  );
  for (const name of [
    "pet-feed-snack",
    "pet-play",
    "pet-clean",
    "pet-rest",
    "pet-pet-egg",
    "pet-reset-care-uses",
    "pet-expedition-start",
    "pet-expedition-claim",
    "pet-decoration-equip",
    "digital-pet-spawn",
    "digital-pet-freeze",
    "digital-pet-unfreeze",
    "digital-pet-set",
    "pet-unpin",
    "pet-battle",
  ]) {
    assert.ok(commands.has(name), `missing button for ${name}`);
  }
});

test("care reset sits in the daily-care header and requires a second click", () => {
  const section = html.match(/<section id="actions"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(section, /class="section-head"[\s\S]*?<h2>日常照顾<\/h2>[\s\S]*?id="btn-reset-care-uses"/);
  const button = section.match(/<button[^>]*id="btn-reset-care-uses"[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.match(button, /data-command="pet-reset-care-uses"/);
  assert.match(button, /data-confirm="1"/);
  assert.match(button, /data-confirm-label="再点一次确认"/);
  assert.match(button, /data-confirm-message="[^"]*消耗 2 个数据碎片/);
  assert.match(js, /btn\.dataset\.confirmLabel/);
  assert.match(js, /btn\.dataset\.armed = "1"/);
  assert.match(css, /\.section-head\s*\{/);
});

test("expedition and decoration buttons carry static data-args", () => {
  const expeditionStarts = [...html.matchAll(/<button\b[^>]*data-command="pet-expedition-start"[^>]*>/g)];
  assert.ok(expeditionStarts.length >= 3, "expected 3 expedition tiers");
  for (const [btn] of expeditionStarts) {
    assert.ok(/\bdata-args="(patrol|field|night)"/.test(btn), `expedition button needs data-args: ${btn}`);
  }
  const decorations = [...html.matchAll(/<button\b[^>]*data-command="pet-decoration-equip"[^>]*>/g)];
  assert.ok(decorations.length >= 15, "expected 15 decorations");
  for (const [btn] of decorations) {
    assert.ok(
      /\bdata-args="(village|meadow|night|gear|terminal|ocean|coast|sunset|snow|forest|tunnel|sakura|factory|void|castle)"/.test(btn),
      `decoration button needs data-args: ${btn}`,
    );
  }
});

test("command() finally re-enables command buttons before updateButtons()", () => {
  const start = js.indexOf("async function command(");
  assert.ok(start !== -1, "command() must exist");
  const finallyIdx = js.indexOf("finally", start);
  assert.ok(finallyIdx !== -1, "command() must have a finally block");
  const body = js.slice(finallyIdx, finallyIdx + 400);
  const enableIdx = body.search(/commandButtons\(\)[\s\S]{0,100}?disabled\s*=\s*false/);
  const updateIdx = body.indexOf("updateButtons()");
  assert.ok(/busy\s*=\s*false/.test(body), "finally must keep clearing the busy re-entry guard");
  assert.ok(enableIdx !== -1, "finally must first re-enable command buttons before state-based disabling");
  assert.ok(updateIdx !== -1, "finally must call updateButtons()");
  assert.ok(enableIdx < updateIdx, "re-enable must run before updateButtons() so it can re-disable per state");
});

test("override action frames fall back to regular state frames when unavailable", () => {
  const start = js.indexOf("function pickFrameNames");
  const end = js.indexOf("function restartAnimation");
  assert.ok(start !== -1 && end > start, "expected pickFrameNames/renderScene region");
  const scene = js.slice(start, end);
  assert.ok(!/return override\.names\s*;/.test(scene),
    "override names must be filtered against available frames, not returned raw");
  assert.ok(/override[\s\S]{0,160}?\.filter\(/.test(scene),
    "override names must be filtered by frame availability");
  assert.ok(/\.length\s*>\s*0\s*\?/.test(scene) || /\.length\s*===?\s*0/.test(scene),
    "empty filtered override must fall back to walk/care frames before drawFallback");
});

test("dex selection, rename controls and action effects are wired", () => {
  for (const id of ["dex", "dex-search", "dex-filter", "dex-grid", "pet-rename-input"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes('data-command="pet-rename"'), "rename button missing");
  assert.ok(js.includes("apiToken()"), "api requests must carry the local page token");
  assert.ok(js.includes("/api/state?token=") && js.includes("/api/command?token="),
    "api requests must send the token as a query parameter (opaque-origin sandbox blocks header preflights)");
  assert.ok(js.includes("ACTION_EFFECTS"), "per-action canvas effects missing");
  assert.ok(js.includes("paintDex"), "dex painter missing");
  assert.ok(js.includes("pet-rename"), "rename command wiring missing");
  // 「查看已解锁」= 所有能看的；只留"曾持有"那半，全宠物获取之后这一栏就空了
  assert.ok(js.includes('filter === "visited" && !item.viewable'), "查看已解锁 = 背包里的 + 曾持有的");
  assert.ok(js.includes("图鉴里的每一只都已经在你背包里了。"), "只看未拥有为空时要说明原因");
});

test("destructive spawn requires a second click and dex switch warns about pinning", () => {
  assert.ok(js.includes("spawnArmed"), "spawn double-confirm state missing");
  assert.ok(js.includes("再点一次确认获取新的蛋"), "spawn confirmation copy missing");
  assert.ok(!js.includes("4 秒内"), "spawn confirm must not use a timeout anymore");
  assert.ok(js.includes("当前伙伴达到 baby II（含以上阶段）后才能获取新的蛋"), "spawn gate copy");
  assert.ok(js.includes("spawnBtn.disabled = !ready"), "spawn gate must be the egg counter only");
  assert.ok(html.includes('data-preview="1"'), "actions tab must be a local preview");
  assert.ok(js.includes('btn.dataset.preview === "1"'), "preview buttons must not send commands");
  assert.ok(html.includes('id="battle-me"'), "battle bar must name the pet that is about to evolve");
  assert.ok(js.includes('$("battle-me").textContent'), "battle bar must fill that name from state");
  for (const tone of ["vaccine", "data", "virus"]) {
    assert.ok(html.includes(`trial-card--${tone}`), `trial must offer the ${tone} card`);
  }
  assert.ok(html.includes('id="battle-stage"'), "trial card needs a first/final stage badge");
  assert.ok(js.includes('classList.toggle("is-final"'), "stage badge must switch to the final state");
  assert.ok(html.includes('id="battle-me-sprite"') && html.includes('id="battle-foe-sprite"'), "trial must show both pixel partners");
  assert.ok(js.includes("state.spriteDirs?.[node.id]"), "sprites must use the server's species-to-directory mapping");
  assert.ok(js.includes('command("pet-display", item.id)'), "dex switch must run in one click");
  assert.ok(html.includes('id="display-note"'), "page must mark the species that is only being displayed");
  for (const label of ["只看背包", "查看已解锁", "全部图鉴", "只看未拥有"]) {
    assert.ok(html.includes(label), `dex filter must offer ${label}`);
  }
  assert.ok(js.includes('" visited"'), "history-only forms must get their own card style");
  assert.ok(html.includes('id="dex-count"'), "dex needs the visible counter");
  assert.ok(js.includes('renameInput.disabled = !canRename'), "rename field must be cleared/disabled when viewing another pet");
  assert.ok(html.includes('id="hero-pin"'), "name row needs the quick 出战 button");
  assert.ok(html.includes('id="hero-poll"'), "name row needs the instant-refresh button");
  assert.ok(js.includes('classList.add("spinning")'), "refresh button must show it is polling");
  assert.ok(js.includes('$("hero-pin").hidden'), "quick 出战 button must only show for a displayed, non-growing pet");
  assert.ok(js.includes("不改出战伙伴"), "dex display-only warning missing");
  assert.ok(js.includes('"pet-display"'), "dex buttons must use pet-display, never the pin command");
  assert.ok(html.includes('data-command="pet-unpin"'), "unpin button missing");
});

test("canvas pointer interactions are wired: petting, click, hover, drag, dblclick and fast swipe", () => {
  for (const event of ["pointerdown", "pointermove", "pointerup", "pointerleave", "dblclick"]) {
    assert.ok(js.includes(`addEventListener("${event}"`), `canvas ${event} handler missing`);
  }
  assert.ok(js.includes('command("pet-pet")'), "petting must fire the pet-pet care command");
  assert.ok(js.includes("hopUntil"), "click hop missing");
  assert.ok(js.includes("spinUntil"), "double-click spin missing");
  assert.ok(js.includes("dizzyUntil"), "fast-swipe dizzy missing");
  assert.ok(js.includes("inter.dragX"), "drag offset missing");
  assert.ok(js.includes("inter.hover"), "hover highlight missing");
});

test("renderScene draws from a local frame set, never bare window.frames", () => {
  const start = js.indexOf("function renderScene");
  const end = js.indexOf("function restartAnimation");
  assert.ok(start !== -1 && end > start, "expected renderScene");
  const scene = js.slice(start, end);
  assert.ok(!/(?<![.\w])frames\[/.test(scene),
    "renderScene must not index bare `frames` (resolves to window.frames in browsers)");
  const local = scene.match(/const\s+(\w+)\s*=\s*s\?\.frames\s*\|\|\s*\{\}/);
  assert.ok(local, "renderScene must define a local frame set from s?.frames");
  assert.ok(scene.includes(`pickFrameNames(s, ${local[1]})`),
    "pickFrameNames must receive the local frame set");
  assert.ok(scene.includes(`drawContent(${local[1]}[`),
    "drawContent must draw from the same local frame set");
});

test("全宠物获取需要三下确认：问一句 → 不可逆确认框 → 5 秒倒计时后才能按", () => {
  for (const id of [
    "cheat-more",
    "cheat-panel",
    "cheat-difficulty",
    "cheat-grant-all",
    "confirm-gate",
    "gate-cancel",
    "gate-ok",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  // 作弊挂在难度命令上，两下；全宠物获取三下
  assert.ok(
    html.includes('data-command="pet-set-difficulty" data-args="0.01" data-confirm="1"'),
    "作弊档要走上难度命令并带二次确认",
  );
  assert.ok(html.includes('data-command="pet-grant-all" data-confirm="2"'), "全宠物获取要带三级确认");
  assert.ok(
    html.includes('id="gate-ok" data-command="pet-grant-all"'),
    "确认框里的确认键才是真正发命令的那个",
  );
  assert.ok(html.includes("此举动不可逆"), "确认框要写清不可逆");
  assert.ok(html.includes("5 秒后可确认"), "确认键要先等 5 秒倒计时");
  assert.ok(js.includes("是否选择获取全部宠物"), "第一下只问一句，不动库");
  assert.ok(js.includes("gateSync"), "倒计时与令牌都到位才解锁确认键");
  assert.ok(js.includes("j?.confirm?.token"), "确认键用的是后台发的一次性票");
  assert.ok(/gateTimer = null;\s*gateSync\(\);/.test(js), "倒计时走完只解锁按键，绝不自动执行");
  assert.ok(
    /const j = await command\("pet-grant-all"\)[\s\S]{0,300}gateSync\(\)/.test(js),
    "command() 的 finally 会把按钮恢复可点，拿票回来必须再按住确认键",
  );
  assert.ok(js.includes("if (armedConfirm) disarmConfirm();"), "点了别的按钮，待确认作废");
  assert.match(js, /if \(!pop\.hidden\) \{\s*closeGear\(\)/, "关菜单要作废待确认");
});

test("养成难度的标签认作弊档，不会兜底成「普通」", () => {
  // 顶栏/常驻提示原来只用二级菜单那六档解析，选了作弊档就写成「养成难度 普通 ×0.01」
  assert.ok(js.includes("String(value) === cheatValue ? cheat : null"), "档位名要认得三级菜单的作弊档");
  assert.ok(js.includes("levelOf(current)?.label"), "顶栏与提示用的是解析后的档位名");
  assert.ok(html.includes("养成难度选择"), "齿轮标题还在");
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
