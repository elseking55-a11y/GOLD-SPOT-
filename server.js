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
      mt5: { connected: false, login: "", broker: "", server: "", balance: null, equity: null, lastSeen: null, accountId: null, connectionStatus: "DISCONNECTED", setupStatus: "NOT_CONFIGURED", tradeAllowed: false, error: "" },
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
      u.mt5.tradeAllowed = info.tradeAllowed !== false && info.investorMode !== true;
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
      try {
        const deals = await c.connection.getDealsByTimeRange(new Date(Date.now()-7*24*60*60*1000), new Date());
        u.history = (Array.isArray(deals) ? deals : [])
          .filter(d => Number(d.profit || 0) !== 0 || String(d.entry || "").toUpperCase().includes("OUT"))
          .map(d => {
            const t = d.time ? new Date(d.time) : new Date();
            const side = String(d.type || "").toUpperCase().includes("SELL") ? "SELL" : "BUY";
            return {
              date:t.toISOString().slice(0,10),
              ticket:String(d.id || d.ticket || ""),
              symbol:String(d.symbol || ""),
              side,
              lot:Number(d.volume || 0),
              pnl:Number(d.profit || 0)+Number(d.swap || 0)+Number(d.commission || 0),
              closedAt:t.toISOString(),
              source:"MetaApi"
            };
          });
      } catch {}

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
    u.mt5.connectionStatus = "ERROR";
    u.mt5.error = "METAAPI_TOKEN is not configured on the server.";
    return;
  }

  try {
    const login = clean(data.login, 40);
    const server = clean(data.server, 100);
    const broker = clean(data.broker, 80);
    const password = String(data.password || "").trim();
    if (!login || !server || !password) {
      throw new Error("Enter the MT5 account number, master password and exact broker server name.");
    }

    u.mt5 = {
      ...u.mt5, broker, server, login, connected:false,
      connectionStatus:"CONNECTING", setupStatus:"CONNECTING", error:""
    };

    // MULTI-USER: never attach one user's login to another user's MetaApi account.
    // Reuse only the MetaApi account ID previously assigned to THIS application user.
    let account = null;
    if (u.mt5.accountId) {
      try {
        account = await metaApi.metatraderAccountApi.getAccount(String(u.mt5.accountId));
        if (String(account.login || "") !== login ||
            String(account.server || "").toLowerCase() !== server.toLowerCase()) {
          account = null;
        }
      } catch (_) {
        account = null;
      }
    }

    if (!account) {
      account = await metaApi.metatraderAccountApi.createAccount({
        name: "GOLD-SPOT user " + userId + " MT5",
        type: "cloud-g2",
        login,
        password,
        server,
        platform: "mt5",
        magic: 0,
        manualTrades: true,
        quoteStreamingIntervalInSeconds: 0,
        reliability: "high"
      });
    }

    // MetaApi deploys and runs the broker-side MT terminal in its cloud.
    // The user does NOT need MetaTrader/MT5 Terminal running on their phone or PC.
    await account.deploy();
    await account.waitConnected();

    const connection = account.getRPCConnection();
    await connection.connect();
    await connection.waitSynchronized();

    const info = await connection.getAccountInformation();
    const tradeAllowed = info.tradeAllowed !== false && info.investorMode !== true;

    metaConnections.set(userId, {
      account, connection, symbols:null, symbol:null, connectedAt:Date.now()
    });

    u.mt5 = {
      ...u.mt5,
      connected:true,
      connectionStatus:"CONNECTED",
      setupStatus:"READY",
      accountId:account.id,
      balance:Number(info.balance),
      equity:Number(info.equity),
      tradeAllowed,
      lastSeen:new Date().toISOString(),
      error:""
    };
  } catch (err) {
    const details = err?.details;
    const raw = String(err?.message || err || "MetaApi connection failed");
    let message = raw;

    if (raw.includes("E_AUTH") || /authenticate|invalid account|account disabled/i.test(raw)) {
      message = "MetaApi could not authenticate this MT5 account. Check the MT5 master password and the exact broker server name. No MT5 Terminal is required.";
    } else if (raw.includes("E_SRV_NOT_FOUND")) {
      message = "MetaApi could not find that broker server. Use the exact MT5 server name shown by your broker.";
    } else if (raw.includes("E_SERVER_TIMEZONE")) {
      message = "MetaApi could not detect this broker's server settings. A MetaApi provisioning profile is required for this broker.";
    } else if (raw.includes("E_RESOURCE_SLOTS")) {
      message = "MetaApi needs additional account resource capacity for this broker/account.";
    } else if (raw.includes("ERR_OTP_REQUIRED")) {
      message = "This MT5 account requires OTP. MetaApi cannot use an OTP-protected account; disable OTP or use an account without it.";
    } else if (/investor/i.test(raw)) {
      message = "The MT5 password is read-only/investor access. Use the master trading password for live execution.";
    }

    u.mt5.connected=false;
    u.mt5.connectionStatus="ERROR";
    u.mt5.setupStatus="ERROR";
    u.mt5.error=clean(message + (details && !String(message).includes(String(details)) ? " ["+String(details)+"]" : ""),500);
  }
}
app.post("/api/mt5/connect", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const u = userFor(s);
  const data = { broker: req.body.broker, server: req.body.server, login: req.body.login, password: req.body.password };
  u.mt5 = { ...u.mt5, broker: clean(data.broker,80), server: clean(data.server,100), login: clean(data.login,40), connected:false, connectionStatus:"CONNECTING", setupStatus:"CONNECTING", error:"" };
  connectMetaAccount(s.userId, data);
  res.json({ ok: true, mt5: u.mt5, message: "MT5 details received. MetaApi is managed by the server; you do not need a MetaApi account or token. Keep this page open while your MT5 account is connected." });
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
        const raw = await meta.account.getHistoricalCandles(symbol, "1m", undefined, 500);
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
      return res.json({ok:true,source:"MetaApi",live:true,symbol,price,candles,accountId:meta.account.id});
    } catch (err) {
      // Fall through to the public market feed for analysis.
    }
  }

  // No broker is required for Gold analysis. Use a real public XAU/USD feed.
  // When MT5 is connected above, broker quotes take precedence for trading-related analysis.
  try {
    const rr=await fetch("https://xaus.com/api/v1/intraday?symbol=xau&hours=24",{headers:{"Accept":"application/json","User-Agent":"GOLD-SPOT/1.0"}});
    if(!rr.ok) throw new Error("Public XAU/USD feed unavailable");
    const j=await rr.json();
    const points=Array.isArray(j.points)?j.points:[];
    const candles=points.map((p,i)=>({
      time:new Date(p.t||p.time).getTime(),
      open:Number(p.p??p.price),
      high:Number(p.p??p.price),
      low:Number(p.p??p.price),
      close:Number(p.p??p.price),
      volume:1
    })).filter(x=>Number.isFinite(x.time)&&Number.isFinite(x.close));
    if(!candles.length) throw new Error("No XAU/USD data returned");
    const last=candles.at(-1).close;
    return res.json({
      ok:true,source:"Public XAU/USD live feed",live:true,symbol:"XAUUSD",
      price:{bid:last,ask:last},candles,
      freshness:j.data_state||null,priceAsOf:j.price_as_of||j.updated_at||null
    });
  } catch (xausErr) {
    // Last fallback only: Yahoo's public chart endpoint. It is explicitly labelled as fallback data.
    try {
      const url="https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?range=1d&interval=1m&events=history";
      const rr=await fetch(url,{headers:{"User-Agent":"GOLD-SPOT/1.0","Accept":"application/json"}});
      if(!rr.ok) throw new Error("Gold market feed unavailable");
      const j=await rr.json(), result=j?.chart?.result?.[0];
      if(!result?.timestamp?.length) throw new Error("No XAUUSD fallback data returned");
      const q=result.indicators?.quote?.[0]||{};
      const candles=result.timestamp.map((t,i)=>({
        time:Number(t)*1000,open:Number(q.open?.[i]),high:Number(q.high?.[i]),
        low:Number(q.low?.[i]),close:Number(q.close?.[i]),volume:Number(q.volume?.[i]||0)
      })).filter(x=>Number.isFinite(x.close));
      const last=candles.at(-1)?.close;
      return res.json({ok:true,source:"Public XAU/USD fallback",live:false,symbol:"XAUUSD",price:{bid:last,ask:last},candles});
    } catch (err) {
      return res.status(502).json({ok:false,error:clean(err?.message||"Gold market data unavailable. Try again shortly.",300)});
    }
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
  return res.json({ok:true,source:"Public XAU/USD",symbols:[{symbol:"XAUUSD",name:"Gold / US Dollar"}]});
});

