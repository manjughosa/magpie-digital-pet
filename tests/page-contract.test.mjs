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

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nall tests passed");
