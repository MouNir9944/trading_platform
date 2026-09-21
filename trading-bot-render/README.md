# Trading Bot Dashboard — single Node service

The React dashboard and the API now run as **one Node service**. The Python/FastAPI backend was
ported to JavaScript, so there is one build, one process and one Render service.

```
server/   Express API + order monitor (port of main.py, binance_client.py, strategy.py,
          risk_manager.py, trade_executor.py)
src/      React app (Vite) — unchanged UI, same /api/* calls
dist/     Production build, served by Express
server/store.js  Storage: MongoDB (MONGODB_URI) or local JSON files (dev fallback)
```

## Run locally

```bash
npm install
cp .env.example .env      # fill in your Testnet keys; loaded automatically via --env-file
npm run dev               # API on :8000, Vite on :5173 (open http://localhost:5173)
```

Production-style run: `npm run build && npm start` (set `NODE_ENV=production` and `APP_PASSWORD` to mirror Render).

## Analysis, indicators and strategies

Everything lives in `shared/analysis/` (pure JavaScript, used by both the browser and the tests) and runs in the
browser on the candles the chart already has, so it adds no server load and no Binance calls.

- **Indicators**: SMA/EMA, RSI, MACD, Bollinger Bands, ATR, Stochastic, ADX (+DI/-DI), Supertrend, volume ratio.
- **Market structure**: swing highs/lows, HH/HL/LH/LL trend, break of structure (BOS) and change of character
  (CHoCH), support/resistance from clustered swings.
- **Strategies** (spot, long-only): MA crossover + breakout, RSI oversold reversal, MACD momentum, Bollinger squeeze
  breakout, Supertrend, structure break, trend pullback. Each returns BUY / EXIT / WAIT with reasons and, for a BUY, a
  stop-loss and take-profit.
- **Chart overlays** (toggle in the chart toolbar): structure labels and BOS/CHoCH, support/resistance, Bollinger,
  EMA 50, RSI pane, MACD pane. Your choice is remembered.
- **Smart-money concepts** (chips FVG, Order blocks, Liquidity, Prem/Disc on the chart; "Smart money concepts" card in
  the Analysis tab; one strategy): **fair value gaps** (bullish/bearish three-candle imbalances, drawn until price
  trades fully through them, with the % filled), **order blocks** (the last opposite candle before the move that broke
  structure, until price closes through it), **liquidity** (equal highs/lows, and *sweeps*: a wick through the level that
  closes back inside), and **premium/discount** (which half of the current swing range price is in). The
  "Smart money: gap / order-block retest" strategy buys a dip into an open gap or bullish block in the discount half of
  a bullish structure and exits on the mirror image. Everything is computed without look-ahead (each zone records when
  it became knowable), and a test checks that no strategy sees future candles. These are interpretations of price action,
  not guarantees: many gaps and blocks never get retested and several fail.
- **SMC (LuxAlgo) mode** (chip "SMC (LuxAlgo)" plus ⚙ settings in the chart toolbar): a port of the *Smart Money
  Concepts [LuxAlgo]* indicator, on the last 2000 candles. Internal (5-bar) and swing (50-bar) structure with BOS/CHoCH,
  order blocks with the volatility filter and mitigation (High/Low or Close), equal highs/lows, filtered fair value gaps,
  premium/equilibrium/discount zones, strong/weak high and low, HH/LH/HL/LL swing points, previous day/week/month
  levels (UTC), trend-coloured candles, Historical/Present mode and Colored/Monochrome style. It is a separate mode:
  the basic smart-money overlays above are unchanged. Known deviations from the Pine script: before 200 candles the
  ATR falls back to the running mean true range, the confluence filter follows its evident intent, and gaps are
  computed on the chart timeframe only. The engine is causal (a test checks that adding candles never changes earlier
  results).
  **Licence:** this port (`shared/analysis/luxSmc.js`, `src/lib/luxOverlay.js`) derives from LuxAlgo's indicator, which
  is licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/): keep the attribution, do not use it
  commercially, and share derivatives under the same licence. Check that before making the project public or selling
  access to it.
