// server/server.js (ESM)
// Ringsel Holo Wars — production-ready server with publicTroops broadcast
// Adds tile.publicTroops (sum of all players' troops on a tile) and emits tile_update
// wherever troops change so every client sees the same big number in realtime.
//
// Run locally:
//   npm i express socket.io cors uuid
//   node server.js
//
// Deploy flags via env:
//   PORT                 - port to listen on (platform supplies on PaaS)
//   REDIS_URL            - enable socket.io-redis adapter (e.g. redis://:pass@host:6379)
//   DISABLE_IP_LOCK      - "1" to allow multiple sessions per IP
//   PERSIST_FILE         - path to state JSON (default ./data/state.json)
//   SNAPSHOT_INTERVAL    - ms between snapshots (default 10000)
//   START_TROOPS         - initial troops at capital on join (default 100)
//   DEFENDERS_PER_TILE   - default defenders for claimed tiles (default 100)
//   NEUTRAL_DEFENDERS    - default neutral defenders (default 25)

import express from "express";
import http from "http";
import cors from "cors";
import { Server as IOServer } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

// -------------------------- Config --------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8787;
const RECRUIT_DURATION_MS = 5 * 60 * 1000; // 5:00
const RESERVE_CAP = 1000; // 0..1000 per cycle
const NEUTRAL_DEFENDERS_DEFAULT = Number(process.env.NEUTRAL_DEFENDERS || 25);
const START_TILES_AROUND_CAPITAL = 25;
const START_TROOPS = Number(process.env.START_TROOPS || 100);
const CLAIM_DEFENDERS = Number(process.env.DEFENDERS_PER_TILE || 100);
const PERSIST_FILE = process.env.PERSIST_FILE || path.join(__dirname, "data", "state.json");
const SNAPSHOT_INTERVAL = Number(process.env.SNAPSHOT_INTERVAL || 10000);
const DISABLE_IP_LOCK = process.env.DISABLE_IP_LOCK === "1";

// -------------------------- Helpers -------------------------
const DIRS = [
  [ 1, 0], [-1, 0], [ 0, 1], [ 0,-1], [ 1,-1], [-1, 1]
];
const key = (q, r) => `${q},${r}`;
const neighborsOf = (q, r) => DIRS.map(([dq, dr]) => [q + dq, r + dr]);

function axialToPixel(q, r, size = 10) {
  const x = size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const y = size * (1.5 * r);
  return { x, y };
}

function insidePolygon(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) c = !c;
  }
  return c;
}

