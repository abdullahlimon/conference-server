const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);

app.set("trust proxy", true);

const allowedOrigins = [
  "https://meet.futuretrackconsultancy.com",
  "http://meet.futuretrackconsultancy.com",
  "https://futuretrackconsultancy.com",
  "*",
];

const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── In-memory data ─────────────────────────────────────
// sessions[id] = { id, title, password, adminPassword, maxPeople, createdAt, participants:{}, chat:[], handQueue:[], bans:{ip:expireAt} }
const sessions = {};

const BAN_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function getClientIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
}

function getSocketIp(socket) {
  return (socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "").toString().split(",")[0].trim();
}

function isBanned(session, ip) {
  if (!session.bans[ip]) return false;
  if (Date.now() > session.bans[ip]) { delete session.bans[ip]; return false; }
  return true;
}

function msToHours(ms) { return Math.ceil(ms / (60 * 60 * 1000)); }

// ── REST API ──────────────────────────────────────────
// Create session (owner admin password included)
app.post("/api/sessions", (req, res) => {
  const { title, password, adminPassword, maxPeople } = req.body;
  if (!title || !password || !adminPassword) return res.status(400).json({ error: "title, password and adminPassword required" });
  const id = uuidv4().slice(0, 8);
  sessions[id] = {
    id, title, password, adminPassword,
    maxPeople: maxPeople || 200,
    createdAt: Date.now(),
    isLive: true,
    participants: {},
    chat: [],
    handQueue: [],
    bans: {},
  };
  io.emit("sessions_updated", sanitizeSessions());
  res.json({ id, title });
});

// Public listing (no passwords exposed)
app.get("/api/sessions", (req, res) => res.json(sanitizeSessions()));

// Delete a session — requires admin password (only way to prevent unauthorized deletion)
app.delete("/api/sessions/:id", (req, res) => {
  const { adminPassword } = req.body || {};
  const sess = sessions[req.params.id];
  if (!sess) return res.status(404).json({ error: "not found" });
  if (sess.adminPassword !== adminPassword) return res.status(403).json({ error: "invalid admin password" });
  delete sessions[req.params.id];
  io.emit("sessions_updated", sanitizeSessions());
  io.to(req.params.id).emit("session_closed");
  res.json({ ok: true });
});

// Verify admin password (used when joining as admin)
app.post("/api/verify-admin/:id", (req, res) => {
  const sess = sessions[req.params.id];
  if (!sess) return res.status(404).json({ error: "not found" });
  const { adminPassword } = req.body || {};
  if (sess.adminPassword !== adminPassword) return res.status(403).json({ error: "invalid admin password" });
  res.json({ ok: true, title: sess.title });
});

function sanitizeSessions() {
  return Object.values(sessions).map(s => ({
    id: s.id, title: s.title, maxPeople: s.maxPeople,
    createdAt: s.createdAt, isLive: s.isLive,
    participantCount: Object.values(s.participants).filter(p => p.online).length,
    adminCount: Object.values(s.participants).filter(p => p.online && p.isAdmin).length,
  }));
}

app.get("/", (req, res) => res.send("FutureTrack Meet Server is running ✅"));