- **AMD indicator** (chip "AMD" plus ⚙ in the chart toolbar; `shared/analysis/amd.js`): **A**ccumulation, **M**anipulation,
  **F**VG, **D**istribution, shown only when they happen in that order. A tight sideways range (10+ candles, at most
  3.5 ATR tall) has one side swept by a wick that is not a real breakout; a strong candle back the other way then leaves
  a fair value gap. **The gap is the signal**, and nothing is drawn before it forms. Distribution is the move to the far
  side of the range: the setup ends as *distributed* when it gets there, or *failed* if a candle closes beyond the
  sweep first. Bullish and bearish are mirror images. The chart draws each stage (A box, M sweep line and marker, F box,
  D zone and target), a status strip shows the newest setup, and settings filter by direction, only-completed,
  failed setups and sensitivity. The setup must still offer at least 1R to the far side when the gap forms. The
  strategy "AMD: sweep then fair value gap" buys on a bullish gap (stop under the sweep, target the far side of the
  range) and exits on a bearish one. It uses no look-ahead (a test checks it). Backtest it before trusting it: on
  46 long trades across 6 futures pairs and 3 timeframes (1500 candles each) it won 39% with an average of -0.09% per
  trade after fees, so it is a way to *find* setups, not a proven edge.
  Alerts, automatic orders and the backtest live on the **AMD Bot** screen (see next item).
- **AMD Bot** (header, `/#amd`; `server/autoAmd.js`, `server/notifier.js`, `shared/analysis/amdTrade.js`), three tabs:
  - **Backtest**: replays the exact orders the bot would place on up to 5000 candles of real Binance history for up to
    12 pairs: a limit order after each signal candle closes (at the close, or on a retest of the gap), stop under the
    sweep, target the far side of the range or a multiple of the risk. Realism rules: the order lapses after N candles;
    a fill happens at the limit price (at the open on a gap); if price reaches the target before the entry fills the
    trade is missed, never chased; if stop and target are inside one candle the stop wins; only the stop can end a
    trade on the candle that fills it; fees both ways; one position per pair; unfinished trades are left out. Output:
    verdict, expectancy in R, win rate, profit factor, drawdown, longest losing run, average planned reward:risk,
    first-half/second-half stability, equity curve, per-pair table with buy & hold, a comparison of 8 entry/target
    variants (fitting to the past: read it as noise, not as a recipe), and the latest trades.
    **Honest result:** on 3000 15m candles (about 31 days) of 10 futures pairs the default settings gave 180 trades,
    41% wins, **-0.14R per trade after fees** (profit factor 0.76), and the two halves of the sample disagreed. On other
    timeframes it was around break-even. The signal finds setups; it is not a proven edge.
  - **Auto trading**: the server (not the browser) checks your pairs every 30 seconds, once per closed candle, so it
    works with every tab closed. Two separate switches: *watch and notify* (no orders) and *automatic orders*. Orders go
    through the same order managers as manual ones, so every rule of the Risk tab still applies (risk per trade, max
    position, minimum reward:risk, leverage, daily loss, pause switch) and each order gets its stop-loss and take-profit
    on Binance. Its own limits: max open orders and max orders per day, one order per pair, spot is long-only, an
    unfilled entry is cancelled after N candles, and a signal older than 2 candles is ignored. Arming is tied to the
    current account: it requires a backtest of the exact settings first, an explicit acknowledgement when that backtest
    lost money, and the word `LIVE` on the live account; switching between Testnet and Live switches it off. Orders the
    risk rules refuse are reported as "order not placed" with the reason. The Risk tab default (minimum reward:risk 1.5)
    is above what these signals average (about 1.45), so with defaults many orders are refused: the screen warns you.
  - **Notifications**: every signal, order, fill, close, error and arm/disarm becomes an event stored on the server
    (kept across restarts). The 🔔 in the header shows unread events, with cards, a chime and optional system
    notifications, and anything that happened while you were away is waiting as unread. Optional outbound channels are
    set with environment variables on the server: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, and
    `NOTIFY_WEBHOOK_URL` (JSON POST). "Send a test notification" shows what each channel answered. Telegram and
    webhook delivery is covered by tests with a fake network only; test them once with your own bot before relying on them.