function uniqueClosestTileToPoint(tilesMap, target, size = 10) {
  let best = null, bestDist = Infinity;
  for (const t of tilesMap.values()) {
    const { x, y } = axialToPixel(t.q, t.r, size);
    const d = (x - target.x) ** 2 + (y - target.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

function bfsRegion(startId, tiles, passableFn, limit = Infinity) {
  const seen = new Set([startId]);
  const q = [startId];
  const out = [];
  while (q.length && out.length < limit) {
    const id = q.shift();
    out.push(id);
    const t = tiles.get(id);
    for (const [dq, dr] of DIRS) {
      const nid = key(t.q + dq, t.r + dr);
      const nt = tiles.get(nid);
      if (!nt) continue;
      if (!seen.has(nid) && passableFn(nt)) {
        seen.add(nid);
        q.push(nid);
      }
    }
  }
  return out;
}

// -------------------------- World generation -------------------------
function buildPentagonWorld() {
  const radius = 25;
  const rawTiles = new Map();
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) {
      rawTiles.set(key(q, r), { id: key(q, r), q, r });
    }
  }

  const R = 260;
  const pent = [];
  for (let i = 0; i < 5; i++) {
    const theta = (Math.PI * 2 * i) / 5 - Math.PI / 2;
    pent.push({ x: R * Math.cos(theta), y: R * Math.sin(theta) });
  }

  const tiles = new Map();
  for (const t of rawTiles.values()) {
    const { x, y } = axialToPixel(t.q, t.r, 10);
    if (insidePolygon({ x, y }, pent)) {
      tiles.set(t.id, {
        id: t.id, q: t.q, r: t.r,
        ownerFaction: "neutral",
        control: NEUTRAL_DEFENDERS_DEFAULT,
        isCapital: false,
        publicTroops: 0 // NEW: public sum of all players' troops on this tile
      });
    }
  }

  const factions = [
    { id: "f1", name: "Ouro Kronii", color: "#1e3a8a" },
    { id: "f2", name: "Hakos Baelz", color: "#ef4444" },
    { id: "f3", name: "Nerissa Ravencroft", color: "#1e40af" },
    { id: "f4", name: "Takanashi Kiara", color: "#f97316" },
    { id: "f5", name: "Calliope Mori", color: "#ec4899" },
  ];

  const capitalsByFaction = {};
  const usedCapitalIds = new Set();

  for (let i = 0; i < 5; i++) {
    const v = pent[i];
    const cap = uniqueClosestTileToPoint(tiles, v, 10);
    if (!cap) continue;
    let capId = cap.id;

    if (usedCapitalIds.has(capId)) {
      for (const [dq, dr] of DIRS) {
        const nid = key(cap.q + dq, cap.r + dr);
        if (tiles.has(nid) && !usedCapitalIds.has(nid)) {
          capId = nid;
          break;
        }
      }
    }
    usedCapitalIds.add(capId);

    const f = factions[i];
    capitalsByFaction[f.id] = capId;
    const t = tiles.get(capId);
    t.ownerFaction = f.id;
    t.isCapital = true;
    t.control = CLAIM_DEFENDERS; // capitals unconquerable but show defenders
  }

  for (const f of factions) {
    const capId = capitalsByFaction[f.id];
    if (!capId) continue;
    const region = bfsRegion(
      capId,
      tiles,
      (tile) => tile.ownerFaction === "neutral" || tile.id === capId,
      START_TILES_AROUND_CAPITAL + 1
    );
    for (const tid of region) {
      const t = tiles.get(tid);
      t.ownerFaction = f.id;
      if (!t.isCapital) t.control = CLAIM_DEFENDERS;
    }
  }

  return { tiles, factions, capitalsByFaction };
}

// -------------------------- State & persistence -------------------------
let world = buildPentagonWorld();
const tiles = world.tiles;
const factions = world.factions;
const capitalsByFaction = world.capitalsByFaction;

const players = new Map(); // token -> player
/* player = {
  token, name, factionId,
  troops: { [tileId]: number },
  producedPrecise, produced, inventory,
  remainingMs, recruitDurationMs, reserveCap
} */
const tokenToSocket = new Map(); // token -> socket.id
const ipToToken = new Map();     // ip -> token (only if IP lock enabled)

// NEW: recompute and persist publicTroops
function recalcPublicTroops(tileId) {
  let sum = 0;
  for (const p of players.values()) sum += (p.troops[tileId] || 0);
  const t = tiles.get(tileId);
  if (t) t.publicTroops = sum;
}
function recalcAllPublicTroops() {
  for (const t of tiles.values()) {
    recalcPublicTroops(t.id);
  }
}

function snapshot() {
  const data = {
    world: {
      tiles: [...tiles.values()],
      factions,
      capitalsByFaction,
    },
    players: [...players.values()].map(p => ({
      token: p.token,
      name: p.name,
      factionId: p.factionId,
      troops: p.troops,
      producedPrecise: p.producedPrecise,
      produced: p.produced,
      inventory: p.inventory,
      remainingMs: p.remainingMs,
      recruitDurationMs: p.recruitDurationMs,
      reserveCap: p.reserveCap,
    })),
    ipToToken: DISABLE_IP_LOCK ? {} : Object.fromEntries(ipToToken),
  };
  fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
  fs.writeFileSync(PERSIST_FILE, JSON.stringify(data));
}

function loadSnapshot() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const data = JSON.parse(fs.readFileSync(PERSIST_FILE, "utf-8"));

    // restore world tiles (mutable)
    tiles.clear();
    for (const t of data.world.tiles) {
      // ensure publicTroops exists in old snapshots
      tiles.set(t.id, { ...t, publicTroops: typeof t.publicTroops === 'number' ? t.publicTroops : 0 });
    }
    world.factions = data.world.factions || factions;
    world.capitalsByFaction = data.world.capitalsByFaction || capitalsByFaction;

    // restore players
    players.clear();
    for (const p of (data.players || [])) {
      players.set(p.token, { ...p });
    }

    if (!DISABLE_IP_LOCK && data.ipToToken) {
      ipToToken.clear();
      for (const [ip, token] of Object.entries(data.ipToToken)) {
        ipToToken.set(ip, token);
      }
    }

    // recompute publicTroops from restored players
    recalcAllPublicTroops();

    console.log("State snapshot loaded:", PERSIST_FILE);
  } catch (e) {
    console.error("Failed to load snapshot:", e);
  }
}
loadSnapshot();
setInterval(() => {
  try { snapshot(); } catch (e) { console.error("Snapshot error:", e); }
}, SNAPSHOT_INTERVAL);

