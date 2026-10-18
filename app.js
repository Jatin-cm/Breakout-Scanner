/* Browser-only Binance Futures signal scanner.
   Keep this page open for scanning. Do not add Telegram bot tokens here. */
"use strict";

const BINANCE_KLINES = "https://fapi.binance.com/fapi/v1/klines";
const SCAN_INTERVAL_MS = 60_000;
const MAX_SYMBOLS_PER_LIST = 15;

let running = false;
let scanTimer = null;
let scanInProgress = false;
let lastScanAt = null;
let signalCount = 0;
let latestSignalText = "";
const lastHourTimestamp = Object.create(null);
const fastHighSent = Object.create(null);
const fastLowSent = Object.create(null);
const weeklyTimestamp = Object.create(null);
const weeklyHighSent = Object.create(null);
const weeklyLowSent = Object.create(null);

const $ = (id) => document.getElementById(id);
const logsEl = $("logs");
const signalsEl = $("signals");

function log(message) {
  const line = `[${new Date().toLocaleString()}] ${message}`;
  logsEl.textContent = (line + "\n" + logsEl.textContent).slice(0, 16000);
}
function symbolsFrom(text) {
  return [...new Set(text.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_SYMBOLS_PER_LIST);
}
function getSymbolLists() {
  return {
    fast: symbolsFrom($("fastSymbols").value),
    weekly: symbolsFrom($("weeklySymbols").value)
  };
}
function saveSymbols() {
  const lists = getSymbolLists();
  if (!lists.fast.length && !lists.weekly.length) {
    log("Enter at least one symbol.");
    return false;
  }
  localStorage.setItem("breakout_fast_symbols", lists.fast.join(","));
  localStorage.setItem("breakout_weekly_symbols", lists.weekly.join(","));
  $("fastSymbols").value = lists.fast.join(",");
  $("weeklySymbols").value = lists.weekly.join(",");
  log("Symbol lists saved in this browser.");
  return true;
}
function loadSymbols() {
  $("fastSymbols").value = localStorage.getItem("breakout_fast_symbols") || "BTCUSDT,DOGEUSDT";
  $("weeklySymbols").value = localStorage.getItem("breakout_weekly_symbols") || "BTCUSDT,ETHUSDT";
  $("soundToggle").checked = localStorage.getItem("breakout_sound") !== "false";
}
async function fetchKlines(symbol, interval, limit) {
  const url = `${BINANCE_KLINES}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const response = await fetch(url, {cache:"no-store"});
  if (!response.ok) throw new Error(`Binance HTTP ${response.status} for ${symbol} ${interval}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error(`Unexpected Binance response for ${symbol}`);
  return data;
}
function beep() {
  if (!$("soundToggle").checked) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; gain.gain.value = 0.06;
    osc.start(); osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => ctx.close();
  } catch (_) {}
}
async function notifyBrowser(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, {body}); } catch (e) { log(`Browser notification error: ${e.message}`); }
  }
  beep();
}
function addSignal(kind, symbol, timeframe, reference, price) {
  const time = new Date();
  const high = kind.toLowerCase().includes("high") || kind.toLowerCase().includes("breakout");
  const label = high ? "HIGH BREAKOUT" : "LOW BREAKDOWN";
  const text = `${high ? "🚀" : "🔻"} ${label}\nSymbol: ${symbol}\nStrategy: ${timeframe}\nReference level: ${reference}\nObserved price: ${price}\nTime: ${time.toLocaleString()}`;
  latestSignalText = text;
  signalCount++;
  $("signalCount").textContent = String(signalCount);
  if (signalsEl.classList.contains("empty")) {
    signalsEl.classList.remove("empty");
    signalsEl.textContent = "";
  }
  const card = document.createElement("article");
  card.className = `signal ${high ? "high" : "low"}`;
  const head = document.createElement("div");
  head.className = "signal-head";
  const title = document.createElement("span");
  title.textContent = `${high ? "🚀" : "🔻"} ${symbol} · ${label}`;
  const timestamp = document.createElement("span");
  timestamp.className = "muted";
  timestamp.textContent = time.toLocaleTimeString();
  const body = document.createElement("p");
  body.textContent = `Strategy: ${timeframe}\nReference: ${reference}\nObserved: ${price}`;
  head.append(title, timestamp); card.append(head, body);
  signalsEl.prepend(card);
  while (signalsEl.children.length > 100) signalsEl.lastElementChild.remove();
  log(text.replaceAll("\n", " | "));
  notifyBrowser(`${symbol} ${label}`, `${timeframe}: ${price}`);
}
async function scanFastSymbol(symbol) {
  // Preserve original logic: compare the current 1-minute candle's high/low
  // to the previous CLOSED 1-hour candle's high/low (klines[-2]).
  const h1 = await fetchKlines(symbol, "1h", 2);
  if (h1.length < 2) return;
  const previous = h1[h1.length - 2];
  const candleTs = Number(previous[0]);
  const refHigh = Number(previous[2]);
  const refLow = Number(previous[3]);
  if (lastHourTimestamp[symbol] !== candleTs) {
    lastHourTimestamp[symbol] = candleTs;
    fastHighSent[symbol] = false;
    fastLowSent[symbol] = false;
  }
  const m1 = await fetchKlines(symbol, "1m", 1);
  if (!m1.length) return;
  const currentHigh = Number(m1[0][2]);
  const currentLow = Number(m1[0][3]);
  if (currentHigh > refHigh && !fastHighSent[symbol]) {
    addSignal("high", symbol, "1H + 1M", refHigh, currentHigh);
    fastHighSent[symbol] = true;
  }
  if (currentLow < refLow && !fastLowSent[symbol]) {
    addSignal("low", symbol, "1H + 1M", refLow, currentLow);
    fastLowSent[symbol] = true;
  }
}
async function scanWeeklySymbol(symbol) {
  // Preserve original logic: compare the current 1-hour candle's high/low
  // to the previous CLOSED weekly candle's high/low (klines[-2]).
  const w1 = await fetchKlines(symbol, "1w", 2);
  if (w1.length < 2) return;
  const previous = w1[w1.length - 2];
  const weekTs = Number(previous[0]);
  const weekHigh = Number(previous[2]);
  const weekLow = Number(previous[3]);
  if (weeklyTimestamp[symbol] !== weekTs) {
    weeklyTimestamp[symbol] = weekTs;
    weeklyHighSent[symbol] = false;
    weeklyLowSent[symbol] = false;
  }
  const h1 = await fetchKlines(symbol, "1h", 1);
  if (!h1.length) return;
  const currentHigh = Number(h1[0][2]);
  const currentLow = Number(h1[0][3]);
  if (currentHigh > weekHigh && !weeklyHighSent[symbol]) {
    addSignal("high", symbol, "1W + 1H", weekHigh, currentHigh);
    weeklyHighSent[symbol] = true;
  }
  if (currentLow < weekLow && !weeklyLowSent[symbol]) {
    addSignal("low", symbol, "1W + 1H", weekLow, currentLow);
    weeklyLowSent[symbol] = true;
  }
}
async function scanOnce() {
  if (!running || scanInProgress) return;
  scanInProgress = true;
  $("networkStatus").textContent = navigator.onLine ? "Online" : "Offline";
  try {
    if (!navigator.onLine) throw new Error("Browser is offline");
    const lists = getSymbolLists();
    const tasks = [];
    for (const symbol of lists.fast) tasks.push(["1H+1M", symbol, () => scanFastSymbol(symbol)]);
    for (const symbol of lists.weekly) tasks.push(["1W+1H", symbol, () => scanWeeklySymbol(symbol)]);
    for (const [strategy, symbol, fn] of tasks) {
      if (!running) break;
      try { await fn(); }
      catch (e) { log(`${strategy} ${symbol} ERROR: ${e.message}`); }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    lastScanAt = new Date();
    $("lastScan").textContent = lastScanAt.toLocaleTimeString();
  } finally {
    scanInProgress = false;
  }
}
function setRunning(value) {
  running = value;
  $("status").className = `pill ${running ? "running" : "stopped"}`;
  $("statusText").textContent = running ? "Running in this tab" : "Stopped";
  $("startBtn").disabled = running;
  $("stopBtn").disabled = !running;
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  if (running) {
    log("Scanner started.");
    scanOnce();
    scanTimer = setInterval(scanOnce, SCAN_INTERVAL_MS);
  } else {
    log("Scanner stopped.");
  }
}
$("startBtn").addEventListener("click", () => {
  if (saveSymbols()) setRunning(true);
});
$("stopBtn").addEventListener("click", () => setRunning(false));
$("saveBtn").addEventListener("click", saveSymbols);
$("notifyBtn").addEventListener("click", async () => {
  if (!("Notification" in window)) return log("This browser does not support notifications.");
  const permission = await Notification.requestPermission();
  log(`Browser notification permission: ${permission}`);
});
$("testBtn").addEventListener("click", () => {
  addSignal("high", "TEST", "Test alert", "—", "—");
});
$("soundToggle").addEventListener("change", () => localStorage.setItem("breakout_sound", String($("soundToggle").checked)));
$("clearSignalsBtn").addEventListener("click", () => {
  signalsEl.replaceChildren();
  signalsEl.classList.add("empty");
  signalsEl.textContent = "History cleared.";
  signalCount = 0; $("signalCount").textContent = "0";
});
$("clearLogsBtn").addEventListener("click", () => logsEl.textContent = "Logs cleared.");
$("copyLatestBtn").addEventListener("click", async () => {
  if (!latestSignalText) return $("telegramMessage").textContent = "No signal to copy yet.";
  try {
    await navigator.clipboard.writeText(latestSignalText);
    $("telegramMessage").textContent = "Latest signal copied. Paste it into Telegram.";
  } catch (_) {
    $("telegramMessage").textContent = latestSignalText;
  }
});
window.addEventListener("online", () => { $("networkStatus").textContent = "Online"; log("Network online."); });
window.addEventListener("offline", () => { $("networkStatus").textContent = "Offline"; log("Network offline."); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden && running) log("Warning: tab is hidden. Browser throttling may delay scans.");
});
window.addEventListener("beforeunload", () => {
  if (scanTimer) clearInterval(scanTimer);
});
loadSymbols();
$("networkStatus").textContent = navigator.onLine ? "Online" : "Offline";
