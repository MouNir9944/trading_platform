# Trading Bot Dashboard — single Node service

The React dashboard and the API now run as **one Node service**. The Python/FastAPI backend was
ported to JavaScript, so there is one build, one process and one Render service.

```
server/   Express API + order monitor (port of main.py, binance_client.py, strategy.py,
          risk_manager.py, trade_executor.py)
src/      React app (Vite) — unchanged UI, same /api/* calls
dist/     Production build, served by Express
data/     orders.json, order_limits.json, account_mode.txt (runtime state; DATA_DIR)
```

## Run locally

```bash
npm install
cp .env.example .env      # fill in your Testnet keys; loaded automatically via --env-file
npm run dev               # API on :8000, Vite on :5173 (open http://localhost:5173)
```

Production-style run: `npm run build && npm start` (set `NODE_ENV=production` and `APP_PASSWORD` to mirror Render).

## Deploy on Render

1. Push this folder to a Git repo.
2. Render → **New → Blueprint** → select the repo (uses `render.yaml`).
3. Fill in the prompted secrets: `APP_PASSWORD`, `BINANCE_API_KEY`, `BINANCE_API_SECRET`, and
   (only if you want live mode) `BINANCE_API_KEY_real`, `BINANCE_API_SECRET_real`.
4. Open the service URL and log in with `APP_USERNAME` / `APP_PASSWORD`.

Things `render.yaml` sets on purpose:

- **Starter plan, not Free.** The monitor must keep running after a limit BUY fills so the
  stop-loss/take-profit OCO is placed. Free services sleep when idle, leaving a filled entry unprotected.
- **Persistent disk at `/var/data`** (`DATA_DIR`). Without it, `orders.json` is wiped on every deploy and
  the monitor forgets open positions.
- **`APP_PASSWORD` is mandatory** in production (the server refuses to start without it). The old app had
  open CORS and no auth; a public URL that can place live orders must not.

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
