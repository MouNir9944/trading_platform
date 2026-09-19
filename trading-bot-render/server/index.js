import { createApp } from "./app.js";
import { DATA_DIR } from "./config.js";

const production = process.env.NODE_ENV === "production";
const password = process.env.APP_PASSWORD;

if (production && !password) {
  console.error("APP_PASSWORD is required in production: this dashboard can place real orders.");
  process.exit(1);
}
if (!password) console.warn("APP_PASSWORD is not set - the API is unauthenticated (fine for local dev only).");

const { app, manager } = createApp({
  auth: password ? { username: process.env.APP_USERNAME || "admin", password } : undefined,
});

const port = Number(process.env.PORT || 8000);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Trading dashboard listening on :${port} (data dir: ${DATA_DIR})`);
  manager.start();
});

function shutdown() {
  manager.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
