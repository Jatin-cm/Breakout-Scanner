# Binance Futures Breakout Scanner — GitHub Pages (JavaScript)

This is a browser-only JavaScript conversion of the uploaded Python signal scanner. It does not use a server or ESP32.

## What it preserves

- **1H + 1M:** fetches 2 hourly candles, uses `klines[-2]` (previous closed 1H candle), then compares the current 1-minute candle high/low against that reference high/low.
- **1W + 1H:** fetches 2 weekly candles, uses `klines[-2]` (previous closed weekly candle), then compares the current 1-hour candle high/low against the weekly reference high/low.
- One high and one low signal per symbol per reference candle (hour or week) while the page remains open.
- Binance Futures public market data; no Binance API key and no order placement.
- **24-hour movers panel:** fetches Binance USDⓈ-M Futures 24-hour ticker data immediately on page load, then updates hourly while the page remains open. It lists USDT symbols with absolute 24-hour price change strictly greater than 20%, sorted by largest absolute move, with last price, high/low and quote volume. A manual Refresh now button is also available.

## Important limitation

This is **not a 24/7 background service**. The scanner runs inside the browser tab:
- Keep the page open and the device awake.
- Closing the tab/browser stops scanning and hourly movers refreshes.
- Mobile and desktop browsers throttle background tabs; sleep, network loss, laptop lid close, or phone power-saving can delay scans.
- If the page is refreshed, per-session duplicate flags reset. Symbol lists persist in that browser only.
- It scans sequentially with short pauses and caps each list at 15 symbols to reduce request bursts. Larger lists can take longer and Binance rate limits/network issues may occur.

## Deploy to GitHub Pages

1. Create a repository. For GitHub Free, GitHub Pages for a personal account is commonly easiest from a public repository. Do not put secrets in the repository.
2. Upload `index.html`, `style.css`, `app.js` and `README.md` to the repository root.
3. In repository Settings -> Pages, select deploy from the `main` branch and `/ (root)`.
4. Wait for the published Pages URL and open it.
5. Enter your symbols and press Start scanner.
6. Click Enable browser notifications and allow notifications if desired. Sound alerts may require an initial user interaction.

## Telegram alert security

### Safest without a server
Use browser notifications and sound, then click Copy latest signal and paste it into Telegram manually.

### Secure automatic Telegram
Use a small backend/Cloudflare Worker that stores `TELEGRAM_BOT_TOKEN` as a server-side secret. The browser sends the signal payload to that endpoint; the endpoint calls Telegram. Protect the endpoint with rate limiting and authentication appropriate to your use case.

### Not recommended: put the bot token in `app.js`
A Telegram bot token embedded in JavaScript, HTML, or GitHub repository settings sent to the browser is not secret. Anyone can inspect browser source/network requests and use the token to send messages as your bot. A private GitHub repository does not make deployed client-side secrets safe.

## Notes

- Binance public API can change, be rate-limited, or be unreachable from a browser/network.
- This is signal-only, not financial advice and not a guarantee of profitable signals.
- The app uses the browser's local storage only for symbol lists and sound preference. It does not store exchange credentials or Telegram tokens.