- **Markets and asset classes** (header picker): a **Spot / Futures** switch and asset-class filters
  (Crypto, Stocks, Commodities, Forex, Other), each ranked with class-appropriate rules (a healthy 24h range is
  1-4% for a stock, 0.3-1.5% for a currency, 2-8% for a crypto) and sized with class-appropriate stop distances.
  What Binance actually offers, checked against its live exchange data:
  - **Stocks**: tokenized stocks on **spot** (TSLAB/USDT, NVDAB/USDT, SPYB/USDT, ...: about 70-75 pairs) and
    stock/ETF **perpetual futures** (about 187 US, Korean, Hong Kong and Chinese equities). Stock prices follow their
    home market, so they barely move at night and on weekends.
  - **Commodities**: gold, silver, platinum, copper, oil and gas, as perpetual futures.
  - **Forex**: Binance is not a forex broker. EUR/USDT on spot is the only currency pair against USDT (its FX
    futures contract, USDBRL, is not live yet).
  - **Spot** instruments (crypto, stock tokens, EUR/USDT) trade through the normal ticket, with the risk rules.
  - **Futures trading** (USD-M perpetuals: crypto, stocks, commodities, and forex contracts once Binance lists them)
    works from the same ticket when the header is on **Futures**: pick **Long** or **Short**, leverage and margin; a
    limit entry is placed, and when it fills the **stop-loss and take-profit are placed on Binance** (conditional
    orders that close the whole position, triggered on the mark price). Open positions show in the ticket with a
    **Close** button; each managed order is drawn on the chart, long or short. Built-in safety:
    - **isolated margin** and **One-way position mode** only, **USDT-margined perpetual contracts** only;
    - the risk rules apply on the server (risk per trade, size limit measured on the margin, open risk, reward:risk,
      daily loss, streak, drawdown) plus a **maximum leverage** setting (default 5×);
    - the stop must sit well inside the **liquidation distance** (about 100/leverage %, less maintenance margin): an
      order whose stop would come after liquidation is refused, whatever the other settings;
    - one managed order per contract, and never on top of a position that already exists on Binance;
    - if the stop-loss cannot be placed after a fill the position is closed at once; a stop or target cancelled on
      Binance is placed again; a position closed outside the app (or liquidated) closes its record;
    - live orders ask for confirmation. Funding fees are not included in the P&L shown.
    Keys: futures use their **own** keys. For **Testnet** create them in Binance Demo Trading (futures) and set
    `BINANCE_FUTURES_API_KEY` / `BINANCE_FUTURES_API_SECRET` (host `https://demo-fapi.binance.com`, override with
    `BINANCE_FUTURES_TESTNET_URL`); your Spot testnet keys do not work there. For **live** set
    `BINANCE_FUTURES_API_KEY_real` / `_SECRET_real`, or enable Futures on your live key. TradFi contracts (stocks,
    commodities) also need Binance's TradFi-perpetuals agreement accepted on your account. Everything above was
    tested against a local stand-in for the futures API and unit tests; run a Testnet trade end to end before using
    real money.
- **Charts** (header switch "Trading / Charts / My stocks"): a grid of 1, 2, 4, 6 or 9 live charts to follow several pairs
  at once. Each chart has its own market (Spot or Futures), pair and timeframe. The pair button opens a picker with
  **every** listed pair (about 480 spot and 720 futures: crypto, stocks, commodities, forex), a **quote** selector (USDT,
  USDC, BTC, EUR, TRY, BRL…), asset-class chips, search, sorting, and a "use this symbol" fallback. Charts always use
  **live public market data**, whatever the Testnet / Live switch says (`source=live` on the market endpoints),
  with volume, a 21 EMA, the 24h change and a live price from Binance's stream;
  **Trade ↗** opens that pair on the
  trading screen. Layout, pairs and timeframes are remembered. **Open in new tab** (or the address `/#charts`) puts the
  screen in its own browser tab or window, for a second monitor. The trading screen keeps running in the background,
  so the chart and indicators keep updating.
- **Screen fit**: the trading screen fits the window (header on one row on wide screens, compact stats strip, chart
  filling what is left, time axis always visible). The chart toolbar has two rows, and the overlays live in an
  **Indicators** menu grouped by Time, Structure and zones, and Indicators.