async function executeLiveOrder(user, side, symbol, signalId) {
  const meta = metaConnections.get(user.id);
  if (!meta?.connection || !user.mt5.connected) throw new Error("Your MT5 account is not connected.");
  if (!["BUY","SELL"].includes(side)) throw new Error("Only BUY or SELL orders can be executed.");
  if (!user.settings.autoTrade) throw new Error("Live auto-trading is OFF.");

  const stats = dailyStats(user);
  if (stats.trades >= user.settings.maxDailyTrades) throw new Error("Maximum daily trades reached.");
  if (stats.pnl <= -Math.abs(user.settings.maxDailyLoss)) throw new Error("Maximum daily loss reached.");
  if (getOpenCount(user) >= user.settings.maxOpenTrades) throw new Error("Maximum open trades reached.");
  if (side === "BUY" && !user.settings.allowBuy) throw new Error("BUY trading is disabled.");
  if (side === "SELL" && !user.settings.allowSell) throw new Error("SELL trading is disabled.");

  const positions = await meta.connection.getPositions();
  const sideCount = positions.filter(p => {
    const ps = String(p.type || "").toUpperCase().includes("SELL") ? "SELL" : "BUY";
    return ps === side && String(p.symbol || "") === symbol;
  }).length;
  if (side === "BUY" && sideCount >= user.settings.maxBuyTrades) throw new Error("Maximum BUY trades reached.");
  if (side === "SELL" && sideCount >= user.settings.maxSellTrades) throw new Error("Maximum SELL trades reached.");

  const quote = await meta.connection.getSymbolPrice(symbol);
  const price = side === "BUY" ? Number(quote.ask) : Number(quote.bid);
  if (!Number.isFinite(price) || price <= 0) throw new Error("No valid broker price for "+symbol+".");

  const spec = await meta.connection.getSymbolSpecification(symbol);
  const point = Number(spec?.point || 0.01);
  const slDistance = Math.max(0, Number(user.settings.stopLossPoints || 0)) * point;
  const tpDistance = Math.max(0, Number(user.settings.takeProfitPoints || 0)) * point;
  const sl = user.settings.stopLoss ? (side === "BUY" ? price - slDistance : price + slDistance) : undefined;
  const tp = user.settings.takeProfit ? (side === "BUY" ? price + tpDistance : price - tpDistance) : undefined;
  const clientId = "GOLDSPOT_"+crypto.randomBytes(8).toString("hex");

  const result = side === "BUY"
    ? await meta.connection.createMarketBuyOrder(symbol, Number(user.settings.lotSize), sl, tp, {comment:"GOLD SPOT AUTO", clientId})
    : await meta.connection.createMarketSellOrder(symbol, Number(user.settings.lotSize), sl, tp, {comment:"GOLD SPOT AUTO", clientId});

  if (!result) throw new Error("Broker returned no trade result.");
  user.lastExecution = {side,symbol,price,lot:Number(user.settings.lotSize),at:new Date().toISOString(),signalId:clean(signalId,80),result:result.stringCode||"EXECUTED"};
  return {result,price,lot:Number(user.settings.lotSize)};
}

