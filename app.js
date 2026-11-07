/* JioPhone/KaiOS-compatible Breakout Scanner.
   ES5 syntax + XMLHttpRequest + classic DOM events.
   Keeps the same strategy and UI behavior while avoiding async/await, fetch,
   arrow functions, const/let, spread syntax, replaceAll/replaceChildren,
   and other newer APIs that can make older KaiOS browsers fail to parse/run. */
(function () {
  "use strict";

  var BINANCE_KLINES = "https://fapi.binance.com/fapi/v1/klines";
  var BINANCE_24H_TICKER = "https://fapi.binance.com/fapi/v1/ticker/24hr";
  var MOVERS_REFRESH_MS = 60 * 60 * 1000;
  var MOVERS_THRESHOLD_PERCENT = 20;
  var SCAN_INTERVAL_MS = 60 * 1000;
  var MAX_SYMBOLS_PER_LIST = 15;
  var QUALIFIED_FAST_SYMBOLS = {};
  var running = false;
  var scanTimer = null;
  var scanInProgress = false;
  var signalCount = 0;
  var latestSignalText = "";
  var moversTimer = null;
  var moversFetchInProgress = false;
  var lastHourTimestamp = {};
  var fastHighSent = {};
  var fastLowSent = {};
  var weeklyTimestamp = {};
  var weeklyHighSent = {};
  var weeklyLowSent = {};

  function $(id) { return document.getElementById(id); }
  var logsEl = $("logs");
  var signalsEl = $("signals");

  function log(message) {
    var line = "[" + new Date().toLocaleString() + "] " + message;
    logsEl.textContent = (line + "\n" + logsEl.textContent).slice(0, 16000);
  }

  function symbolsFrom(text) {
    var parts = String(text || "").split(",");
    var out = [];
    var seen = {};
    var i, s;
    for (i = 0; i < parts.length; i++) {
      s = parts[i].replace(/^\s+|\s+$/g, "").toUpperCase();
      if (s && !seen[s] && out.length < MAX_SYMBOLS_PER_LIST) {
        seen[s] = true;
        out.push(s);
      }
    }
    return out;
  }

  function getSymbolLists() {
    return { fast: symbolsFrom($("fastSymbols").value), weekly: symbolsFrom($("weeklySymbols").value) };
  }

  function saveSymbols() {
    var lists = getSymbolLists();
    if (!lists.fast.length && !lists.weekly.length) { log("Enter at least one symbol."); return false; }
    try {
      localStorage.setItem("breakout_fast_symbols", lists.fast.join(","));
      localStorage.setItem("breakout_weekly_symbols", lists.weekly.join(","));
      localStorage.setItem("breakout_sound", $("soundToggle").checked ? "true" : "false");
    } catch (e) {}
    $("fastSymbols").value = lists.fast.join(",");
    $("weeklySymbols").value = lists.weekly.join(",");
    log("Symbol lists saved in this browser.");
    return true;
  }

  function loadSymbols() {
    var fast = "BTCUSDT,DOGEUSDT";
    var weekly = "BTCUSDT,ETHUSDT";
    try {
      fast = localStorage.getItem("breakout_fast_symbols") || fast;
      weekly = localStorage.getItem("breakout_weekly_symbols") || weekly;
    } catch (e) {}
    $("fastSymbols").value = fast;
    $("weeklySymbols").value = weekly;
    try { $("soundToggle").checked = localStorage.getItem("breakout_sound") !== "false"; } catch (e2) {}
  }

  function xhrJson(url, callback, errorCallback) {
    var xhr = new XMLHttpRequest();
    try {
      xhr.open("GET", url, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          try { callback(JSON.parse(xhr.responseText)); }
          catch (e) { errorCallback(new Error("Invalid JSON response")); }
        } else {
          errorCallback(new Error("HTTP " + xhr.status));
        }
      };
      xhr.onerror = function () { errorCallback(new Error("Network request failed")); };
      xhr.ontimeout = function () { errorCallback(new Error("Network request timed out")); };
      xhr.timeout = 20000;
      xhr.send(null);
    } catch (e2) { errorCallback(e2); }
  }

  function fetchKlines(symbol, interval, limit, callback, errorCallback) {
    var url = BINANCE_KLINES + "?symbol=" + encodeURIComponent(symbol) + "&interval=" + interval + "&limit=" + limit;
    xhrJson(url, function (data) {
      if (!(data instanceof Array)) { errorCallback(new Error("Unexpected Binance response for " + symbol)); return; }
      callback(data);
    }, function (err) {
      errorCallback(new Error(err.message + " for " + symbol + " " + interval));
    });
  }

  function formatPrice(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }
  function formatVolume(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function renderMovers(rows) {
    var body = $("moversBody"), i, coin, tr, td, v;
    clearChildren(body);
    if (!rows.length) {
      tr = document.createElement("tr"); td = document.createElement("td"); td.colSpan = 6;
      td.className = "table-empty";
      td.textContent = "No USDT-margined futures symbols currently exceed +" + MOVERS_THRESHOLD_PERCENT + "% in 24 hours.";
      tr.appendChild(td); body.appendChild(tr); return;
    }
    for (i = 0; i < rows.length; i++) {
      coin = rows[i]; tr = document.createElement("tr");
      td = document.createElement("td"); td.className = "coin-symbol"; td.textContent = coin.symbol; tr.appendChild(td);
      td = document.createElement("td"); v = Number(coin.priceChangePercent); td.className = v >= 0 ? "change-up" : "change-down"; td.textContent = (v > 0 ? "+" : "") + v.toFixed(2) + "%"; tr.appendChild(td);
      td = document.createElement("td"); td.textContent = formatPrice(coin.lastPrice); tr.appendChild(td);
      td = document.createElement("td"); td.textContent = formatPrice(coin.highPrice); tr.appendChild(td);
      td = document.createElement("td"); td.textContent = formatPrice(coin.lowPrice); tr.appendChild(td);
      td = document.createElement("td"); td.textContent = formatVolume(coin.quoteVolume); tr.appendChild(td);
      body.appendChild(tr);
    }
  }

  function get24HourPositiveMovers(callback, errorCallback) {
    xhrJson(BINANCE_24H_TICKER, function (data) {
      var out = [], i, c, n;
      if (!(data instanceof Array)) { errorCallback(new Error("Unexpected 24-hour ticker response")); return; }
      for (i = 0; i < data.length; i++) {
        c = data[i]; n = Number(c.priceChangePercent);
        if (typeof c.symbol === "string" && c.symbol.indexOf("USDT") === c.symbol.length - 4 && isFinite(n) && n > MOVERS_THRESHOLD_PERCENT) out.push(c);
      }
      out.sort(function (a, b) { return Number(b.priceChangePercent) - Number(a.priceChangePercent); });
      callback(out);
    }, errorCallback);
  }

  function hasLastFourHigherLow1HCandles(symbol, callback, errorCallback) {
    fetchKlines(symbol, "1h", 6, function (candles) {
      var i, previousLow, currentLow;
      if (candles.length < 6) { callback(false); return; }
      for (i = 1; i < 5; i++) {
        previousLow = Number(candles[i - 1][3]); currentLow = Number(candles[i][3]);
        if (!isFinite(previousLow) || !isFinite(currentLow) || currentLow <= previousLow) { callback(false); return; }
      }
      callback(true);
    }, errorCallback);
  }

  function checkMoverList(movers, index, qualified, done) {
    if (index >= movers.length) { done(qualified); return; }
    var coin = movers[index];
    hasLastFourHigherLow1HCandles(coin.symbol, function (ok) {
      if (ok) { QUALIFIED_FAST_SYMBOLS[coin.symbol] = true; qualified.push(coin); }
      checkMoverList(movers, index + 1, qualified, done);
    }, function (err) {
      log("1H trend check " + coin.symbol + " ERROR: " + err.message);
      checkMoverList(movers, index + 1, qualified, done);
    });
  }

  function refresh24HourMovers(manual) {
    if (moversFetchInProgress) return;
    moversFetchInProgress = true;
    $("moversStatus").textContent = "Finding +20% movers and checking strict higher lows...";
    if (manual) $("refreshMoversBtn").disabled = true;
    get24HourPositiveMovers(function (movers) {
      QUALIFIED_FAST_SYMBOLS = {};
      checkMoverList(movers, 0, [], function (qualified) {
        renderMovers(qualified);
        $("moversCount").textContent = qualified.length + " qualified coin" + (qualified.length === 1 ? "" : "s");
        $("moversUpdated").textContent = "Updated " + new Date().toLocaleTimeString();
        $("moversStatus").textContent = "+20% 24h movers with strict higher lows are now analyzed by 1H + 1M.";
        var names = [], k;
        for (k in QUALIFIED_FAST_SYMBOLS) if (QUALIFIED_FAST_SYMBOLS.hasOwnProperty(k)) names.push(k);
        $("fastSymbols").value = names.join(",");
        log("Qualified 1H + 1M symbols: " + (names.join(", ") || "none"));
        moversFetchInProgress = false;
        if (manual) $("refreshMoversBtn").disabled = false;
      });
    }, function (error) {
      $("moversStatus").textContent = "Update failed: " + error.message;
      log("24h movers ERROR: " + error.message);
      moversFetchInProgress = false;
      if (manual) $("refreshMoversBtn").disabled = false;
    });
  }

  function startMoversRefreshSchedule() {
    refresh24HourMovers(false);
    if (moversTimer) clearInterval(moversTimer);
    moversTimer = setInterval(function () { refresh24HourMovers(false); }, MOVERS_REFRESH_MS);
  }

  function beep() {
    if (!$("soundToggle").checked) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx(); var osc = ctx.createOscillator(); var gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination); osc.frequency.value = 880; gain.gain.value = 0.06;
      osc.start(); osc.stop(ctx.currentTime + 0.18);
    } catch (e) {}
  }

  function notifyBrowser(title, body) {
    try {
      if (window.Notification && Notification.permission === "granted") new Notification(title, { body: body });
    } catch (e) {}
    beep();
  }

  function loadTelegramSettings() {
    var token = "", chat = "", enabled = false;
    try { token = localStorage.getItem("breakout_telegram_token") || ""; chat = localStorage.getItem("breakout_telegram_chat_id") || ""; enabled = localStorage.getItem("breakout_telegram_enabled") === "true"; } catch (e) {}
    $("telegramToken").value = token; $("telegramChatId").value = chat; $("telegramToggle").checked = enabled;
  }

  function saveTelegramSettings() {
    var token = $("telegramToken").value.replace(/^\s+|\s+$/g, "");
    var chatId = $("telegramChatId").value.replace(/^\s+|\s+$/g, "");
    if (!token || !chatId) { $("telegramMessage").textContent = "Enter both the Telegram bot token and chat ID."; log("Telegram settings not saved: token and chat ID are required."); return false; }
    try {
      localStorage.setItem("breakout_telegram_token", token); localStorage.setItem("breakout_telegram_chat_id", chatId); localStorage.setItem("breakout_telegram_enabled", String($("telegramToggle").checked));
    } catch (e) {}
    $("telegramMessage").textContent = "Telegram settings saved in this browser."; log("Telegram settings saved."); return true;
  }

  function sendTelegramMessage(message, force, done) {
    if (!force && !$("telegramToggle").checked) { done(null, { skipped: true }); return; }
    var token = $("telegramToken").value.replace(/^\s+|\s+$/g, "");
    var chatId = $("telegramChatId").value.replace(/^\s+|\s+$/g, "");
    if (!token || !chatId) { done(new Error("Telegram alerts are enabled, but bot token or chat ID is missing.")); return; }
    var url = "https://api.telegram.org/bot" + encodeURIComponent(token) + "/sendMessage";
    var xhr = new XMLHttpRequest();
    try {
      xhr.open("POST", url, true); xhr.setRequestHeader("Content-Type", "application/json"); xhr.timeout = 20000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status < 200 || xhr.status >= 300) { done(new Error("Telegram HTTP " + xhr.status)); return; }
        try { var data = JSON.parse(xhr.responseText); if (!data.ok) done(new Error(data.description || "Telegram API rejected the message.")); else done(null, data); }
        catch (e) { done(new Error("Invalid Telegram response")); }
      };
      xhr.onerror = function () { done(new Error("Telegram network request failed")); };
      xhr.ontimeout = function () { done(new Error("Telegram request timed out")); };
      xhr.send(JSON.stringify({ chat_id: chatId, text: message }));
    } catch (e2) { done(e2); }
  }

  function sendTelegramTest() {
    if (!saveTelegramSettings()) return;
    $("telegramMessage").textContent = "Sending test message...";
    sendTelegramMessage("🟢 Telegram test successful\n\nBinance Breakout Scanner is connected and ready to send signals.", true, function (err) {
      if (err) { $("telegramMessage").textContent = "Telegram test failed: " + err.message; log("Telegram ERROR: " + err.message); }
      else { $("telegramMessage").textContent = "Test Telegram sent successfully."; log("Telegram test message sent successfully."); }
    });
  }

  function addSignal(kind, symbol, timeframe, reference, price) {
    var time = new Date();
    var high = kind.toLowerCase().indexOf("high") >= 0 || kind.toLowerCase().indexOf("breakout") >= 0;
    var label = high ? "HIGH BREAKOUT" : "LOW BREAKDOWN";
    var text = (high ? "🚀" : "🔻") + " " + label + "\nSymbol: " + symbol + "\nStrategy: " + timeframe + "\nReference level: " + reference + "\nObserved price: " + price + "\nTime: " + time.toLocaleString();
    latestSignalText = text; signalCount++; $("signalCount").textContent = String(signalCount);
    if (signalsEl.className.indexOf("empty") >= 0) { signalsEl.className = signalsEl.className.replace(/\bempty\b/g, "").replace(/^\s+|\s+$/g, ""); clearChildren(signalsEl); }
    var card = document.createElement("article"); card.className = "signal " + (high ? "high" : "low");
    var head = document.createElement("div"); head.className = "signal-head";
    var title = document.createElement("span"); title.textContent = (high ? "🚀" : "🔻") + " " + symbol + " · " + label;
    var timestamp = document.createElement("span"); timestamp.className = "muted"; timestamp.textContent = time.toLocaleTimeString();
    var body = document.createElement("p"); body.textContent = "Strategy: " + timeframe + "\nReference: " + reference + "\nObserved: " + price;
    head.appendChild(title); head.appendChild(timestamp); card.appendChild(head); card.appendChild(body); signalsEl.insertBefore(card, signalsEl.firstChild);
    while (signalsEl.children.length > 100) signalsEl.removeChild(signalsEl.lastChild);
    log(text.split("\n").join(" | ")); notifyBrowser(symbol + " " + label, timeframe + ": " + price);
    sendTelegramMessage(text, false, function (err) { if (err) log("Telegram alert ERROR for " + symbol + ": " + err.message); else log("Telegram alert sent: " + symbol + " " + label); });
  }

  function scanFastSymbol(symbol, done) {
    fetchKlines(symbol, "1h", 2, function (h1) {
      if (h1.length < 2) { done(); return; }
      var previous = h1[h1.length - 2]; var candleTs = Number(previous[0]); var refHigh = Number(previous[2]); var refLow = Number(previous[3]);
      if (lastHourTimestamp[symbol] !== candleTs) { lastHourTimestamp[symbol] = candleTs; fastHighSent[symbol] = false; fastLowSent[symbol] = false; }
      fetchKlines(symbol, "1m", 1, function (m1) {
        if (!m1.length) { done(); return; }
        var currentHigh = Number(m1[0][2]); var currentLow = Number(m1[0][3]);
        if (currentHigh > refHigh && !fastHighSent[symbol]) { addSignal("high", symbol, "1H + 1M", refHigh, currentHigh); fastHighSent[symbol] = true; }
        if (currentLow < refLow && !fastLowSent[symbol]) { addSignal("low", symbol, "1H + 1M", refLow, currentLow); fastLowSent[symbol] = true; }
        done();
      }, function (e) { log("1H+1M " + symbol + " ERROR: " + e.message); done(); });
    }, function (e2) { log("1H+1M " + symbol + " ERROR: " + e2.message); done(); });
  }

  function scanWeeklySymbol(symbol, done) {
    fetchKlines(symbol, "1w", 2, function (w1) {
      if (w1.length < 2) { done(); return; }
      var previous = w1[w1.length - 2]; var weekTs = Number(previous[0]); var weekHigh = Number(previous[2]); var weekLow = Number(previous[3]);
      if (weeklyTimestamp[symbol] !== weekTs) { weeklyTimestamp[symbol] = weekTs; weeklyHighSent[symbol] = false; weeklyLowSent[symbol] = false; }
      fetchKlines(symbol, "1h", 1, function (h1) {
        if (!h1.length) { done(); return; }
        var currentHigh = Number(h1[0][2]); var currentLow = Number(h1[0][3]);
        if (currentHigh > weekHigh && !weeklyHighSent[symbol]) { addSignal("high", symbol, "1W + 1H", weekHigh, currentHigh); weeklyHighSent[symbol] = true; }
        if (currentLow < weekLow && !weeklyLowSent[symbol]) { addSignal("low", symbol, "1W + 1H", weekLow, currentLow); weeklyLowSent[symbol] = true; }
        done();
      }, function (e) { log("1W+1H " + symbol + " ERROR: " + e.message); done(); });
    }, function (e2) { log("1W+1H " + symbol + " ERROR: " + e2.message); done(); });
  }

  function runTasks(tasks, index, done) {
    if (!running || index >= tasks.length) { done(); return; }
    tasks[index].fn(function () { setTimeout(function () { runTasks(tasks, index + 1, done); }, 250); });
  }

  function scanOnce() {
    if (!running || scanInProgress) return;
    scanInProgress = true; $("networkStatus").textContent = navigator.onLine ? "Online" : "Offline";
    if (!navigator.onLine) { log("Browser is offline"); scanInProgress = false; return; }
    var lists = getSymbolLists(), tasks = [], i;
    for (var k in QUALIFIED_FAST_SYMBOLS) if (QUALIFIED_FAST_SYMBOLS.hasOwnProperty(k)) (function (symbol) { tasks.push({ fn: function (done) { scanFastSymbol(symbol, done); } }); })(k);
    for (i = 0; i < lists.weekly.length; i++) (function (symbol2) { tasks.push({ fn: function (done) { scanWeeklySymbol(symbol2, done); } }); })(lists.weekly[i]);
    runTasks(tasks, 0, function () { $("lastScan").textContent = new Date().toLocaleTimeString(); scanInProgress = false; });
  }

  function setRunning(value) {
    running = value; $("status").className = "pill " + (running ? "running" : "stopped"); $("statusText").textContent = running ? "Running in this tab" : "Stopped";
    $("startBtn").disabled = running; $("stopBtn").disabled = !running;
    if (scanTimer) clearInterval(scanTimer); scanTimer = null;
    if (running) { log("Scanner started."); scanOnce(); scanTimer = setInterval(scanOnce, SCAN_INTERVAL_MS); }
    else log("Scanner stopped.");
  }

  function bindButton(id, fn) {
    var el = $(id);
    el.onclick = fn;
    el.ontouchend = function (e) { try { if (e && e.preventDefault) e.preventDefault(); } catch (_) {} fn(); return false; };
  }

  bindButton("startBtn", function () { if (saveSymbols()) setRunning(true); });
  bindButton("stopBtn", function () { setRunning(false); });
  bindButton("saveBtn", saveSymbols);
  bindButton("notifyBtn", function () {
    try { if (window.Notification && Notification.requestPermission) Notification.requestPermission(function (p) { log("Browser notification permission: " + p); }); else log("This browser does not support notifications."); }
    catch (e) { log("Notification error: " + e.message); }
  });
  bindButton("testBtn", function () { addSignal("high", "TEST", "Test alert", "—", "—"); });
  bindButton("saveTelegramBtn", saveTelegramSettings);
  bindButton("testTelegramBtn", sendTelegramTest);
  bindButton("clearSignalsBtn", function () { clearChildren(signalsEl); signalsEl.className = "signals empty"; signalsEl.textContent = "History cleared."; signalCount = 0; $("signalCount").textContent = "0"; });
  bindButton("clearLogsBtn", function () { logsEl.textContent = "Logs cleared."; });
  bindButton("refreshMoversBtn", function () { refresh24HourMovers(true); });
  bindButton("copyLatestBtn", function () { if (!latestSignalText) { $("telegramMessage").textContent = "No signal to copy yet."; return; } $("telegramMessage").textContent = latestSignalText; });

  $("telegramToggle").onclick = function () { try { localStorage.setItem("breakout_telegram_enabled", String($("telegramToggle").checked)); } catch (e) {} $("telegramMessage").textContent = $("telegramToggle").checked ? "Telegram alerts enabled." : "Telegram alerts disabled."; };
  $("soundToggle").onclick = function () { try { localStorage.setItem("breakout_sound", String($("soundToggle").checked)); } catch (e) {} };
  window.addEventListener("online", function () { $("networkStatus").textContent = "Online"; log("Network online."); });
  window.addEventListener("offline", function () { $("networkStatus").textContent = "Offline"; log("Network offline."); });

  loadSymbols(); loadTelegramSettings(); $("networkStatus").textContent = navigator.onLine ? "Online" : "Offline";
  log("JioPhone-compatible scanner loaded.");
  startMoversRefreshSchedule();
})();
