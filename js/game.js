// Game driver: fixed-tick scheduler + deterministic lockstep.
//
// Local commands issued at tick T are scheduled for T+DELAY and sent to the
// opponent; the sim only advances when both players' command bundles for the
// next tick are in hand. Both machines therefore execute identical inputs on
// identical ticks — the whole game stays in sync while only commands cross
// the wire (the StarCraft/AoE model).
import { Sim } from "./core/sim.js";
import { AI } from "./core/ai.js";
import { TICK_MS } from "./core/data.js";

const DELAY = 3;           // input latency in ticks (300ms) — hides network jitter
const HASH_EVERY = 50;     // desync check cadence

export class Game {
  // mode: 'ai' | 'host' | 'client'
  constructor(mode, seed, net) {
    this.mode = mode;
    this.net = net || null;
    this.localPlayer = mode === "client" ? 1 : 0;
    this.sim = new Sim(seed);
    this.ai = mode === "ai" ? new AI(1) : null;

    this.pending = [];       // local commands captured this tick
    this.buffers = [new Map(), new Map()];  // pid -> (tick -> cmds)
    this.acc = 0;
    this.last = 0;
    this.stalled = false;
    this.myHashes = new Map();       // state tick -> our checksum (rolling)
    this.desynced = false;
    this.onEvents = null;    // renderer hook
    this.onStall = null;     // hud hook

    if (this.net) {
      // pre-seed the first DELAY ticks so both sides can start stepping
      for (let t = 0; t < DELAY; t++) {
        this.buffers[0].set(t, []);
        this.buffers[1].set(t, []);
      }
      this.net.onMessage = (msg) => this.onNet(msg);
    }
  }

  issue(cmd) {
    if (this.sim.winner >= 0) return;
    this.pending.push(cmd);
  }

  onNet(msg) {
    if (msg.k === "cmds") {
      this.buffers[1 - this.localPlayer].set(msg.t, msg.c);
      if (msg.h !== undefined) this.checkHash(msg.ht, msg.h);
    }
  }

  update(now) {
    if (!this.last) this.last = now;
    this.acc += now - this.last;
    this.last = now;
    if (this.acc > 1000) this.acc = 1000; // don't spiral after a tab-out

    let steps = 0;
    while (this.acc >= TICK_MS && steps < 5) {
      if (!this.tryStep()) break;
      this.acc -= TICK_MS;
      steps++;
    }
    return this.acc / TICK_MS; // interpolation alpha for the renderer
  }

  tryStep() {
    const t = this.sim.tick;

    if (this.net) {
      // ship our commands for tick t+DELAY (once per tick)
      const sendTick = t + DELAY;
      if (!this.buffers[this.localPlayer].has(sendTick)) {
        const mine = this.pending.splice(0);
        this.buffers[this.localPlayer].set(sendTick, mine);
        const msg = { k: "cmds", t: sendTick, c: mine };
        if (t % HASH_EVERY === 0) {
          // checksum of the state at tick t (we haven't stepped t yet)
          msg.h = this.sim.checksum();
          msg.ht = t;
          this.myHashes.set(t, msg.h);
          if (this.myHashes.size > 10) {
            const oldest = Math.min(...this.myHashes.keys());
            this.myHashes.delete(oldest);
          }
        }
        this.net.send(msg);
      }
      // lockstep gate: need the opponent's bundle for this tick
      const theirs = this.buffers[1 - this.localPlayer].get(t);
      if (theirs === undefined) {
        if (!this.stalled) { this.stalled = true; this.onStall?.(true); }
        return false;
      }
      if (this.stalled) { this.stalled = false; this.onStall?.(false); }

      const mine = this.buffers[this.localPlayer].get(t) || [];
      const bundle = this.localPlayer === 0
        ? [{ pid: 0, cmds: mine }, { pid: 1, cmds: theirs }]
        : [{ pid: 0, cmds: theirs }, { pid: 1, cmds: mine }];
      this.sim.step(bundle);
      this.buffers[0].delete(t); this.buffers[1].delete(t);
    } else {
      // local play: apply immediately, AI acts as player 1
      const bundle = [
        { pid: 0, cmds: this.pending.splice(0) },
        { pid: 1, cmds: this.ai ? this.ai.update(this.sim) : [] },
      ];
      this.sim.step(bundle);
    }

    if (this.sim.events.length) this.onEvents?.(this.sim.events);
    return true;
  }

  // Compare the opponent's checksum for a state tick against ours for the
  // same tick. Both sides record hashes at the same cadence, so a matching
  // entry exists unless the game has drifted badly out of step.
  checkHash(stateTick, remoteHash) {
    const mine = this.myHashes.get(stateTick);
    if (mine !== undefined && mine !== remoteHash && !this.desynced) {
      this.desynced = true;
      this.onDesync?.();
    }
  }
}
