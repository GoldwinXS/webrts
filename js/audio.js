// Procedural WebAudio sound engine. Every sound is synthesized — no asset
// files, nothing to load. The context is created lazily on the first user
// gesture (browser autoplay policy).
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = localStorage.getItem("webrts-muted") === "1";
    this.volume = 0.5;     // 0..1 user volume; scaled to gain in gainValue()
    this.lastAt = {};      // rate limiting per sound key
  }

  init() {
    if (this.ctx) return;
    const stored = parseFloat(localStorage.getItem("webrts-volume"));
    if (!Number.isNaN(stored)) this.volume = Math.max(0, Math.min(1, stored));
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.gainValue();
    this.master.connect(this.ctx.destination);
  }

  // full volume (v=1) maps to gain 0.7; the historical full-volume level was
  // 0.35, which is now the default v=0.5.
  gainValue() { return this.muted ? 0 : this.volume * 0.7; }

  setMuted(m) {
    this.muted = m;
    localStorage.setItem("webrts-muted", m ? "1" : "0");
    if (this.master) this.master.gain.value = this.gainValue();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    localStorage.setItem("webrts-volume", String(this.volume));
    if (this.master && !this.muted) this.master.gain.value = this.gainValue();
  }

  limited(key, ms) {
    const now = performance.now();
    if (now - (this.lastAt[key] || 0) < ms) return true;
    this.lastAt[key] = now;
    return false;
  }

  // ---------- synth primitives ----------

  beep(f0, f1, dur, type = "sine", vol = 0.2, when = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noise(dur, filterFreq, vol = 0.3, type = "lowpass", when = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + when;
    const n = Math.ceil(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = filterFreq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  // A resonant filtered-noise ZAP: a burst of noise pushed through a high-Q
  // bandpass whose centre frequency sweeps f0->f1. Reads as a crackly electric
  // hum/zap — the Tempest voice. Short and quiet by default.
  zap(f0, f1, dur, vol = 0.12, q = 9, when = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + when;
    const n = Math.ceil(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  // ---------- game sounds ----------

  select() { if (!this.limited("sel", 60)) this.beep(950, 1150, 0.04, "sine", 0.07); }

  // ---- acknowledgment voices ----
  // ack(faction)   — a unit acknowledges a SELECT (a "yes?" / "reporting" note)
  // ackMove(faction) — a unit acknowledges an ORDER (a "moving out" note)
  // faction is one of "cog" | "ooze" | "tempest"; omitted/unknown -> neutral
  // beeps, so the legacy no-arg audio.ack()/select-move call sites keep working.
  // Each voice is procedural, short (<0.35s) and quiet vs combat sounds, with a
  // little per-call pitch jitter so a group of units doesn't chorus in unison.

  ack(faction) {
    if (this.limited("ack", 120)) return;
    this._voice(faction, false);
  }
  ackMove(faction) {
    if (this.limited("ack", 120)) return;
    this._voice(faction, true);
  }

  // Dispatch to a faction voice. `order` = true -> the "moving out" variant
  // (a touch lower/more resolved), false -> the "yes?" select variant.
  _voice(faction, order) {
    const j = 1 + (Math.random() - 0.5) * 0.12;   // +-6% pitch jitter per call
    switch (faction) {
      case "cog": return this._voiceCog(order, j);
      case "ooze": return this._voiceOoze(order, j);
      case "tempest": return this._voiceTempest(order, j);
      default:
        // neutral fallback: the original two-square-beep chirp (backward compat)
        this.beep(620, 900, 0.07, "square", 0.05);
        this.beep(900, 1000, 0.05, "square", 0.04, 0.06);
    }
  }

  // COGS — cheerful little robot chirp sequences (bright square/sine beeps).
  _voiceCog(order, j) {
    if (order) {
      // "on it!" — a rising 3-note skip
      this.beep(720 * j, 760 * j, 0.05, "square", 0.05);
      this.beep(900 * j, 940 * j, 0.05, "square", 0.05, 0.06);
      this.beep(1180 * j, 1240 * j, 0.06, "sine", 0.045, 0.12);
    } else {
      // "yes?" — a quick two-note query
      this.beep(880 * j, 940 * j, 0.05, "square", 0.05);
      this.beep(1120 * j, 1180 * j, 0.05, "sine", 0.045, 0.06);
    }
  }

  // OOZE — wet squelchy blips: a filtered-noise splat + a pitch-bent sine gloop.
  _voiceOoze(order, j) {
    if (order) {
      // downward gloop + squelch — "sloshing off"
      this.noise(0.05, 520, 0.06, "lowpass");
      this.beep(360 * j, 150 * j, 0.16, "sine", 0.07, 0.02);
      this.beep(220 * j, 120 * j, 0.1, "sine", 0.04, 0.14);
    } else {
      // upward inquisitive gloop + wet blip — "hrmm?"
      this.noise(0.04, 600, 0.05, "lowpass");
      this.beep(240 * j, 460 * j, 0.14, "sine", 0.07, 0.02);
    }
  }

  // TEMPEST — crackly static-zap hums: a resonant filter sweep + a cyan tone.
  _voiceTempest(order, j) {
    if (order) {
      // discharge downward — "surging out"
      this.zap(2600 * j, 700 * j, 0.16, 0.1, 10);
      this.beep(1300 * j, 900 * j, 0.1, "sine", 0.04, 0.04);
    } else {
      // rising crackle query — "charged?"
      this.zap(900 * j, 2400 * j, 0.14, 0.09, 11);
      this.beep(1000 * j, 1500 * j, 0.08, "sine", 0.035, 0.03);
    }
  }

  attackAck() { if (this.limited("ack", 120)) return; this.beep(440, 300, 0.09, "square", 0.06); this.beep(330, 260, 0.08, "square", 0.05, 0.07); }
  gatherAck() { if (this.limited("ack", 120)) return; this.beep(700, 1300, 0.08, "triangle", 0.06); }

  shot() { if (this.limited("shot", 70)) return; this.beep(1700 + Math.random() * 400, 300, 0.09, "sawtooth", 0.045); }
  melee() { if (this.limited("melee", 90)) return; this.noise(0.06, 900, 0.12, "bandpass"); this.beep(180, 90, 0.06, "triangle", 0.09); }

  unitDeath() {
    if (this.limited("death", 90)) return;
    this.noise(0.22, 1600, 0.16);
    this.beep(220, 40, 0.25, "triangle", 0.12);
  }
  buildingDeath() {
    this.noise(0.7, 500, 0.4);
    this.noise(0.5, 2500, 0.18, "highpass", 0.05);
    this.beep(90, 24, 0.7, "sine", 0.35);
  }

  place() { this.beep(300, 180, 0.1, "triangle", 0.14); this.noise(0.08, 700, 0.08, "lowpass", 0.02); }
  complete() { this.beep(523, 523, 0.09, "triangle", 0.1); this.beep(659, 659, 0.09, "triangle", 0.1, 0.09); this.beep(784, 784, 0.14, "triangle", 0.11, 0.18); }
  trained() { if (this.limited("trained", 200)) return; this.beep(740, 880, 0.08, "triangle", 0.09); }
  rally() { this.beep(880, 1100, 0.06, "sine", 0.07); }
  error() { if (this.limited("err", 250)) return; this.beep(170, 150, 0.13, "square", 0.09); }

  underAttack() {
    if (this.limited("alarm", 8000)) return;
    for (let i = 0; i < 2; i++) {
      this.beep(880, 880, 0.13, "square", 0.12, i * 0.22);
      this.beep(660, 660, 0.13, "square", 0.12, i * 0.22 + 0.11);
    }
  }

  // ---------- ability cues (subtle, distinct) ----------
  stim() { if (this.limited("stim", 120)) return; this.beep(160, 90, 0.05, "sine", 0.11); this.beep(150, 80, 0.05, "sine", 0.10, 0.09); }
  siegeUp() { this.noise(0.18, 400, 0.22, "lowpass"); this.beep(240, 70, 0.22, "square", 0.12); }
  siegeDown() { this.beep(80, 260, 0.2, "square", 0.11); this.noise(0.14, 600, 0.16, "lowpass", 0.04); }
  leap() { if (this.limited("leap", 120)) return; this.noise(0.22, 1400, 0.14, "bandpass"); this.beep(500, 1400, 0.18, "sine", 0.07); }
  burners() { if (this.limited("burn", 120)) return; this.beep(220, 900, 0.28, "sawtooth", 0.08); }
  barrage() { if (this.limited("barr", 150)) return; for (let i = 0; i < 3; i++) this.beep(300, 160, 0.05, "square", 0.09, i * 0.06); }
  researchDone() { this.beep(523, 523, 0.09, "triangle", 0.1); this.beep(659, 659, 0.09, "triangle", 0.1, 0.09); this.beep(587, 587, 0.16, "triangle", 0.11, 0.18); }

  victory() {
    [523, 659, 784, 1047].forEach((f, i) => this.beep(f, f, 0.22, "triangle", 0.14, i * 0.16));
  }
  defeat() {
    [392, 330, 262, 196].forEach((f, i) => this.beep(f, f * 0.97, 0.3, "triangle", 0.13, i * 0.2));
  }
}
