// PeerJS transport. Uses the free public PeerServer broker for the WebRTC
// handshake only — after that all traffic is a direct P2P data channel, so
// this works from any static host (GitHub Pages included).
const PREFIX = "webrts-v1-";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function makeCode() {
  let code = "";
  const buf = new Uint32Array(5);
  crypto.getRandomValues(buf);
  for (const v of buf) code += CODE_CHARS[v % CODE_CHARS.length];
  return code;
}

export class Net {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.onMessage = null;
    this.onOpen = null;
    this.onClose = null;
  }

  host(code) {
    this.peer = new Peer(PREFIX + code);
    return new Promise((resolve, reject) => {
      this.peer.on("error", (err) => reject(err));
      this.peer.on("open", () => {
        this.peer.on("connection", (conn) => {
          if (this.conn) { conn.close(); return; } // one opponent only
          this.wire(conn);
        });
        resolve();
      });
    });
  }

  join(code) {
    this.peer = new Peer();
    return new Promise((resolve, reject) => {
      this.peer.on("error", (err) => reject(err));
      this.peer.on("open", () => {
        const conn = this.peer.connect(PREFIX + code, { reliable: true });
        conn.on("error", (err) => reject(err));
        this.wire(conn);
        resolve();
      });
    });
  }

  wire(conn) {
    this.conn = conn;
    conn.on("open", () => this.onOpen?.());
    conn.on("data", (data) => this.onMessage?.(data));
    conn.on("close", () => this.onClose?.());
    conn.on("error", () => this.onClose?.());
  }

  send(obj) {
    if (this.conn?.open) this.conn.send(obj);
  }

  destroy() {
    this.conn?.close();
    this.peer?.destroy();
    this.conn = this.peer = null;
  }
}
