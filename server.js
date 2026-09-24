const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const ACCESS_KEYS = new Set(
  String(process.env.ACCESS_KEYS || "GOLD-START-001")
    .split(",").map(v => v.trim()).filter(Boolean)
);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 24) * 60 * 60 * 1000;
const sessions = new Map();
const users = new Map();
const commands = new Map();

app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Access-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, "public")));

function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}
function token() {
  return crypto.randomBytes(32).toString("hex");
}
function auth(req) {
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const key = clean(req.headers["x-access-key"] || req.query.key, 160);
  const t = bearer || key;
  const session = sessions.get(t);
  if (!session || session.expiresAt < Date.now()) {
    if (session) sessions.delete(t);
    return null;
  }
  session.lastSeen = Date.now();
  return session;
}
function userFor(session) {
  return users.get(session.userId);
}
function defaultSettings() {
  return {
    autoTrade: false,
    symbol: "XAUUSD",
    lotSize: 0.01,
    maxOpenTrades: 2,
    maxBuyTrades: 1,
    maxSellTrades: 1,
    stopLoss: true,
    stopLossPoints: 300,
    takeProfit: true,
    takeProfitPoints: 600,
    maxDailyLoss: 5,
    maxDailyTrades: 10,
    maxSpreadPoints: 50,
    allowBuy: true,
    allowSell: true,
    oneTradePerSignal: true,
    closeOnOppositeSignal: true,
    martingale: false,
    unlimitedRecovery: false,
    timeframe: 300
  };
}
function normalizeSettings(input) {
  const d = defaultSettings();
  const out = { ...d };
  for (const k of Object.keys(d)) {
    if (typeof d[k] === "boolean") out[k] = input[k] === true;
    else if (typeof d[k] === "number" && Number.isFinite(Number(input[k]))) out[k] = Number(input[k]);
    else if (typeof d[k] === "string" && input[k] != null) out[k] = clean(input[k], 30);
  }
  out.lotSize = Math.max(0.01, Math.min(out.lotSize, 100));
  out.maxOpenTrades = Math.max(1, Math.min(Math.floor(out.maxOpenTrades), 20));
  out.maxBuyTrades = Math.max(0, Math.min(Math.floor(out.maxBuyTrades), out.maxOpenTrades));
  out.maxSellTrades = Math.max(0, Math.min(Math.floor(out.maxSellTrades), out.maxOpenTrades));
  out.maxDailyTrades = Math.max(1, Math.min(Math.floor(out.maxDailyTrades), 100));
  out.maxDailyLoss = Math.max(0, out.maxDailyLoss);
  return out;
}
function getOpenCount(user, side) {
  return user.positions.filter(p => p.status === "OPEN" && (!side || p.side === side)).length;
}
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function dailyStats(user) {
  const today = todayKey();
  const trades = user.history.filter(x => x.date === today);
  const pnl = trades.reduce((a, x) => a + Number(x.pnl || 0), 0);
  return { trades: trades.length, pnl };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "GOLD SPOT ANALYSIS", time: new Date().toISOString() });
});

app.post("/api/access", (req, res) => {
  const key = clean(req.body.key, 160);
  if (!key || !ACCESS_KEYS.has(key)) return res.status(401).json({ ok: false, error: "Invalid access key" });
  let userId = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (!users.has(userId)) {
    users.set(userId, {
      id: userId,
      name: "Gold User",
      settings: defaultSettings(),
      positions: [],
      history: [],
      mt5: { connected: false, login: "", broker: "", server: "", balance: null, equity: null, lastSeen: null },
      lastSignal: { side: "WAIT", strength: "NONE", price: null, at: null },
      lastSignalId: null
    });
  }
  const t = token();
  sessions.set(t, { userId, expiresAt: Date.now() + SESSION_TTL_MS, lastSeen: Date.now() });
  res.json({ ok: true, token: t, user: users.get(userId) });
});

app.get("/api/me", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Session expired" });
  res.json({ ok: true, user: userFor(s) });
});

app.post("/api/settings", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const u = userFor(s);
  u.settings = normalizeSettings(req.body || {});
  res.json({ ok: true, settings: u.settings });
});

app.post("/api/mt5/connect", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const u = userFor(s);
  u.mt5 = {
    ...u.mt5,
    broker: clean(req.body.broker, 80),
    server: clean(req.body.server, 100),
    login: clean(req.body.login, 40),
    connected: false
  };
  res.json({ ok: true, mt5: u.mt5, message: "Install the EA and use this access key to complete the MT5 connection." });
});

app.post("/api/bot/start", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const u = userFor(s);
  u.settings.autoTrade = true;
  res.json({ ok: true, autoTrade: true });
});

app.post("/api/bot/stop", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const u = userFor(s);
  u.settings.autoTrade = false;
  res.json({ ok: true, autoTrade: false });
});

