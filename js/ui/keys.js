// Rebindable keymap (foundation — a settings UI comes with the HUD
// redesign; until then rebind from the console via RTS.rebind).
// Grid keys on the command card are positional and not remapped here.
const DEFAULTS = {
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
