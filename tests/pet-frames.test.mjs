// tests/pet-frames.test.mjs
// Contract for the restored pixel frame catalog: lib/monster-frames.json is
// extracted from the Apache-2.0 upstream TUI bundle by tools/extract-frames.mjs
// and ships hundreds of per-species frame sets. Unknown sprites still fall
// back to undefined so the page can use its procedural renderer.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chooseFrame,
  getSpriteFrames,
  loadMonsterFrames,
} from "../lib/pet.frames.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

assert.equal(existsSync(join(repoRoot, "lib", "monster-frames.json")), true);
assert.equal(existsSync(join(repoRoot, "tools", "extract-frames.mjs")), true);

const frames = loadMonsterFrames();
assert.equal(frames instanceof Map, true);
assert.ok(frames.size > 600, `expected the full catalog, got ${frames.size} sprites`);

const known = getSpriteFrames(frames, "egg");
assert.ok(known && typeof known === "object", "egg sprite frames missing");
const picked = chooseFrame(frames, "egg", ["walk_1", "walk_2", "happy"]);
assert.ok(picked && typeof picked.content === "string" && picked.content.length > 0);
assert.ok(picked.content.split("\n").length > 4, "frame content must be multi-row pixel art");

// unknown sprites keep the procedural-fallback contract
assert.equal(getSpriteFrames(frames, "no-such-sprite"), undefined);
assert.equal(chooseFrame(frames, "no-such-sprite", ["walk_1"]), undefined);

console.log("all pet-frames tests passed");
