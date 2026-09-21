import { createApp } from "./app.js";
import * as binance from "./binance.js";
import { DATA_DIR } from "./config.js";
import { AutoAmd } from "./autoAmd.js";
import { FuturesManager } from "./futures.js";
import { Notifier } from "./notifier.js";
import { OrderManager } from "./orders.js";
import { createStore } from "./store.js";

const production = process.env.NODE_ENV === "production";
const password = process.env.APP_PASSWORD;

if (production && !password) {
  console.error("APP_PASSWORD is required in production: this dashboard can place real orders.");
  process.exit(1);
}
if (!password) console.warn("APP_PASSWORD is not set - the API is unauthenticated (fine for local dev only).");

let store;
try {
  store = await createStore();
} catch (err) {
  console.error(`Could not connect to the database: ${err.message}`);
  process.exit(1);
}
if (store.kind === "file") {
  console.warn(`MONGODB_URI is not set - orders are stored in files under ${DATA_DIR} (lost on hosts without a persistent disk).`);
}

await binance.initMode(store);
const manager = new OrderManager({
  getClient: binance.getClient,
  getMode: binance.getMode,
  getTradingFee: binance.getTradingFee,
  store,
});
await manager.init();
const futuresManager = new FuturesManager({
  getClient: binance.getFuturesTrader,
  getMode: binance.getMode,
  getRiskSettings: () => manager.getRiskSettings(),
  getLimits: () => manager.getLimits(),
  store,
});
await futuresManager.init();

const notifier = new Notifier({ store });
await notifier.init();
const autoAmd = new AutoAmd({
  store,
  notifier,
  getMode: binance.getMode,
  // the bot reads the same market data its orders will trade against (Testnet prices for Testnet orders)
  getKlines: (market, mode, symbol, interval, limit) =>
    (market === "futures" ? binance.getFuturesTrader(mode) : binance.getClient(mode)).getKlines(symbol, interval, limit),
  managers: { spot: manager, futures: futuresManager },
  getRiskSettings: () => manager.getRiskSettings(),
  getBalance: async (market, mode) => {
    if (market === "futures") {
      const account = await futuresManager.getAccount(mode);
      return { wallet: account.wallet, available: account.available };
    }
    const usdt = (await binance.getAccountBalance(binance.getClient(mode))).find((b) => b.asset === "USDT");
    const free = Number(usdt?.free ?? 0);
    return { wallet: free + Number(usdt?.locked ?? 0), available: free };
  },
});
await autoAmd.init();

const { app } = createApp({
  orderManager: manager,
  futuresManager,
  autoAmd,
  notifier,
  storage: store.kind,
  auth: password ? { username: process.env.APP_USERNAME || "admin", password } : undefined,
});

const port = Number(process.env.PORT || 8000);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Trading dashboard listening on :${port} (storage: ${store.kind})`);
  manager.start();
  futuresManager.start();
  autoAmd.start();
});

async function shutdown() {
  manager.stop();
  futuresManager.stop();
  autoAmd.stop();
  server.close();
  await Promise.race([Promise.all([manager.flush(), futuresManager.flush(), autoAmd.flush(), notifier.flush()]).then(() => store.close()), new Promise((r) => setTimeout(r, 4000))]);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