// ── Socket.io ──────────────────────────────────────────
io.on("connection", (socket) => {
  let sid = null, pid = null, isAdmin = false;
  const ip = getSocketIp(socket);

  function getSession() { return sid ? sessions[sid] : null; }
  function broadcast(event, data) { if (sid) io.to(sid).emit(event, data); }
  function broadcastState() { const s = getSession(); if (s) broadcast("session_state", fullState(sid)); }

  // ── Admin joins with password ──
  socket.on("admin_join", ({ sessionId, adminPassword, name }) => {
    const sess = sessions[sessionId];
    if (!sess) return socket.emit("admin_join_error", "Session not found");
    if (sess.adminPassword !== adminPassword) return socket.emit("admin_join_error", "Invalid admin password");

    pid = uuidv4().slice(0, 8);
    sid = sessionId;
    isAdmin = true;

    sess.participants[pid] = {
      id: pid, name: name || "Host", micOn: true, camOn: true, online: true,
      handRaised: false, isScreenSharing: false,
      isAdmin: true, ip,
      joinedAt: Date.now(), socketId: socket.id,
    };
    socket.join(sid);
    socket.emit("admin_join_success", { pid, sessionId, title: sess.title });
    broadcastState();
  });

  // ── Regular participant join ──
  socket.on("join", ({ sessionId, name, password }) => {
    const sess = sessions[sessionId];
    if (!sess) return socket.emit("join_error", "Session not found");
    if (sess.password !== password) return socket.emit("join_error", "Wrong password");
    if (isBanned(sess, ip)) {
      const remaining = sess.bans[ip] - Date.now();
      return socket.emit("join_error", `You are banned from this session. Try again in ${msToHours(remaining)} hours.`);
    }
    const online = Object.values(sess.participants).filter(p => p.online).length;
    if (online >= sess.maxPeople) return socket.emit("join_error", "Room is full");

    pid = uuidv4().slice(0, 8);
    sid = sessionId;
    isAdmin = false;

    sess.participants[pid] = {
      id: pid, name, micOn: true, camOn: true, online: true,
      handRaised: false, isScreenSharing: false,
      isAdmin: false, ip,
      joinedAt: Date.now(), socketId: socket.id,
    };
    socket.join(sid);
    socket.emit("join_success", { pid, sessionId, title: sess.title, maxPeople: sess.maxPeople });
    broadcastState();
  });

  // ── Chat ──
  socket.on("chat_message", ({ text }) => {
    const sess = getSession();
    if (!sess || !pid) return;
    const p = sess.participants[pid];
    const sender = isAdmin ? `🛡️ ${p?.name || "Admin"}` : (p?.name || "?");
    const msg = { id: uuidv4().slice(0, 8), sender, text, ts: Date.now(), isAdmin };
    sess.chat.push(msg);
    if (sess.chat.length > 500) sess.chat.shift();
    broadcast("chat_message", msg);
  });

  // ── Camera control (admin controls others; anyone controls self) ──
  socket.on("toggle_cam", ({ targetPid }) => {
    const sess = getSession();
    if (!sess) return;
    if (!isAdmin && targetPid !== pid) return;
    const t = sess.participants[targetPid];
    if (!t) return;
    t.camOn = !t.camOn;
    broadcast("cam_update", { pid: targetPid, camOn: t.camOn });
    if (t.socketId) io.to(t.socketId).emit("your_cam", { camOn: t.camOn });
  });

  socket.on("cam_off_all", () => {
    if (!isAdmin) return;
    const sess = getSession();
    if (!sess) return;
    Object.values(sess.participants).forEach(p => {
      if (p.isAdmin) return;
      p.camOn = false;
      if (p.socketId) io.to(p.socketId).emit("your_cam", { camOn: false });
    });
    broadcastState();
  });

  socket.on("my_cam", ({ camOn }) => {
    const sess = getSession();
    if (!sess || !pid || !sess.participants[pid]) return;
    sess.participants[pid].camOn = camOn;
    broadcast("cam_update", { pid, camOn });
  });

  // ── Mic toggle (admin controls others; anyone controls self) ──
  socket.on("toggle_mic", ({ targetPid }) => {
    const sess = getSession();
    if (!sess) return;
    if (!isAdmin && targetPid !== pid) return;
    const t = sess.participants[targetPid];
    if (!t) return;
    t.micOn = !t.micOn;
    broadcast("mic_update", { pid: targetPid, micOn: t.micOn });
    if (t.socketId) io.to(t.socketId).emit("your_mic", { micOn: t.micOn });
  });

  socket.on("mute_all", () => {
    if (!isAdmin) return;
    const sess = getSession();
    if (!sess) return;
    Object.values(sess.participants).forEach(p => {
      if (p.isAdmin) return; // don't mute other admins
      p.micOn = false;
      if (p.socketId) io.to(p.socketId).emit("your_mic", { micOn: false });
    });
    broadcastState();
  });

  socket.on("unmute_all", () => {
    if (!isAdmin) return;
    const sess = getSession();
    if (!sess) return;
    Object.values(sess.participants).forEach(p => {
      p.micOn = true;
      if (p.socketId) io.to(p.socketId).emit("your_mic", { micOn: true });
    });
    broadcastState();
  });

  socket.on("my_mic", ({ micOn }) => {
    const sess = getSession();
    if (!sess || !pid || !sess.participants[pid]) return;
    sess.participants[pid].micOn = micOn;
    broadcast("mic_update", { pid, micOn });
  });

  // ── Hand raise ──
  socket.on("raise_hand", () => {
    const sess = getSession();
    if (!sess || !pid) return;
    const p = sess.participants[pid];
    if (!p) return;
    p.handRaised = !p.handRaised;
    if (p.handRaised) {
      if (!sess.handQueue.includes(pid)) sess.handQueue.push(pid);
    } else {
      sess.handQueue = sess.handQueue.filter(id => id !== pid);
    }
    broadcast("hand_update", { pid, handRaised: p.handRaised, handQueue: sess.handQueue });
  });

  socket.on("lower_hand", ({ targetPid }) => {
    if (!isAdmin) return;
    const sess = getSession();
    if (!sess) return;
    const p = sess.participants[targetPid];
    if (!p) return;
    p.handRaised = false;
    sess.handQueue = sess.handQueue.filter(id => id !== targetPid);
    broadcast("hand_update", { pid: targetPid, handRaised: false, handQueue: sess.handQueue });
    if (p.socketId) io.to(p.socketId).emit("hand_lowered_by_admin");
  });

  // ── Reactions ──
  socket.on("send_reaction", ({ emoji }) => {
    const sess = getSession();
    if (!sess) return;
    const p = sess.participants[pid];
    broadcast("reaction", { pid, name: p?.name || "?", emoji, ts: Date.now() });
  });

  // ── Screen share ──
  socket.on("screen_share_start", () => {
    const sess = getSession();
    if (!sess || !pid) return;
    sess.participants[pid].isScreenSharing = true;
    broadcast("screen_share_started", { pid, name: sess.participants[pid].name });
    broadcastState();
  });

  socket.on("screen_share_stop", () => {
    const sess = getSession();
    if (!sess || !pid) return;
    if (sess.participants[pid]) sess.participants[pid].isScreenSharing = false;
    broadcast("screen_share_stopped", { pid });
    broadcastState();
  });

  // WebRTC signaling
  socket.on("webrtc_offer", ({ targetPid, offer }) => {
    const sess = getSession(); if (!sess) return;
    const t = sess.participants[targetPid];
    if (t?.socketId) io.to(t.socketId).emit("webrtc_offer", { fromPid: pid, offer });
  });
  socket.on("webrtc_answer", ({ targetPid, answer }) => {
    const sess = getSession(); if (!sess) return;
    const t = sess.participants[targetPid];
    if (t?.socketId) io.to(t.socketId).emit("webrtc_answer", { fromPid: pid, answer });
  });
  socket.on("webrtc_ice", ({ targetPid, candidate }) => {
    const sess = getSession(); if (!sess) return;
    const t = sess.participants[targetPid];
    if (t?.socketId) io.to(t.socketId).emit("webrtc_ice", { fromPid: pid, candidate });
  });

  // ── Kick (soft — no ban) ──
  socket.on("kick", ({ targetPid }) => {
    if (!isAdmin) return;
    const sess = getSession();
    if (!sess || !sess.participants[targetPid]) return;
    const t = sess.participants[targetPid];
    if (t.isAdmin) return; // admins can't be kicked
    t.online = false;
    sess.handQueue = sess.handQueue.filter(id => id !== targetPid);
    if (t.socketId) io.to(t.socketId).emit("kicked", { banned: false });
    broadcastState();
  });

  // ── Ban (IP ban for 24h) ──
  socket.on("ban", ({ targetPid }) => {
    if (!isAdmin) return;
    const sess = getSession();
    if (!sess || !sess.participants[targetPid]) return;
    const t = sess.participants[targetPid];
    if (t.isAdmin) return; // can't ban admins
    const expireAt = Date.now() + BAN_DURATION_MS;
    if (t.ip) sess.bans[t.ip] = expireAt;
    t.online = false;
    sess.handQueue = sess.handQueue.filter(id => id !== targetPid);
    if (t.socketId) io.to(t.socketId).emit("kicked", { banned: true });
    broadcastState();
  });

  // ── Unban (admin only) ──
  socket.on("unban", ({ bannedIp }) => {
    if (!isAdmin) return;
    const sess = getSession();
    if (!sess) return;
    delete sess.bans[bannedIp];
    broadcast("bans_updated", { bans: sess.bans });
  });

  // ── End meeting (admin only, deletes session) ──
  socket.on("end_meeting", () => {
    if (!isAdmin) return;
    const sess = getSession();
    if (!sess) return;
    io.to(sid).emit("session_closed");
    delete sessions[sid];
    io.emit("sessions_updated", sanitizeSessions());
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    const sess = getSession();
    if (sess && pid && sess.participants[pid]) {
      sess.participants[pid].online = false;
      sess.participants[pid].isScreenSharing = false;
      sess.handQueue = sess.handQueue.filter(id => id !== pid);
      broadcast("peer_left", { pid });
      broadcastState();
    }
  });
});

function fullState(sessionId) {
  const sess = sessions[sessionId];
  if (!sess) return null;
  return {
    id: sess.id, title: sess.title, maxPeople: sess.maxPeople,
    createdAt: sess.createdAt, isLive: sess.isLive,
    handQueue: sess.handQueue,
    bans: sess.bans,
    participants: Object.values(sess.participants).filter(p => p.online).map(p => ({
      id: p.id, name: p.name, micOn: p.micOn, camOn: p.camOn !== false,
      handRaised: p.handRaised, isScreenSharing: p.isScreenSharing,
      isAdmin: p.isAdmin, joinedAt: p.joinedAt,
    })),
    chat: sess.chat,
  };
}

// Cleanup expired bans every hour
setInterval(() => {
  Object.values(sessions).forEach(s => {
    Object.keys(s.bans).forEach(ip => {
      if (Date.now() > s.bans[ip]) delete s.bans[ip];
    });
  });
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ FutureTrack Meet server on port ${PORT}`));
