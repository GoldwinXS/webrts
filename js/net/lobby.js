// Serverless lobby over the PeerJS broker — a "well-known peer" rendezvous.
//
// There is no game server. One player's browser claims a fixed, well-known
// PeerJS id ("webrts-lobby-v1"); that browser becomes the (invisible) LOBBY
// HOST — it holds a table of open rooms in memory and relays it to everyone
// else, who connect as LOBBY CLIENTS. It is pure discovery: a room is just a
// {code} that a poster advertises, and joining a room runs the EXISTING
// join-by-code path unchanged. If the host leaves, clients race to claim the
// well-known id and one becomes the new host (failover). If the broker refuses
// the id entirely, the lobby degrades to offline and the manual-code flow still
// works.
//
// This uses its OWN Peer instance, entirely separate from the match Net class,
// so any lobby failure (broker hiccup, id race, host churn) can never disturb
// an in-progress match. destroy() frees the well-known id so we don't strand a
// ghost host.

const LOBBY_ID = "webrts-lobby-v1"; // the well-known rendezvous peer id
const ROOM_TTL_MS = 5 * 60 * 1000;  // a room expires 5 min after its last refresh
const HEARTBEAT_MS = 10 * 1000;     // host pushes a full room list this often
const MAX_ROOMS = 50;               // hard cap on the table (untrusted input)
const MAX_NAME = 40;                // room-name length cap
const POST_MIN_INTERVAL_MS = 1500;  // per-connection rate limit on posts

// ---------------------------------------------------------------------------
// RoomTable — the host's pure room-registry logic, factored out so it can be
// unit-tested headlessly (no PeerJS, no DOM). Every method is deterministic
// given an injected `now`. Connections are referenced by an opaque string key
// (the host uses the PeerJS connection's peer id); the table never touches the
// network itself.
// ---------------------------------------------------------------------------
export class RoomTable {
  constructor() {
    this.rooms = new Map();      // code -> { code, name, map, faction, connKey, ts }
    this.lastPost = new Map();   // connKey -> last post timestamp (rate limit)
  }

  // Validate + normalize an untrusted room payload from a client. Returns a
  // clean room object, or null if the shape is invalid. Does NOT store text as
  // HTML — callers must escape at render time; here we only bound/normalize.
  static sanitizeRoom(raw) {
    if (!raw || typeof raw !== "object") return null;
    const code = typeof raw.code === "string" ? raw.code.trim().toUpperCase() : "";
    // codes are 4-5 chars from a known alphabet (see net.js makeCode)
    if (!/^[A-Z0-9]{4,6}$/.test(code)) return null;
    let name = typeof raw.name === "string" ? raw.name : "";
    // collapse control chars/newlines to spaces, trim, cap length
    name = name.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    if (!name) name = "Open game";
    let map = typeof raw.map === "string" ? raw.map.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 60) : "";
    let faction = typeof raw.faction === "string" ? raw.faction.slice(0, 12) : "";
    return { code, name, map, faction };
  }

  // Register/refresh a room from connection `connKey`. Enforces the rate limit,
  // the room cap, and one-room-per-connection (re-posting the same connection
  // just refreshes). Returns true if the table changed.
  post(connKey, raw, now = Date.now()) {
    const room = RoomTable.sanitizeRoom(raw);
    if (!room) return false;
    // rate limit posts per connection
    const last = this.lastPost.get(connKey) || 0;
    const existing = this.rooms.get(room.code);
    const isRefresh = existing && existing.connKey === connKey;
    if (!isRefresh && now - last < POST_MIN_INTERVAL_MS) return false;
    this.lastPost.set(connKey, now);
    // a code is owned by the first connection to post it; a different
    // connection cannot hijack someone else's code
    if (existing && existing.connKey !== connKey) return false;
    // cap: only reject genuinely NEW rooms once full (refreshes still allowed)
    if (!existing && this.rooms.size >= MAX_ROOMS) return false;
    // one room per connection: drop this connection's previous different room
    for (const [c, r] of this.rooms) {
      if (r.connKey === connKey && c !== room.code) this.rooms.delete(c);
    }
    this.rooms.set(room.code, { ...room, connKey, ts: now });
    return true;
  }

  // Remove a specific room, but only if `connKey` owns it. Returns true if removed.
  unpost(connKey, code, now = Date.now()) {
    const c = typeof code === "string" ? code.trim().toUpperCase() : "";
    const r = this.rooms.get(c);
    if (r && r.connKey === connKey) { this.rooms.delete(c); return true; }
    return false;
  }

  // Drop every room posted by a connection (called when that connection closes).
  // Returns true if the table changed.
  dropConnection(connKey) {
    let changed = false;
    for (const [c, r] of this.rooms) {
      if (r.connKey === connKey) { this.rooms.delete(c); changed = true; }
    }
    this.lastPost.delete(connKey);
    return changed;
  }

  // Expire stale rooms (poster went silent). Returns true if the table changed.
  expire(now = Date.now()) {
    let changed = false;
    for (const [c, r] of this.rooms) {
      if (now - r.ts > ROOM_TTL_MS) { this.rooms.delete(c); changed = true; }
    }
    return changed;
  }

  // The public snapshot pushed to clients: newest first, capped, no internal keys.
  list(now = Date.now()) {
    const out = [];
    for (const r of this.rooms.values()) {
      out.push({ code: r.code, name: r.name, map: r.map, faction: r.faction, ts: r.ts });
    }
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, MAX_ROOMS);
  }
}