// -------------------------- Rate limiting -------------------------
function makeLimiter({ capacity = 20, refillPerSec = 10 } = {}) {
  return { tokens: capacity, capacity, refillPerSec, last: Date.now() };
}
function consume(limiter, cost = 1) {
  const now = Date.now();
  const delta = (now - limiter.last) / 1000;
  limiter.tokens = Math.min(limiter.capacity, limiter.tokens + delta * limiter.refillPerSec);
  limiter.last = now;
  if (limiter.tokens >= cost) {
    limiter.tokens -= cost;
    return true;
  }
  return false;
}
const actionLimiters = new Map(); // token -> limiter

// -------------------------- Server setup -------------------------
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: "*" } });

// Optional Redis adapter for scaling if REDIS_URL is set
if (process.env.REDIS_URL) {
  const { createAdapter } = await import("@socket.io/redis-adapter").catch(()=>({}));
  const { createClient } = await import("redis").catch(()=>({}));
  if (createAdapter && createClient) {
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    await pubClient.connect();
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));
    console.log("Socket.IO using Redis adapter.");
  } else {
    console.warn("REDIS_URL set but redis packages not installed.");
  }
}

app.get("/", (_req, res) => res.send("Ringsel Holo Wars server online."));

function buildMe(p) {
  return {
    name: p.name,
    factionId: p.factionId,
    troops: p.troops,
    produced: p.produced,
    inventory: p.inventory,
    remainingMs: p.remainingMs,
    recruitDurationMs: p.recruitDurationMs,
    reserveCap: p.reserveCap,
    token: p.token,
  };
}

function worldPayload() {
  return {
    tiles: Object.fromEntries([...tiles.values()].map(t => [t.id, t])),
    factions,
    capitalsByFaction,
  };
}

function pushPlayersOnline() {
  const list = [...players.values()].map(p => ({ id: p.token, name: p.name, factionId: p.factionId }));
  io.emit("players_online", list);
}