app.post("/api/bot/start", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ ok:false, error:"Unauthorized" });
  const u = userFor(s);
  if (!u.mt5.connected) return res.status(409).json({ok:false,error:"Your MT5 account is not connected yet. Enter your MT5 login, server and master password first."});
  u.settings.autoTrade = true;
  res.json({ok:true,autoTrade:true,mode:"LIVE_METAAPI"});
});

app.post("/api/bot/stop", (req, res) => {
  const s = auth(req);
  if (!s) return res.status(401).json({ok:false,error:"Unauthorized"});
  const u = userFor(s);
  u.settings.autoTrade = false;
  res.json({ok:true,autoTrade:false,mode:"OFF"});
});

app.post("/api/signal", async (req, res) => {
  const session = auth(req);
  if (!session) return res.status(401).json({ok:false,error:"Unauthorized"});
  const u = userFor(session);
  const side = clean(req.body.side,8).toUpperCase();
  const strength = clean(req.body.strength,16).toUpperCase();
  const symbol = clean(req.body.symbol || u.settings.symbol || "XAUUSD",50);
  const price = Number(req.body.price);
  const signalId = clean(req.body.signalId || "",80);
  if (!["BUY","SELL","WAIT"].includes(side)) return res.status(400).json({ok:false,error:"Invalid signal"});
  u.lastSignal={side,strength,price:Number.isFinite(price)?price:null,at:new Date().toISOString(),symbol};
  if (side==="WAIT" || strength!=="STRONG") return res.json({ok:true,action:"MONITORING",executed:false,side,strength});
  if (!u.settings.autoTrade) return res.json({ok:true,action:"READY",executed:false,reason:"Live auto-trading is OFF.",side,strength});
  if (signalId && u.lastSignalId===signalId) return res.json({ok:true,action:"DUPLICATE",executed:false,side,strength});
  try {
    const execution=await executeLiveOrder(u,side,symbol,signalId);
    u.lastSignalId=signalId || crypto.randomBytes(8).toString("hex");
    return res.json({ok:true,action:"EXECUTED",executed:true,side,strength,symbol,execution:{price:execution.price,lot:execution.lot,result:execution.result?.stringCode||"EXECUTED"}});
  } catch(err) {
    return res.status(409).json({ok:false,action:"BLOCKED",executed:false,error:clean(err?.message||"Live order failed",300),side,strength});
  }
});

