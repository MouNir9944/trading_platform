/**
 * Persistence for orders and settings. Two interchangeable backends:
 *  - MongoStore: used when MONGODB_URI is set (e.g. MongoDB Atlas). Survives redeploys on any host.
 *  - FileStore:  JSON files in DATA_DIR; the local-dev fallback. Ephemeral on hosts without a disk.
 *
 * Interface: init(), loadOrders(), saveOrder(order), removeOrders(ids), getSetting(key), setSetting(key, value), close().
 * Settings used: "limits" ({max_open_orders, max_daily_orders}) and "account_mode" ("testnet" | "live").
 */
import fs from "node:fs";
import path from "node:path";

import { MongoClient } from "mongodb";

import { dataPath, writeFileSafe } from "./config.js";

export class FileStore {
  kind = "file";

  constructor({ dir } = {}) {
    const file = (name) => (dir ? path.join(dir, name) : dataPath(name));
    this.ordersFile = file("orders.json");
    this.limitsFile = file("order_limits.json");
    this.modeFile = file("account_mode.txt");
    this.riskFile = file("risk_settings.json");
    this.extraFile = file("settings_extra.json"); // every other setting (bot config, notifications, ...)
    this.orders = new Map();
  }

  async init() {
    fs.mkdirSync(path.dirname(this.ordersFile), { recursive: true });
  }

  async loadOrders() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.ordersFile, "utf-8"));
      this.orders = new Map(saved.map((order) => [order.id, order]));
    } catch {
      this.orders = new Map();
    }
    return [...this.orders.values()].map((order) => ({ ...order }));
  }

  async saveOrder(order) {
    this.orders.set(order.id, { ...order });
    this.#flush();
  }

  async removeOrders(ids) {
    for (const id of ids) this.orders.delete(id);
    this.#flush();
  }

  async getSetting(key) {
    try {
      if (key === "account_mode") return fs.readFileSync(this.modeFile, "utf-8").trim().toLowerCase();
      if (key === "limits") return JSON.parse(fs.readFileSync(this.limitsFile, "utf-8"));
      if (key === "risk") return JSON.parse(fs.readFileSync(this.riskFile, "utf-8"));
      return JSON.parse(fs.readFileSync(this.extraFile, "utf-8"))[key] ?? null;
    } catch {
      /* not saved yet */
    }
    return null;
  }

  async setSetting(key, value) {
    if (key === "account_mode") writeFileSafe(this.modeFile, String(value));
    else if (key === "limits") writeFileSafe(this.limitsFile, JSON.stringify(value, null, 2));
    else if (key === "risk") writeFileSafe(this.riskFile, JSON.stringify(value, null, 2));
    else {
      let all = {};
      try { all = JSON.parse(fs.readFileSync(this.extraFile, "utf-8")); } catch { /* first setting */ }
      all[key] = value;
      writeFileSafe(this.extraFile, JSON.stringify(all, null, 2));
    }
  }

  async close() {}

  #flush() {
    writeFileSafe(this.ordersFile, JSON.stringify([...this.orders.values()], null, 2));
  }
}

export class MongoStore {
  kind = "mongodb";

  constructor({ uri, dbName = "trading_bot" }) {
    this.uri = uri;
    this.dbName = dbName;
  }

  async init() {
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 10_000 });
    await this.client.connect();
    const db = this.client.db(this.dbName);
    this.orders = db.collection("orders");
    this.settings = db.collection("settings");
    await this.orders.createIndex({ account_mode: 1, created_at: -1 });
  }

  async loadOrders() {
    const docs = await this.orders.find({}).toArray();
    return docs.map(({ _id, ...order }) => ({ ...order, id: order.id ?? _id }));
  }

  async saveOrder(order) {
    await this.orders.replaceOne({ _id: order.id }, { ...order, _id: order.id }, { upsert: true });
  }

  async removeOrders(ids) {
    if (ids.length) await this.orders.deleteMany({ _id: { $in: ids } });
  }

  async getSetting(key) {
    const doc = await this.settings.findOne({ _id: key });
    return doc ? doc.value : null;
  }

  async setSetting(key, value) {
    await this.settings.replaceOne({ _id: key }, { _id: key, value }, { upsert: true });
  }

  async close() {
    await this.client?.close();
  }
}

/** Pick the backend from the environment and connect it. */
export async function createStore(env = process.env) {
  const store = env.MONGODB_URI
    ? new MongoStore({ uri: env.MONGODB_URI, dbName: env.MONGODB_DB || "trading_bot" })
    : new FileStore();
  await store.init();
  return store;
}
