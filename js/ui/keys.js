// Rebindable keymap. A click-to-rebind settings UI lives in hud.js; you can
// also rebind from the console via RTS.rebind.
// Grid keys on the command card are positional and not remapped here.
export const DEFAULTS = {
  idleWorker: ["f1", "i"],
  selectArmy: ["f2"],
  cameraSlots: ["f5", "f6", "f7", "f8"],   // Ctrl+key saves, key recalls
  cycleBase: ["backspace"],
  rotateLeft: [","],
  rotateRight: ["."],
};

let overrides = {};
try { overrides = JSON.parse(localStorage.getItem("webrts-keys") || "{}"); } catch { /* corrupt -> defaults */ }

export const KEYS = { ...DEFAULTS, ...overrides };

// rebind("idleWorker", ["f1", "u"]) — persists across sessions
export function rebind(action, keys) {
  if (!(action in DEFAULTS)) return false;
  KEYS[action] = (Array.isArray(keys) ? keys : [keys]).map((k) => String(k).toLowerCase());
  overrides[action] = KEYS[action];
  localStorage.setItem("webrts-keys", JSON.stringify(overrides));
  return true;
}

// Wipe all overrides and restore DEFAULTS. Mutates KEYS in place (it is an
// exported const, so callers keep their live reference) and returns it.
export function resetBinds() {
  overrides = {};
  localStorage.removeItem("webrts-keys");
  for (const k of Object.keys(KEYS)) delete KEYS[k];
  for (const [k, v] of Object.entries(DEFAULTS)) KEYS[k] = [...v];
  return KEYS;
}