io.on("connection", (socket) => {
  const ip = socket.handshake.headers["x-forwarded-for"]?.toString().split(",")[0].trim()
    || socket.handshake.address;

  // IP locking (optional)
  if (!DISABLE_IP_LOCK) {
    const existing = ipToToken.get(ip);
    if (existing && tokenToSocket.has(existing)) {
      socket.emit("session_error", { message: "Only one active session per IP is allowed." });
      socket.disconnect();
      return;
    }
  }

  socket.emit("world", worldPayload());
  pushPlayersOnline();

  socket.on("resume", ({ token }) => {
    const p = token && players.get(token);
    if (!p) {
      socket.emit("error_msg", { message: "Invalid or expired session." });
      return;
    }
    // Replace older socket if any
    const prevId = tokenToSocket.get(token);
    if (prevId && prevId !== socket.id) {
      const prev = io.sockets.sockets.get(prevId);
      if (prev) prev.disconnect(true);
    }
    tokenToSocket.set(token, socket.id);
    if (!DISABLE_IP_LOCK) ipToToken.set(ip, token);
    actionLimiters.set(token, actionLimiters.get(token) || makeLimiter());
    socket.emit("joined", { me: buildMe(p) });
    pushPlayersOnline();
  });

  socket.on("join", ({ name, factionId }) => {
    if (!name || !factionId || !factions.find(f => f.id === factionId)) {
      socket.emit("error_msg", { message: "Invalid join payload." });
      return;
    }
    // New token
    const token = crypto.randomBytes(16).toString("hex");
    const p = {
      token,
      name: String(name).slice(0, 24),
      factionId,
      troops: {},
      producedPrecise: 0,
      produced: 0,
      inventory: 0,
      remainingMs: RECRUIT_DURATION_MS,
      recruitDurationMs: RECRUIT_DURATION_MS,
      reserveCap: RESERVE_CAP,
    };
    // Start with troops at capital
    const capId = capitalsByFaction[factionId];
    if (capId) {
      p.troops[capId] = (p.troops[capId] || 0) + START_TROOPS;
      recalcPublicTroops(capId);
      io.emit("tile_update", { tile: tiles.get(capId) });
    }

    players.set(token, p);
    tokenToSocket.set(token, socket.id);
    if (!DISABLE_IP_LOCK) ipToToken.set(ip, token);
    actionLimiters.set(token, makeLimiter());

    socket.emit("joined", { me: buildMe(p) });
    pushPlayersOnline();
  });

  socket.on("recruit_collect", () => {
    const token = [...tokenToSocket.entries()].find(([, sid]) => sid === socket.id)?.[0];
    const p = token && players.get(token);
    if (!p) return;
    if (!consume(actionLimiters.get(token))) return;

    const add = p.produced; // integer only
    if (add > 0) {
      p.inventory += add;
      p.producedPrecise = Math.max(0, (p.producedPrecise || 0) - add);
      p.produced = 0;
      p.remainingMs = RECRUIT_DURATION_MS;
      socket.emit("me_update", buildMe(p));
    }
  });

  socket.on("deploy", ({ targetId, amount }) => {
    const token = [...tokenToSocket.entries()].find(([, sid]) => sid === socket.id)?.[0];
    const p = token && players.get(token);
    if (!p) return;
    if (!consume(actionLimiters.get(token))) return;

    const t = tiles.get(targetId);
    amount = Math.floor(Number(amount) || 0);
    if (!t || amount < 1 || p.inventory < amount) return;

    // Must be connected to capital
    const capId = capitalsByFaction[p.factionId];
    const eligible = new Set(bfsRegion(capId, tiles, (tile) => tile.ownerFaction === p.factionId));
    if (!eligible.has(targetId)) {
      socket.emit("error_msg", { message: "Target not connected to your capital." });
      return;
    }

    p.inventory -= amount;
    p.troops[targetId] = (p.troops[targetId] || 0) + amount;
    recalcPublicTroops(targetId);
    socket.emit("me_update", buildMe(p));
    io.emit("tile_update", { tile: tiles.get(targetId) });
  });

  socket.on("move", ({ fromId, toId, amount }) => {
    const token = [...tokenToSocket.entries()].find(([, sid]) => sid === socket.id)?.[0];
    const p = token && players.get(token);
    if (!p) return;
    if (!consume(actionLimiters.get(token))) return;

    const from = tiles.get(fromId), to = tiles.get(toId);
    amount = Math.floor(Number(amount) || 0);
    if (!from || !to || amount < 1) return;

    const adj = neighborsOf(from.q, from.r).some(([q, r]) => key(q, r) === toId);
    if (!adj) return;
    if (from.ownerFaction !== p.factionId || to.ownerFaction !== p.factionId) return;

    const have = p.troops[fromId] || 0;
    if (have < amount) return;

    p.troops[fromId] = have - amount;
    if (p.troops[fromId] <= 0) delete p.troops[fromId];
    p.troops[toId] = (p.troops[toId] || 0) + amount;

    recalcPublicTroops(fromId);
    recalcPublicTroops(toId);
    socket.emit("me_update", buildMe(p));
    io.emit("tile_update", { tile: tiles.get(fromId) });
    io.emit("tile_update", { tile: tiles.get(toId) });
  });

  socket.on("attack", ({ fromId, targetId, amount }) => {
    const token = [...tokenToSocket.entries()].find(([, sid]) => sid === socket.id)?.[0];
    const p = token && players.get(token);
    if (!p) return;
    if (!consume(actionLimiters.get(token))) return;

    const from = tiles.get(fromId), target = tiles.get(targetId);
    amount = Math.floor(Number(amount) || 0);
    if (!from || !target || amount < 1) return;
    if (from.ownerFaction !== p.factionId) return;
    if ((p.troops[fromId] || 0) < amount) return;

    const adj = neighborsOf(from.q, from.r).some(([q, r]) => key(q, r) === targetId);
    if (!adj) return;
    if (target.isCapital) {
      socket.emit("error_msg", { message: "Capitals cannot be conquered." });
      return;
    }

    const defenders = target.control;
    if (amount > defenders) {
      // capture succeeds
      p.troops[fromId] -= amount;
      if (p.troops[fromId] <= 0) delete p.troops[fromId];

      const survivors = amount - defenders;
      target.ownerFaction = p.factionId;
      target.control = 0;
      p.troops[targetId] = (p.troops[targetId] || 0) + survivors;

      recalcPublicTroops(fromId);
      recalcPublicTroops(targetId);
      socket.emit("me_update", buildMe(p));
      io.emit("combat_result", { fromId, targetId, survivors });
      io.emit("tile_update", { tile: tiles.get(fromId) });
      io.emit("tile_update", { tile: tiles.get(targetId) });
    } else {
      // attack fails; attackers wiped on that action, defenders reduced
      p.troops[fromId] -= amount;
      if (p.troops[fromId] <= 0) delete p.troops[fromId];
      target.control = defenders - amount;

      recalcPublicTroops(fromId);
      socket.emit("me_update", buildMe(p));
      io.emit("tile_update", { tile: tiles.get(fromId) });
      io.emit("tile_update", { tile: tiles.get(targetId) });
    }
  });

  socket.on("disconnect", () => {
    // keep player state (persistence), only drop socket mapping
    const token = [...tokenToSocket.entries()].find(([, sid]) => sid === socket.id)?.[0];
    if (token) tokenToSocket.delete(token);
    if (!DISABLE_IP_LOCK) {
      const ipEntry = [...ipToToken.entries()].find(([, tok]) => tok === token);
      if (ipEntry) ipToToken.delete(ipEntry[0]);
    }
    pushPlayersOnline();
  });
});

// -------------------------- Recruitment tick -------------------------
setInterval(() => {
  for (const p of players.values()) {
    const perSec = p.reserveCap / (p.recruitDurationMs / 1000);
    if (p.remainingMs > 0) {
      p.remainingMs = Math.max(0, p.remainingMs - 1000);
      p.producedPrecise = Math.min(p.reserveCap, (p.producedPrecise || 0) + perSec);
      p.produced = Math.floor(p.producedPrecise);
    } else {
      p.producedPrecise = Math.min(p.reserveCap, p.producedPrecise || 0);
      p.produced = Math.floor(p.producedPrecise);
    }
    const sid = tokenToSocket.get(p.token);
    const s = sid && io.sockets.sockets.get(sid);
    if (s) s.emit("me_update", buildMe(p));
  }
}, 1000);

// -------------------------- Boot -------------------------
server.listen(PORT, () => {
  console.log(`Ringsel Holo Wars server listening on :${PORT}`);
});