- **News** (header switch "Trading / Charts / My stocks / News"): the **economic news of the day with the source of every
  story**. The server reads the public RSS feeds of 16 sources: the **Federal Reserve** and the **European Central Bank**
  (official), CNBC (Economy and Finance), MarketWatch, WSJ Markets, Yahoo Finance, the New York Times (Economy and
  Business), BBC Business, The Guardian Economics, Investing.com, FXStreet (forex), OilPrice.com (energy) and CoinDesk and
  Cointelegraph (crypto). Stories are merged, de-duplicated (same title or link), sorted newest first, grouped by your
  calendar day, tagged by topic (central banks, interest rates, inflation, jobs, growth, trade, energy, markets,
  currencies, housing, crypto) and can be filtered by period (today, 3 or 7 days), topic, source and search. "Economy and
  markets only" (on by default) hides the sport, lifestyle and personal-finance stories that general press also runs.
  Every story shows its source and links to the publisher; only the headline and a short plain-text summary are kept. A
  **Sources** panel lists each feed with a status dot, how many stories it gave and how fresh it is, and one feed being down
  never hides the others (its last good stories are kept). The **economic calendar** shows the week's scheduled releases
  and speeches (CPI, jobs, rate decisions...) from the FairEconomy / Forex Factory feed, in your time zone, with impact
  (high / medium / low), forecast and previous value, filterable by impact and currency. Feeds are read at most every 10
  minutes and the page refreshes itself. Open it in its own tab with "Open in new tab" or `/#news`. Sources that were
  tried and not used because they refuse automated requests or have no feed: BLS, IMF, BEA, US Treasury, World Bank.