// ---------------------------------------------------------------------------
// Lobby — the live PeerJS wiring around RoomTable. Emits status/rooms via
// callbacks. UI code (main.js) never sees PeerJS directly.
//
//   lobby.onStatus(role)  role in "connecting" | "host" | "client" | "offline"
//   lobby.onRooms(rooms)  latest room snapshot (array)
//
// Public API used by main.js:
//   start()               connect/host the lobby
//   post(room)            advertise your open game (also used as heartbeat)
//   unpost()              withdraw your game
//   destroy()             tear everything down, free the well-known id
// ---------------------------------------------------------------------------
export class Lobby {
  constructor() {
    this.peer = null;
    this.role = "offline";          // offline | connecting | host | client
    this.table = null;              // RoomTable when we are the host
    this.hostConns = new Map();     // client peerId -> DataConnection (host side)
    this.conn = null;               // our connection to the host (client side)
    this.myRoom = null;             // the room WE are advertising (for re-post on failover)
    this.heartbeatTimer = null;
    this.expireTimer = null;
    this.repostTimer = null;
    this.retryDelay = 500;
    this.destroyed = false;
    this.brokerRejected = false;    // broker refused the id outright -> stay offline

    this.onStatus = null;
    this.onRooms = null;
  }

  _status(role) {
    this.role = role;
    try { this.onStatus?.(role); } catch {}
  }

  _emitRooms(rooms) {
    try { this.onRooms?.(rooms || []); } catch {}
  }

  // Entry point: try to claim the well-known id (become host); if it's taken,
  // connect to it as a client. Handles the cold-start race + failover via retry.
  start() {
    if (this.destroyed) return;
    this._tryBecomeHost();
  }

  _tryBecomeHost() {
    if (this.destroyed) return;
    this._status("connecting");
    let peer;
    try {
      peer = new Peer(LOBBY_ID);
    } catch {
      return this._degrade();
    }
    peer.on("open", () => {
      if (this.destroyed) { peer.destroy(); return; }
      // we own the well-known id: we are the lobby host
      this.peer = peer;
      this._becomeHost();
    });
    peer.on("error", (err) => {
      const type = err && err.type;
      // someone already holds the id (or we lost a cold-start race) -> join as client
      if (type === "unavailable-id") {
        try { peer.destroy(); } catch {}
        this._becomeClient();
        return;
      }
      // network/server/browser problems: degrade to offline (manual codes still work)
      if (type === "browser-incompatible" || type === "ssl-unavailable" || type === "server-error") {
        try { peer.destroy(); } catch {}
        return this._degrade();
      }
      // transient (network, disconnected): degrade but let a later start() retry
      try { peer.destroy(); } catch {}
      this._degrade();
    });
  }

