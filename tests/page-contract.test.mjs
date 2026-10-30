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
  for (const id of ["habitat", "pet-canvas", "care-bars", "actions", "daily-goals", "collection", "events", "gens"]) {
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

test("every button in app.html is a data-command button", () => {
  const buttons = [...html.matchAll(/<button\b[^>]*>/gi)].map((m) => m[0]);
  assert.ok(buttons.length >= 10, "expected a full set of command buttons");
  for (const btn of buttons) {
    assert.ok(/\bdata-command="[^"]+"/.test(btn), `button missing data-command: ${btn}`);
  }
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
    "pet-expedition-start",
    "pet-expedition-claim",
    "pet-decoration-equip",
    "digital-pet-spawn",
    "digital-pet-freeze",
    "digital-pet-unfreeze",
    "digital-pet-set",
  ]) {
    assert.ok(commands.has(name), `missing button for ${name}`);
  }
});

test("expedition and decoration buttons carry static data-args", () => {
  const expeditionStarts = [...html.matchAll(/<button\b[^>]*data-command="pet-expedition-start"[^>]*>/g)];
  assert.ok(expeditionStarts.length >= 3, "expected 3 expedition tiers");
  for (const [btn] of expeditionStarts) {
    assert.ok(/\bdata-args="(patrol|field|night)"/.test(btn), `expedition button needs data-args: ${btn}`);
  }
  const decorations = [...html.matchAll(/<button\b[^>]*data-command="pet-decoration-equip"[^>]*>/g)];
  assert.ok(decorations.length >= 3, "expected 3 decorations");
  for (const [btn] of decorations) {
    assert.ok(/\bdata-args="(meadow|night|terminal)"/.test(btn), `decoration button needs data-args: ${btn}`);
  }
});

test("command() finally re-enables every button before updateButtons()", () => {
  const start = js.indexOf("async function command(");
  assert.ok(start !== -1, "command() must exist");
  const finallyIdx = js.indexOf("finally", start);
  assert.ok(finallyIdx !== -1, "command() must have a finally block");
  const body = js.slice(finallyIdx, finallyIdx + 400);
  const enableIdx = body.search(/querySelectorAll\("button"\)[\s\S]{0,100}?disabled\s*=\s*false/);
  const updateIdx = body.indexOf("updateButtons()");
  assert.ok(/busy\s*=\s*false/.test(body), "finally must keep clearing the busy re-entry guard");
  assert.ok(enableIdx !== -1, "finally must first re-enable all buttons (incl. #manage) before state-based disabling");
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

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