app.post("/api/signal", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const u = userFor(s);
  const side = clean(req.body.side, 8).toUpperCase();
  const strength = clean(req.body.strength, 16).toUpperCase();
  const price = Number(req.body.price);
  const signalId = clean(req.body.signalId, 80);
  if (!["BUY", "SELL", "WAIT"].includes(side)) return res.status(400).json({ ok: false, error: "Invalid signal" });

  u.lastSignal = { side, strength, price: Number.isFinite(price) ? price : null, at: new Date().toISOString() };
  if (!u.settings.autoTrade || side === "WAIT" || strength !== "STRONG") {
    return res.json({ ok: true, action: "WAIT", reason: "Auto trade is off or signal is not strongly confirmed." });
  }
  if (!u.mt5.connected) return res.json({ ok: true, action: "WAIT", reason: "MT5 is not connected." });

  const stats = dailyStats(u);
  if (stats.trades >= u.settings.maxDailyTrades) return res.json({ ok: true, action: "BLOCKED", reason: "Maximum daily trades reached." });
  if (stats.pnl <= -Math.abs(u.settings.maxDailyLoss)) return res.json({ ok: true, action: "BLOCKED", reason: "Maximum daily loss reached." });
  if (side === "BUY" && !u.settings.allowBuy) return res.json({ ok: true, action: "BLOCKED", reason: "BUY disabled." });
  if (side === "SELL" && !u.settings.allowSell) return res.json({ ok: true, action: "BLOCKED", reason: "SELL disabled." });

  const opposite = side === "BUY" ? "SELL" : "BUY";
  const oppositePositions = u.positions.filter(p => p.status === "OPEN" && p.side === opposite);
  if (u.settings.closeOnOppositeSignal && oppositePositions.length) {
    for (const p of oppositePositions) {
      commands.set(u.id, { type: "CLOSE_TICKET", ticket: p.ticket, reason: "Opposite confirmed signal" });
    }
    return res.json({ ok: true, action: "CLOSE_OPPOSITE", count: oppositePositions.length });
  }

  if (getOpenCount(u) >= u.settings.maxOpenTrades) return res.json({ ok: true, action: "BLOCKED", reason: "Maximum open trades reached." });
  if (getOpenCount(u, side) >= (side === "BUY" ? u.settings.maxBuyTrades : u.settings.maxSellTrades)) {
    return res.json({ ok: true, action: "BLOCKED", reason: "Maximum side trades reached." });
  }
  if (u.settings.oneTradePerSignal && u.lastSignalId === signalId) {
    return res.json({ ok: true, action: "BLOCKED", reason: "Signal already processed." });
  }

  u.lastSignalId = signalId;
  commands.set(u.id, {
    type: "OPEN",
    side,
    lot: u.settings.lotSize,
    slPoints: u.settings.stopLoss ? u.settings.stopLossPoints : 0,
    tpPoints: u.settings.takeProfit ? u.settings.takeProfitPoints : 0,
    symbol: u.settings.symbol,
    signalId
  });
  res.json({ ok: true, action: "OPEN_QUEUED", side, lot: u.settings.lotSize });
});

app.get("/api/mt5/command", (req, res) => {
  const key = clean(req.query.key, 160);
  if (!ACCESS_KEYS.has(key)) return res.status(401).send("ERROR|INVALID_KEY");
  const userId = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  const u = users.get(userId);
  if (!u) return res.status(404).send("ERROR|USER_NOT_FOUND");
  u.mt5.connected = true;
  u.mt5.lastSeen = new Date().toISOString();
  if (req.query.login) u.mt5.login = clean(req.query.login, 40);
  if (req.query.broker) u.mt5.broker = clean(req.query.broker, 80);
  if (req.query.balance) u.mt5.balance = Number(req.query.balance);
  if (req.query.equity) u.mt5.equity = Number(req.query.equity);

  const c = commands.get(userId);
  if (!c) return res.send("NOOP");
  commands.delete(userId);
  if (c.type === "OPEN") return res.send(["OPEN", c.side, c.lot, c.slPoints, c.tpPoints, c.symbol, c.signalId].join("|"));
  if (c.type === "CLOSE_TICKET") return res.send(["CLOSE", c.ticket, c.reason].join("|"));
  res.send("NOOP");
});

app.post("/api/mt5/event", (req, res) => {
  const key = clean(req.body.key, 160);
  if (!ACCESS_KEYS.has(key)) return res.status(401).json({ ok: false, error: "Invalid key" });
  const userId = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  const u = users.get(userId);
  if (!u) return res.status(404).json({ ok: false, error: "User not found" });
  const type = clean(req.body.type, 30);
  const ticket = clean(req.body.ticket, 40);
  const side = clean(req.body.side, 8).toUpperCase();
  const pnl = Number(req.body.pnl || 0);
  if (type === "OPEN") {
    u.positions = u.positions.filter(p => p.ticket !== ticket);
    u.positions.push({ ticket, side, symbol: clean(req.body.symbol, 30), lot: Number(req.body.lot || 0), entry: Number(req.body.price || 0), status: "OPEN", openedAt: new Date().toISOString(), pnl: 0 });
  }
  if (type === "UPDATE") {
    const p = u.positions.find(x => x.ticket === ticket);
    if (p) p.pnl = pnl;
  }
  if (type === "CLOSE") {
    const p = u.positions.find(x => x.ticket === ticket);
    if (p) {
      p.status = "CLOSED";
      p.closedAt = new Date().toISOString();
      p.pnl = pnl;
      u.history.unshift({ date: todayKey(), ticket, symbol: p.symbol, side: p.side, lot: p.lot, pnl, closedAt: p.closedAt });
    }
    u.positions = u.positions.filter(x => x.ticket !== ticket);
  }
  res.json({ ok: true });
});

app.get("/api/state", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const u = userFor(s);
  res.json({ ok: true, user: u, daily: dailyStats(u), commandPending: commands.has(u.id) });
});

app.use((_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log("GOLD SPOT ANALYSIS running on port " + PORT));
