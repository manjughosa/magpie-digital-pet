// lib/pet.care-rules.mjs
// Pure care rules for the Magpie digital pet: decay, actions, summary.
// No database access, no Date.now(); every timestamp comes from the caller
// and every function returns a new state object.

export const CARE_LIMITS = { min: 0, max: 100, maxOfflineMs: 24 * 60 * 60 * 1000 };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const CARE_ACTIONS = {
  snack: { cooldownMs: 10 * MINUTE, effects: { satiety: 10, mood: 2 } },
  play: { cooldownMs: 8 * MINUTE, minEnergy: 20, effects: { mood: 12, bond: 2, energy: -10 } },
  clean: { cooldownMs: 10 * MINUTE, setHygiene: 100, bondBonusBelowHygiene: 50, bondBonus: 1 },
  rest: { cooldownMs: 15 * MINUTE, effects: { energy: 25, satiety: -2 } },
  petEgg: { cooldownMs: 5 * MINUTE, stageOnly: 0, effects: { bond: 2 } },
};

// Per-hour drift while time passes; bond never decays.
const DECAY_PER_HOUR = { satiety: -2, mood: -1.5, energy: 3, hygiene: -1 };

function clamp(value) {
  if (value < CARE_LIMITS.min) return CARE_LIMITS.min;
  if (value > CARE_LIMITS.max) return CARE_LIMITS.max;
  return value;
}

export function createDefaultCareState(partnerId, nowMs) {
  return {
    partnerId,
    satiety: 72,
    mood: 70,
    energy: 80,
    hygiene: 75,
    bond: 0,
    cooldowns: { snack: 0, play: 0, clean: 0, rest: 0, petEgg: 0 },
    lastDecayAt: nowMs,
    updatedAt: nowMs,
  };
}

export function decayCareState(state, nowMs) {
  const elapsed = Math.max(0, nowMs - state.lastDecayAt);
  const capped = Math.min(elapsed, CARE_LIMITS.maxOfflineMs);
  const hours = capped / HOUR;
  // The decay amount is capped at 24h, but the clock always advances to nowMs
  // so the skipped time is never decayed twice.
  return {
    ...state,
    satiety: clamp(state.satiety + DECAY_PER_HOUR.satiety * hours),
    mood: clamp(state.mood + DECAY_PER_HOUR.mood * hours),
    energy: clamp(state.energy + DECAY_PER_HOUR.energy * hours),
    hygiene: clamp(state.hygiene + DECAY_PER_HOUR.hygiene * hours),
    cooldowns: { ...state.cooldowns },
    lastDecayAt: state.lastDecayAt + elapsed,
    updatedAt: nowMs,
  };
}

const ACTION_MESSAGES = {
  snack: "吃点心真开心！",
  play: "玩得好尽兴！",
  clean: "变得干干净净了。",
  rest: "好好休息了一下。",
  petEgg: "轻轻摸了摸蛋壳。",
};

export function applyCareAction(state, action, nowMs, context = {}) {
  const def = CARE_ACTIONS[action];
  if (!def) {
    return { ok: false, state, message: "不认识这个操作。", reason: "unknown-action" };
  }
  if ((state.cooldowns[action] ?? 0) > nowMs) {
    return { ok: false, state, message: "还在冷却中，稍等一会儿吧。", reason: "cooldown" };
  }
  if (def.stageOnly !== undefined && context.stage !== def.stageOnly) {
    return { ok: false, state, message: "只有蛋阶段才能这样做。", reason: "wrong-stage" };
  }
  if (def.minEnergy !== undefined && state.energy < def.minEnergy) {
    return { ok: false, state, message: "它现在太困了，先休息一下。", reason: "low-energy" };
  }

  const next = { ...state, cooldowns: { ...state.cooldowns }, updatedAt: nowMs };
  if (def.effects) {
    for (const [key, delta] of Object.entries(def.effects)) {
      next[key] = clamp(next[key] + delta);
    }
  }
  if (def.setHygiene !== undefined) {
    if (state.hygiene < def.bondBonusBelowHygiene) {
      next.bond = clamp(next.bond + def.bondBonus);
    }
    next.hygiene = def.setHygiene;
  }
  next.cooldowns[action] = nowMs + def.cooldownMs;
  return { ok: true, state: next, message: ACTION_MESSAGES[action] };
}

export function careSummary(state) {
  const score = (state.satiety + state.mood + state.energy + state.hygiene) / 4;
  const moodLabel =
    score >= 75 ? "神采奕奕" : score >= 50 ? "状态不错" : score >= 25 ? "有点没精神" : "需要照顾";
  const needsAttention = [state.satiety, state.mood, state.energy, state.hygiene].some((v) => v < 25);
  return { moodLabel, needsAttention };
}
