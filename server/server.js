const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const allowedOrigins = [
  "https://meet.futuretrackconsultancy.com",
  "http://meet.futuretrackconsultancy.com",
  "*"
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

// ── Session store ─────────────────────────────────────
const sessions = {};

// ── REST API ──────────────────────────────────────────
app.post("/api/sessions", (req, res) => {
  const { title, password, maxPeople } = req.body;
  if (!title || !password) return res.status(400).json({ error: "title and password required" });
  const id = uuidv4().slice(0, 8);
  sessions[id] = {
    id, title, password,
    maxPeople: maxPeople || 200,
    createdAt: Date.now(),
    isLive: true,
    participants: {},
    chat: [],
    handQueue: [],    // ordered list of pids with hand raised
  };
  io.emit("sessions_updated", sanitizeSessions());
  res.json({ id, title, maxPeople: sessions[id].maxPeople });
});

app.get("/api/sessions", (req, res) => res.json(sanitizeSessions()));

app.delete("/api/sessions/:id", (req, res) => {
  if (!sessions[req.params.id]) return res.status(404).json({ error: "not found" });
  delete sessions[req.params.id];
  io.emit("sessions_updated", sanitizeSessions());
  io.to(req.params.id).emit("session_closed");
  res.json({ ok: true });
});

function sanitizeSessions() {
  return Object.values(sessions).map(s => ({
    id: s.id, title: s.title, maxPeople: s.maxPeople,
    createdAt: s.createdAt, isLive: s.isLive,
    participantCount: Object.values(s.participants).filter(p => p.online).length
  }));
}

// Serve React build
app.use(express.static(path.join(__dirname, "../client/build")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../client/build/index.html")));

// ── Socket.io ─────────────────────────────────────────
io.on("connection", (socket) => {
  let sid = null, pid = null, isAdmin = false;

  function getSession() { return sid ? sessions[sid] : null; }
  function broadcast(event, data) { if (sid) io.to(sid).emit(event, data); }
  function broadcastState() { const s = getSession(); if (s) broadcast("session_state", fullState(sid)); }

  // ── Admin join ──
  socket.on("admin_join", ({ sessionId }) => {
    const sess = sessions[sessionId];
    if (!sess) return socket.emit("error_msg", "Session not found");
    sid = sessionId;
    isAdmin = true;
    socket.join(sid);
    socket.emit("session_state", fullState(sid));
  });

  // ── Participant join ──
  socket.on("join", ({ sessionId, name, password }) => {
    const sess = sessions[sessionId];
    if (!sess) return socket.emit("join_error", "Session not found");
    if (sess.password !== password) return socket.emit("join_error", "Wrong password");
    const online = Object.values(sess.participants).filter(p => p.online).length;
    if (online >= sess.maxPeople) return socket.emit("join_error", "Room is full");

    pid = uuidv4().slice(0, 8);
    sid = sessionId;
    isAdmin = false;

    sess.participants[pid] = {
      id: pid, name, micOn: true, online: true,
      handRaised: false, reaction: null, reactionTs: 0,
      isScreenSharing: false,
      joinedAt: Date.now(), socketId: socket.id
    };
    socket.join(sid);
    socket.emit("join_success", { pid, sessionId, title: sess.title, maxPeople: sess.maxPeople });
    broadcastState();
  });

  // ── Chat ──
  socket.on("chat_message", ({ text }) => {
    const sess = getSession();
    if (!sess) return;
    const sender = isAdmin ? "🎛️ Host" : (sess.participants[pid]?.name || "?");
    const msg = { id: uuidv4().slice(0,8), sender, text, ts: Date.now() };
    sess.chat.push(msg);
    if (sess.chat.length > 500) sess.chat.shift();
    broadcast("chat_message", msg);
  });

  // ── Mic controls ──
  socket.on("toggle_mic", ({ targetPid }) => {
    const sess = getSession();
    if (!sess) return;
    const targetIsMe = targetPid === pid && !isAdmin;
    if (!isAdmin && !targetIsMe) return;
    const p = sess.participants[targetPid];
    if (!p) return;
    p.micOn = !p.micOn;
    broadcast("mic_update", { pid: targetPid, micOn: p.micOn });
    if (p.socketId) io.to(p.socketId).emit("your_mic", { micOn: p.micOn });
  });

  socket.on("mute_all", () => {
    if (!isAdmin) return;
    const sess = getSession();
    if (!sess) return;
    Object.values(sess.participants).forEach(p => {
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

  // Admin: lower someone's hand
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
    const name = isAdmin ? "Host" : (sess.participants[pid]?.name || "?");
    broadcast("reaction", { pid: pid || "admin", name, emoji, ts: Date.now() });
  });

  // ── Screen share signaling (WebRTC) ──
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

  // WebRTC signaling relay
  socket.on("webrtc_offer", ({ targetPid, offer }) => {
    const sess = getSession();
    if (!sess) return;
    const target = sess.participants[targetPid];
    if (target?.socketId) io.to(target.socketId).emit("webrtc_offer", { fromPid: pid, offer });
  });

  socket.on("webrtc_answer", ({ targetPid, answer }) => {
    const sess = getSession();
    if (!sess) return;
    const target = sess.participants[targetPid];
    if (target?.socketId) io.to(target.socketId).emit("webrtc_answer", { fromPid: pid, answer });
  });

  socket.on("webrtc_ice", ({ targetPid, candidate }) => {
    const sess = getSession();
    if (!sess) return;
    const target = sess.participants[targetPid];
    if (target?.socketId) io.to(target.socketId).emit("webrtc_ice", { fromPid: pid, candidate });
  });

  // ── Kick ──
  socket.on("kick", ({ targetPid }) => {
    if (!isAdmin) return;
    const sess = getSession();
    if (!sess || !sess.participants[targetPid]) return;
    const target = sess.participants[targetPid];
    target.online = false;
    sess.handQueue = sess.handQueue.filter(id => id !== targetPid);
    if (target.socketId) io.to(target.socketId).emit("kicked");
    broadcastState();
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    const sess = getSession();
    if (sess && pid && sess.participants[pid]) {
      sess.participants[pid].online = false;
      sess.participants[pid].isScreenSharing = false;
      sess.handQueue = sess.handQueue.filter(id => id !== pid);
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
    participants: Object.values(sess.participants).filter(p => p.online).map(p => ({
      id: p.id, name: p.name, micOn: p.micOn,
      handRaised: p.handRaised, isScreenSharing: p.isScreenSharing,
      joinedAt: p.joinedAt
    })),
    chat: sess.chat
  };
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`✅ Conference server on port ${PORT}`));