  _becomeHost() {
    this.table = new RoomTable();
    this._status("host");
    this.peer.on("connection", (conn) => this._wireHostConn(conn));
    this.peer.on("disconnected", () => { try { this.peer.reconnect(); } catch {} });
    this.peer.on("error", () => {}); // post-open errors shouldn't crash the host
    // heartbeat: push the full list + expire stale rooms periodically
    this.heartbeatTimer = setInterval(() => this._hostBroadcast(true), HEARTBEAT_MS);
    this._emitRooms(this.table.list());
  }

  _wireHostConn(conn) {
    const key = conn.peer; // opaque per-connection key
    conn.on("open", () => {
      if (this.destroyed) { try { conn.close(); } catch {} return; }
      this.hostConns.set(key, conn);
      // send the current list immediately on connect
      this._send(conn, { k: "rooms", rooms: this.table.list() });
    });
    conn.on("data", (msg) => this._hostHandle(key, conn, msg));
    conn.on("close", () => {
      this.hostConns.delete(key);
      if (this.table.dropConnection(key)) this._hostBroadcast();
    });
    conn.on("error", () => {
      this.hostConns.delete(key);
      if (this.table && this.table.dropConnection(key)) this._hostBroadcast();
    });
  }

  // Host-side message handler. Everything here is untrusted.
  _hostHandle(key, conn, msg) {
    if (!msg || typeof msg !== "object" || !this.table) return;
    switch (msg.k) {
      case "list":
        this._send(conn, { k: "rooms", rooms: this.table.list() });
        break;
      case "post":
        if (this.table.post(key, msg.room)) this._hostBroadcast();
        break;
      case "unpost":
        if (this.table.unpost(key, msg.code)) this._hostBroadcast();
        break;
      // unknown keys ignored
    }
  }

  // Push the current list to every connected client (after expiring stale rooms).
  _hostBroadcast(fromHeartbeat) {
    if (!this.table) return;
    if (fromHeartbeat) this.table.expire();
    const rooms = this.table.list();
    for (const conn of this.hostConns.values()) this._send(conn, { k: "rooms", rooms });
    this._emitRooms(rooms); // the host player also sees the list
  }

  _becomeClient() {
    if (this.destroyed) return;
    this._status("connecting");
    let peer;
    try {
      peer = new Peer(); // random id for a client
    } catch {
      return this._degrade();
    }
    this.peer = peer;
    peer.on("open", () => {
      if (this.destroyed) { peer.destroy(); return; }
      const conn = peer.connect(LOBBY_ID, { reliable: true });
      this._wireClientConn(conn);
    });
    peer.on("error", (err) => {
      // client-side broker failure: retry the whole handshake with backoff
      this._retryLater();
    });
    peer.on("disconnected", () => { try { peer.reconnect(); } catch {} });
  }

  _wireClientConn(conn) {
    this.conn = conn;
    let opened = false;
    // if the host vanished between our peer-claim attempt and now, connect can
    // hang; a timeout kicks us back into the failover race.
    const openTimeout = setTimeout(() => { if (!opened) this._onHostLost(); }, 8000);
    conn.on("open", () => {
      opened = true;
      clearTimeout(openTimeout);
      this._status("client");
      this.retryDelay = 500; // reset backoff on success
      this._send(conn, { k: "list" });
      // re-advertise our room if we had one (survives failover)
      if (this.myRoom) this._send(conn, { k: "post", room: this.myRoom });
      // as a client, keep our room fresh by re-posting on an interval
      this._startRepost();
    });
    conn.on("data", (msg) => {
      if (msg && typeof msg === "object" && msg.k === "rooms" && Array.isArray(msg.rooms)) {
        this._emitRooms(this._sanitizeIncoming(msg.rooms));
      }
    });
    conn.on("close", () => { clearTimeout(openTimeout); this._onHostLost(); });
    conn.on("error", () => { clearTimeout(openTimeout); this._onHostLost(); });
  }