- **My stocks** (header switch "Trading / My stocks"): your **Binance Stocks** account (US stocks and ETFs such as GLD,
  MRVL, MAGS), which is a *separate product from Spot* with its own API (`/sapi/v1/equity/*`), so these holdings never
  appear in the Spot balance. It exists on the **live** account only: this view always uses your live keys and ignores the
  Testnet / Live switch, and the key needs permission to use Binance Stocks. Binance has **no holdings endpoint** for
  stocks, so holdings are rebuilt from your executed trades (average cost, order fees included in the cost) and valued
  at the live bid; on the author's account the quantities and cost prices match the Binance app exactly. Deposits,
  transfers and corporate actions are not counted. The ticket buys or sells at **market** (buy by amount, sell by
  shares) or **limit** (price with 2 decimals, regular/extended/24h session, day or GTC), in fractions where the stock
  allows, paying from the Main (Spot) or Card wallet in USDC or USDT. Safety: a confirmation with the real-money
  summary, Binance's minimum order value, tradability and fraction rules are checked before anything is sent, and
  **market orders are blocked while bid and ask are more than 3% apart** (the market is closed, a market order could fill
  far from the last price). Binance Stocks offers no stop-loss or take-profit orders, so there is no automatic exit.
  Placing orders has not been run against Binance from here (there is no test order endpoint); start with the smallest
  amount.
  **Own tab:** "Open in new tab" (or the address `/#stocks`) opens My stocks in its own browser tab or window.
  **Research a stock:** search **every ticker Binance Stocks lists (about 7,900 US stocks and ETFs)** by ticker or company
  name ("apple", "gold", "NVDA"), and get an analysis of whether the chart supports buying: a score out of 100 built from
  trend (50 and 200 day averages), momentum (RSI, MACD, 3 and 6 months), relative strength against the S&P 500 ETF, the
  distance from the 52-week high and how stretched price is, risk (volatility, worst fall of the year) and swing
  structure, with the reason for every point, a verdict (favourable / strong but stretched / mixed / unfavourable /
  downtrend), a stop and a 2:1 target, and warnings (thin trading, a big recent move, very volatile). Every holding
  has an **Analyze** button. Binance has no price history for stocks, so daily candles (2 years) come from **Yahoo
  Finance's public chart endpoint**: it is unofficial, keyless and cached, and if it is unreachable the analysis says so
  while search, holdings and orders keep working. The analysis only sees prices: it knows nothing about earnings, news
  or valuation, and it is not advice.
  **Company analysis** (second tab of the same card): the business behind the ticker, from its reported figures (Yahoo
  Finance's fundamentals, fetched with a session cookie and crumb, cached 6 hours). A company gets its own score out of 100
  from growth (revenue, earnings, years of rising revenue), profitability (net and operating margin, return on equity),
  financial health (debt against equity, liquidity, free cash flow, cash against debt), valuation (P/E, PEG) and analysts
  (average target against the price, consensus), each point explained; banks and insurers are not scored on debt or
  liquidity. It also shows the profile (sector, industry, employees, description), the key figures, revenue and profit by
  year, the analysts' target range and rating split, and the next earnings date, with flags for things like losses, cash
  burn, very high debt, heavy short interest, small size, thin analyst coverage and earnings within three weeks. **ETFs and
  funds** are described instead of scored: yearly cost, size, top holdings and concentration, with flags for leveraged or
  inverse funds, commodity funds and high cost. A one-line **combined read** puts the chart and the company side by side
  (agree, strong business in a weak chart, strong chart on weak numbers, and so on). Like the chart analysis it is an
  unofficial data source and only sees published numbers, not the products, competition, management or news; it is not advice.
- **Risk management** (Risk tab, header tile, and the order ticket). Rules are **enforced by the server on every
  order**, so no screen can bypass them, and previewed in the ticket with a one-click "fit size to my limits":
  risk per trade (% of capital lost if the stop fills, fees included, default 1%), max position size (25%), max total
  open risk (3%), minimum reward:risk after fees (1.5), a daily loss limit (3%, UTC day), a losing-streak cooldown
  (3 losses, 60 min), a drawdown halt (10%, with a reset after you review), and a manual **Pause trading** kill
  switch. Capital is your account equity (USDT balance plus money in open positions) or a fixed amount. The tab also
  has a position-size calculator (stop distance to exact size), live meters for each limit, and your results
  (win rate, profit factor, expectancy, max drawdown). Settings are saved in MongoDB. Turning "Enforce limits" off
  disables the limits but never the kill switch. Changing an existing order's entry price is not re-checked.
  Limits reduce risk; they cannot remove it, and past results do not predict future ones.
- **Risk-based ticket setup** (Trade tab, on by default): the order ticket fills in the entry, **stop-loss, take-profit
  and size** from your risk rules. The stop is 1.5x the pair's recent volatility (ATR, between 0.4% and 6%), the target
  earns at least 2x the risk after fees (or your minimum, if higher), and the size is the largest that respects the
  per-trade risk, position size and open-risk limits and the balance you can spend; the card says which limit binds.
  Editing size, stop or target by hand switches Auto off; "Apply to ticket" turns it back on. It also reads Binance's
  **minimum order value** for the pair, and both the ticket and the server refuse orders below it. Switching pair
  clears the previous pair's entry price. Orders already placed keep their original stop and target.
- **Pair picker and ranking** (header): click the pair name to search every tradable USDT pair and compare them by
  price, 24h move, volume and **market cap** (with a bar, and "×47 bigger / smaller than the current pair"). Each
  pair gets a 0-100 **trade score** (liquidity 35%, spread 20%, a 24h range of 2-8% 25%, activity 10%, market-cap size
  10%) and the best three are shown first with the reasons. Pairs with under $1M of 24h volume are listed but not
  scored. Data: live Binance public 24h stats (even in Testnet mode, whose volumes are synthetic; only pairs
  available on Testnet are listed) plus market caps from **CoinGecko's free public API**, cached for 15 minutes
  (the server makes that request; nothing about you is sent). If CoinGecko is unreachable the ranking still works,
  without market caps. The score is a screening aid, not advice or a prediction.
- **Full chart controls** (chart toolbar): **Fit** zooms out to every candle loaded; **All history** pages back through
  every candle Binance has for the pair and timeframe (up to 10,000) and shows them all; **Full screen** expands the
  chart over the whole window (Esc to leave); **Auto** (on by default) keeps the price axis fitted to the visible
  candles *and* your entry / stop-loss / take-profit levels, and turns off manual price stretching. Turn Auto off to
  drag the price axis yourself. Older history also loads by itself when you scroll to the left edge.
- **Days and time zone**: each calendar day is tinted in its own colour (weekends warm) with a "Sat 19" label,
  and the time axis, crosshair and header clock use **your local time zone** (switch to UTC in the chart toolbar).
  Day boundaries are local midnight. Binance candles are UTC, so without this the chart would show UTC.
- **Sessions**: an optional strip on the chart marks Asia / London / London + New York overlap / New York, and the
  Analysis tab lists those sessions in your local time and finds the busiest hours of the day for the current pair
  (from ~40 days of hourly volume). Session hours are approximate (UTC-based, no daylight-saving adjustment).
- **Analysis tab** (right panel): structure summary, indicator readouts, every strategy's current signal, and a
  **Backtest** button per strategy (replays up to 1000 candles with fees, next-candle-open entries, stop-first on
  ambiguous candles). **Use setup** copies a BUY's entry/stop/target into the order ticket; you still press
  "Place automatic order" yourself. Nothing trades automatically.

Signals are judged on the last *closed* candle. `npm test` includes a check that no strategy uses future candles.
Indicators are not advice, and a good backtest does not guarantee future results.

## Database (MongoDB)

Orders, order limits and the Testnet/Live mode are stored in MongoDB when `MONGODB_URI` is set, so they
survive restarts and redeploys on any host, with no Render disk needed. Without `MONGODB_URI` the app falls
back to JSON files under `DATA_DIR`, which is fine locally but is wiped on hosts without a persistent disk.

1. Create a free cluster at https://www.mongodb.com/atlas, then a database user (username + password).
2. **Network Access**: allow the IPs that will connect. For Render, add Render's outbound IP ranges
   (service → Connect → Outbound), or `0.0.0.0/0` if you accept password-only protection.
3. Copy the connection string (`mongodb+srv://USER:PASSWORD@cluster.../`) into `MONGODB_URI`.
   URL-encode special characters in the password.

Collections (database `MONGODB_DB`, default `trading_bot`): `orders` (one document per managed order) and
`settings` (`limits`, `account_mode`). The header shows a **MongoDB** pill when the database is in use.

## Deploy on Render

1. Push this folder to a Git repo. **Never commit `.env`**; only `.env.example` (placeholders) is tracked.
2. Render → **New → Blueprint** → select the repo (uses `render.yaml`; region is Frankfurt).
   If you create the service by hand instead: Root Directory = this folder, Build Command
   `npm install --include=dev && npm run build`, Start Command `npm start`, Health Check `/healthz`,
   env `NODE_VERSION=22`.
3. Fill in the prompted secrets: `MONGODB_URI`, `APP_PASSWORD`, `BINANCE_API_KEY`, `BINANCE_API_SECRET`, and
   (only for live mode) `BINANCE_API_KEY_real`, `BINANCE_API_SECRET_real`.
4. Open the service URL and log in with `APP_USERNAME` / `APP_PASSWORD`.

Things `render.yaml` sets on purpose:

- **Starter plan, not Free.** The monitor must keep running after a limit BUY fills so the
  stop-loss/take-profit OCO is placed. Free services sleep when idle, leaving a filled entry unprotected.
- **Frankfurt region.** Binance rejects US IPs (HTTP 451).
- **`APP_PASSWORD` is mandatory** in production (the server refuses to start without it).
- **Binance live keys need an IP whitelist**, and Render's outbound IPs are shared ranges Binance can't
  whitelist as ranges. See "Live trading and IP whitelisting" below.

## Live trading and IP whitelisting

Binance only accepts single IPs (not CIDR ranges) in an API key's whitelist. Render's shared outbound IPs
are ranges, so live keys with trading enabled need a static IP: Render Dedicated IPs (Pro plan) or a small
VPS. Testnet keys have no IP restriction.

## What changed vs. the Python version

- `python-binance` → a small signed REST client (`server/binance.js`). OCO orders use Binance's current
  `POST /api/v3/orderList/oco` endpoint (verified on Testnet: create + cancel).
- Same routes under `/api/*`, same JSON shapes. CORS removed (same origin).
- Fix: changing an entry price no longer re-buys if the old entry filled in the meantime.
- Not ported: `backtest.py` (CLI script, not used by the dashboard). `SignalPanel`/`SignalLog` components
  were already unused by the app.

## Tests

`npm test` — decimal/tick-size math, strategy signal, the entry→OCO→closed lifecycle against a fake
exchange, restart recovery, and auth/validation on the HTTP layer.
