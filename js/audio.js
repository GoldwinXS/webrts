// Procedural WebAudio sound engine. Every sound is synthesized — no asset
// files, nothing to load. The context is created lazily on the first user
// gesture (browser autoplay policy).
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = localStorage.getItem("webrts-muted") === "1";
    this.lastAt = {};      // rate limiting per sound key
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.35;
    this.master.connect(this.ctx.destination);
  }

  setMuted(m) {
    this.muted = m;
    localStorage.setItem("webrts-muted", m ? "1" : "0");
    if (this.master) this.master.gain.value = m ? 0 : 0.35;
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

  // ---------- game sounds ----------

  select() { if (!this.limited("sel", 60)) this.beep(950, 1150, 0.04, "sine", 0.07); }
  ack() { if (this.limited("ack", 120)) return; this.beep(620, 900, 0.07, "square", 0.05); this.beep(900, 1000, 0.05, "square", 0.04, 0.06); }
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

  victory() {
    [523, 659, 784, 1047].forEach((f, i) => this.beep(f, f, 0.22, "triangle", 0.14, i * 0.16));
  }
  defeat() {
    [392, 330, 262, 196].forEach((f, i) => this.beep(f, f * 0.97, 0.3, "triangle", 0.13, i * 0.2));
  }
}