  // Clients also validate what the host sends (host is untrusted too).
  _sanitizeIncoming(rooms) {
    const out = [];
    for (const r of rooms.slice(0, MAX_ROOMS)) {
      const clean = RoomTable.sanitizeRoom(r);
      if (clean) out.push({ ...clean, ts: typeof r.ts === "number" ? r.ts : Date.now() });
    }
    return out;
  }

  // The lobby host went away. Clear our client state and race to claim the
  // well-known id (jittered so all clients don't collide at once). Whoever wins
  // becomes the new host; the losers get 'unavailable-id' and reconnect as
  // clients via the normal error path.
  _onHostLost() {
    if (this.destroyed || this.role === "offline") return;
    this._teardownPeer();
    this._status("connecting");
    this._emitRooms([]);
    const jitter = 200 + Math.random() * 1200;
    this.repostTimer && clearInterval(this.repostTimer);
    setTimeout(() => this._tryBecomeHost(), jitter);
  }

  _retryLater() {
    if (this.destroyed) return;
    this._teardownPeer();
    this._degrade();
    const delay = Math.min(this.retryDelay, 8000) + Math.random() * 500;
    this.retryDelay = Math.min(this.retryDelay * 2, 8000);
    setTimeout(() => { if (!this.destroyed) this._tryBecomeHost(); }, delay);
  }

  _startRepost() {
    this.repostTimer && clearInterval(this.repostTimer);
    // re-post at half the TTL so an active listing never expires under us
    this.repostTimer = setInterval(() => {
      if (this.myRoom) this._sendToHost({ k: "post", room: this.myRoom });
    }, ROOM_TTL_MS / 2);
  }

  // Advertise (or refresh) our open game. Called on Create Match and as heartbeat.
  post(room) {
    this.myRoom = RoomTable.sanitizeRoom(room) || null;
    if (!this.myRoom) return;
    if (this.role === "host" && this.table) {
      // we ARE the host: post into our own table under a reserved self key
      if (this.table.post("__self__", this.myRoom)) this._hostBroadcast();
    } else {
      this._sendToHost({ k: "post", room: this.myRoom });
    }
  }

  // Withdraw our game (match started, or menu closed).
  unpost() {
    const code = this.myRoom && this.myRoom.code;
    this.myRoom = null;
    if (!code) return;
    if (this.role === "host" && this.table) {
      if (this.table.unpost("__self__", code)) this._hostBroadcast();
    } else {
      this._sendToHost({ k: "unpost", code });
    }
  }

  _sendToHost(msg) {
    if (this.conn && this.conn.open) this._send(this.conn, msg);
  }

  _send(conn, obj) {
    try { if (conn && conn.open) conn.send(obj); } catch {}
  }

  _degrade() {
    if (this.destroyed) return;
    this._status("offline");
    this._emitRooms([]);
  }

  // Tear down just the Peer + timers, keep myRoom (so failover can re-post).
  _teardownPeer() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    for (const conn of this.hostConns.values()) { try { conn.close(); } catch {} }
    this.hostConns.clear();
    try { this.conn && this.conn.close(); } catch {}
    this.conn = null;
    this.table = null;
    try { this.peer && this.peer.destroy(); } catch {}
    this.peer = null;
  }

  // Full shutdown: frees the well-known id so we never strand a ghost host.
  destroy() {
    this.destroyed = true;
    if (this.repostTimer) { clearInterval(this.repostTimer); this.repostTimer = null; }
    if (this.expireTimer) { clearInterval(this.expireTimer); this.expireTimer = null; }
    this._teardownPeer();
    this._status("offline");
  }
}