app.post("/api/trade/market", async (req, res) => {
  const s=auth(req);
  if(!s) return res.status(401).json({ok:false,error:"Unauthorized"});
  const u=userFor(s);
  if(!u.mt5.connected) return res.status(409).json({ok:false,error:"MT5 is not connected through MetaApi."});
  const wasAuto=u.settings.autoTrade;
  u.settings.autoTrade=true;
  try {
    const side=clean(req.body.side,8).toUpperCase();
    const symbol=clean(req.body.symbol || u.settings.symbol || "XAUUSD",50);
    const execution=await executeLiveOrder(u,side,symbol,"MANUAL_"+Date.now());
    return res.json({ok:true,executed:true,side,symbol,execution:{price:execution.price,lot:execution.lot,result:execution.result?.stringCode||"EXECUTED"}});
  } catch(err) {
    return res.status(409).json({ok:false,error:clean(err?.message||"Manual live order failed",300)});
  } finally { u.settings.autoTrade=wasAuto; }
});

app.get("/api/mt5/command", (req, res) => {
  const key = clean(req.query.key, 160);
  if (!ACCESS_KEYS.has(key)) return res.status(401).send("ERROR|INVALID_KEY");
  const userId = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  const u = users.get(userId);
  if (!u) return res.status(404).send("ERROR|USER_NOT_FOUND");
  // Legacy polling cannot establish a broker connection; MetaApi is authoritative.
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
