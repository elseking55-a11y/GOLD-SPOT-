const express = require("express");
const crypto = require("crypto");
const path = require("path");
const MetaApi = require("metaapi.cloud-sdk").default;

const METAAPI_TOKEN = String(process.env.METAAPI_TOKEN || "").trim();
const metaApi = METAAPI_TOKEN ? new MetaApi(METAAPI_TOKEN) : null;
const metaConnections = new Map();

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
      mt5: { connected: false, login: "", broker: "", server: "", balance: null, equity: null, lastSeen: null, accountId: null, connectionStatus: "DISCONNECTED", setupStatus: "NOT_CONFIGURED", error: "" },
      lastSignal: { side: "WAIT", strength: "NONE", price: null, at: null },
      lastSignalId: null
    });
  }
  const t = token();
  sessions.set(t, { userId, expiresAt: Date.now() + SESSION_TTL_MS, lastSeen: Date.now() });
  res.json({ ok: true, token: t, user: users.get(userId) });
});

app.get("/api/me", async (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Session expired" });
  const u = userFor(s);
  const c = metaConnections.get(s.userId);
  if (c?.connection && u.mt5.connected) {
    try {
      const [info, positions] = await Promise.all([
        c.connection.getAccountInformation(),
        c.connection.getPositions()
      ]);
      u.mt5.balance = Number(info.balance);
      u.mt5.equity = Number(info.equity);
      u.mt5.lastSeen = new Date().toISOString();
      u.positions = Array.isArray(positions) ? positions.map(p => ({
        ticket: String(p.id || p.ticket || ""),
        symbol: p.symbol,
        side: String(p.type || "").toUpperCase().includes("SELL") ? "SELL" : "BUY",
        lot: Number(p.volume || 0),
        entry: Number(p.openPrice || 0),
        pnl: Number(p.profit || 0),
        status: "OPEN",
        openedAt: p.time ? new Date(p.time).toISOString() : null
      })) : [];
    } catch (err) {
      u.mt5.lastSeen = new Date().toISOString();
      u.mt5.error = clean(err?.message || "MetaApi account refresh failed", 300);
    }
  }
  res.json({ ok: true, user: u });
});

app.post("/api/settings", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const u = userFor(s);
  u.settings = normalizeSettings(req.body || {});
  if (!u.mt5.connected) u.settings.autoTrade = false;
  res.json({ ok: true, settings: u.settings });
});

async function connectMetaAccount(userId, data) {
  const u = users.get(userId);
  if (!u) return;
  if (!metaApi) {
    u.mt5.setupStatus = "ERROR";
    u.mt5.error = "METAAPI_TOKEN is not configured on the server.";
    return;
  }
  try {
    const login = clean(data.login, 40);
    const server = clean(data.server, 100);
    const broker = clean(data.broker, 80);
    const password = String(data.password || "").trim();
    if (!login || !server || !password) throw new Error("MT5 login, password and server are required.");
    u.mt5 = { ...u.mt5, broker, server, login, connected: false, connectionStatus: "CONNECTING", setupStatus: "CONNECTING", error: "" };

    const accounts = await metaApi.metatraderAccountApi.getAccountsWithInfiniteScrollPagination();
    let account = accounts.find(a => String(a.login) === login && String(a.server || "").toLowerCase() === server.toLowerCase() && String(a.type || "").startsWith("cloud"));
    if (!account) {
      account = await metaApi.metatraderAccountApi.createAccount({
        name: "Gold Spot " + login,
        type: "cloud-g2",
        login,
        password,
        server,
        platform: "mt5",
        magic: 0,
        manualTrades: true,
        quoteStreamingIntervalInSeconds: 0
      });
    }
    await account.deploy();
    await account.waitConnected();

    const connection = account.getRPCConnection();
    await connection.connect();
    await connection.waitSynchronized();

    const info = await connection.getAccountInformation();
    metaConnections.set(userId, { account, connection, symbols: null, symbol: null, connectedAt: Date.now() });

    u.mt5 = {
      ...u.mt5,
      connected: true,
      connectionStatus: "CONNECTED",
      setupStatus: "READY",
      accountId: account.id,
      balance: Number(info.balance),
      equity: Number(info.equity),
      lastSeen: new Date().toISOString(),
      error: ""
    };
  } catch (err) {
    u.mt5.connected = false;
    u.mt5.connectionStatus = "ERROR";
    u.mt5.setupStatus = "ERROR";
    u.mt5.error = clean(err?.message || err?.details || "MetaApi connection failed", 300);
  }
}

app.post("/api/mt5/connect", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const u = userFor(s);
  const data = { broker: req.body.broker, server: req.body.server, login: req.body.login, password: req.body.password };
  u.mt5 = { ...u.mt5, broker: clean(data.broker,80), server: clean(data.server,100), login: clean(data.login,40), connected:false, connectionStatus:"CONNECTING", setupStatus:"CONNECTING", error:"" };
  connectMetaAccount(s.userId, data);
  res.json({ ok: true, mt5: u.mt5, message: "MetaApi is connecting your MT5 account. Keep this page open and refresh status." });
});

app.get("/api/mt5/status", async (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const u = userFor(s);
  const c = metaConnections.get(s.userId);
  if (c?.connection) {
    try {
      const info = await c.connection.getAccountInformation();
      u.mt5.balance = Number(info.balance);
      u.mt5.equity = Number(info.equity);
      u.mt5.connected = true;
      u.mt5.connectionStatus = "CONNECTED";
      u.mt5.setupStatus = "READY";
      u.mt5.lastSeen = new Date().toISOString();
    } catch {}
  }
  res.json({ ok:true, mt5:u.mt5 });
});

app.get("/api/market/data", async (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ok:false,error:"Unauthorized"});

  const symbol = clean(req.query.symbol || "XAUUSD", 50);
  const timeframe = Math.max(1, Number(req.query.timeframe || 300));
  const meta = metaConnections.get(s.userId);

  // MT5/MetaApi is optional for market analysis. Use the broker feed when connected.
  if (meta?.connection && userFor(s).mt5.connected) {
    try {
      const price = await meta.connection.getSymbolPrice(symbol);
      let candles = [];
      try {
        const raw = await meta.account.getHistoricalCandles(symbol, "1m");
        if (Array.isArray(raw)) candles = raw.slice(-500).map(x => ({
          time:new Date(x.time).getTime(), open:Number(x.open), high:Number(x.high),
          low:Number(x.low), close:Number(x.close), volume:Number(x.volume||0)
        }));
      } catch {}
      if (candles.length < 20) {
        const ticks = await meta.account.getHistoricalTicks(symbol, new Date(Date.now()-24*60*60*1000), 0);
        const buckets = new Map();
        for (const t of (ticks || [])) {
          const bid=Number(t.bid), ask=Number(t.ask);
          const p=Number.isFinite(bid)&&Number.isFinite(ask)?(bid+ask)/2:Number.isFinite(bid)?bid:ask;
          const time=new Date(t.time).getTime();
          if (!Number.isFinite(p)||!Number.isFinite(time)) continue;
          const key=Math.floor(time/60000)*60000, old=buckets.get(key);
          if (!old) buckets.set(key,{time:key,open:p,high:p,low:p,close:p,volume:1});
          else {old.high=Math.max(old.high,p);old.low=Math.min(old.low,p);old.close=p;old.volume++}
        }
        candles=[...buckets.values()].sort((a,b)=>a.time-b.time).slice(-500);
      }
      return res.json({ok:true,source:"MetaApi",symbol,price,candles,accountId:meta.account.id});
    } catch (err) {
      // Fall through to the public market feed for analysis.
    }
  }

  // No broker is required for analysis. XAUUSD is read from Yahoo Finance's
  // public market chart feed; this feed may be delayed and is not a broker quote.
  const yahooSymbol = "XAUUSD=X";
  const period2=Math.floor(Date.now()/1000);
  const period1=period2-7*24*60*60;
  try {
    const url="https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(yahooSymbol)+
      "?period1="+period1+"&period2="+period2+"&interval=1m&events=history";
    const rr=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0"}});
    if (!rr.ok) throw new Error("Public gold market feed unavailable");
    const j=await rr.json(), result=j?.chart?.result?.[0];
    if (!result?.timestamp?.length) throw new Error("No XAUUSD market data returned");
    const q=result.indicators?.quote?.[0]||{};
    const candles=result.timestamp.map((t,i)=>({
      time:Number(t)*1000, open:Number(q.open?.[i]), high:Number(q.high?.[i]),
      low:Number(q.low?.[i]), close:Number(q.close?.[i]), volume:Number(q.volume?.[i]||0)
    })).filter(x=>Number.isFinite(x.close));
    const last=candles.at(-1)?.close;
    return res.json({ok:true,source:"Yahoo Finance",symbol:"XAUUSD",price:{bid:last,ask:last},candles});
  } catch (err) {
    return res.status(502).json({ok:false,error:clean(err?.message||"Gold market data unavailable",300)});
  }
});

app.get("/api/market/symbols", async (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ok:false,error:"Unauthorized"});
  const meta = metaConnections.get(s.userId);
  if (meta?.connection && userFor(s).mt5.connected) {
    try {
      const symbols = await meta.connection.getSymbols();
      const specs = Array.isArray(symbols) ? symbols : [];
      return res.json({ok:true,source:"MetaApi",symbols:specs});
    } catch {}
  }
  return res.json({ok:true,source:"Public market feed",symbols:[{symbol:"XAUUSD",name:"Gold / US Dollar"}]});
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
  const session = auth(req);
  if (!session) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const u = userFor(session);
  const side = clean(req.body.side, 8).toUpperCase();
  const strength = clean(req.body.strength, 16).toUpperCase();
  const price = Number(req.body.price);
  const signalId = clean(req.body.signalId, 80);
  if (!["BUY", "SELL", "WAIT"].includes(side)) return res.status(400).json({ ok: false, error: "Invalid signal" });

  u.lastSignal = { side, strength, price: Number.isFinite(price) ? price : null, at: new Date().toISOString() };
  const stats = dailyStats(u);
  const checks = {
    monitorEnabled: u.settings.autoTrade,
    mt5Connected: u.mt5.connected,
    strongSignal: strength === "STRONG",
    dailyTradeLimit: stats.trades < u.settings.maxDailyTrades,
    dailyLossLimit: stats.pnl > -Math.abs(u.settings.maxDailyLoss),
    sideAllowed: side === "BUY" ? u.settings.allowBuy : side === "SELL" ? u.settings.allowSell : true,
    openLimit: getOpenCount(u) < u.settings.maxOpenTrades
  };
  const ready = side !== "WAIT" && Object.values(checks).every(Boolean);
  res.json({
    ok: true,
    action: ready ? "READY_FOR_CONFIRMATION" : "MONITORING",
    reason: ready ? "Risk checks passed. User confirmation is required before live execution." : "Signal is being monitored or one or more risk checks are not satisfied.",
    checks, side, strength, price: Number.isFinite(price) ? price : null, signalId
  });
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
