import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "./mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ORDER = { symbol: "XLMUSDT", entry_price: 0.2, capital_usdt: 50, stop_loss_price: 0.19, take_profit_price: 0.23 };

function fakePlatform(mode = { mode: "paper", paper: true }) {
  const calls = [];
  const api = async (method, p, body) => {
    calls.push({ method, path: p, body });
    if (p.startsWith("/api/market/price")) return { symbol: "BTCUSDT", price: 61000 };
    if (p === "/api/account/mode") return mode;
    if (p === "/api/orders/conditional") return { id: "order1" };
    throw new Error(`unexpected ${method} ${p}`);
  };
  return { api, calls };
}

/** Connect a real MCP client to the server in-process. `confirm` answers confirmation requests (or undefined = client cannot). */
async function connect({ api, config, confirm }) {
  const server = createMcpServer({ api, config });
  const client = new Client({ name: "test", version: "1" }, { capabilities: confirm ? { elicitation: {} } : {} });
  const asked = [];
  if (confirm) client.setRequestHandler(ElicitRequestSchema, async (req) => { asked.push(req.params.message); return confirm; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, asked, close: () => Promise.all([client.close(), server.close()]) };
}
const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("by default only read and favorites tools are listed, with honest annotations", async () => {
  const { client, close } = await connect({ ...fakePlatform(), config: {} });
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("get_price") && names.includes("analyze_symbol") && names.includes("add_favorite"));
    assert.ok(!names.some((n) => /place_|cancel_|close_/.test(n)), "no trading tools without MCP_ALLOW_TRADING");
    assert.equal(tools.find((t) => t.name === "get_price").annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === "add_favorite").annotations.readOnlyHint, false);
    assert.equal(tools.find((t) => t.name === "get_price").inputSchema.required[0], "symbol");
  } finally { await close(); }
});

test("a read tool call returns the platform's data as text", async () => {
  const platform = fakePlatform();
  const { client, close } = await connect({ ...platform, config: {} });
  try {
    const r = await client.callTool({ name: "get_price", arguments: { symbol: "btcusdt" } });
    assert.notEqual(r.isError, true);
    assert.deepEqual(JSON.parse(textOf(r)), { symbol: "BTCUSDT", price: 61000 });
  } finally { await close(); }
});

test("bad arguments and unknown tools come back as tool errors, not crashes", async () => {
  const { client, close } = await connect({ ...fakePlatform(), config: {} });
  try {
    const bad = await client.callTool({ name: "get_price", arguments: { symbol: "BTC/USDT" } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /Invalid arguments/);
    const unknown = await client.callTool({ name: "place_spot_order", arguments: ORDER });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /Unknown or disabled/);
  } finally { await close(); }
});

test("trading tools appear only when enabled, and each order asks the user first", async () => {
  const platform = fakePlatform();
  const { client, asked, close } = await connect({ ...platform, config: { allowTrading: true }, confirm: { action: "accept", content: { confirm: true } } });
  try {
    assert.ok((await client.listTools()).tools.some((t) => t.name === "place_spot_order"));
    const r = await client.callTool({ name: "place_spot_order", arguments: ORDER });
    assert.notEqual(r.isError, true);
    assert.deepEqual(JSON.parse(textOf(r)), { id: "order1" });
    assert.equal(asked.length, 1);
    assert.match(asked[0], /Spot BUY XLMUSDT.*0\.2.*50 USDT/);
    assert.ok(platform.calls.some((c) => c.path === "/api/orders/conditional"));
  } finally { await close(); }
});

test("declining, cancelling or ticking 'no' sends nothing", async () => {
  for (const answer of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { confirm: false } }, { action: "accept", content: {} }]) {
    const platform = fakePlatform();
    const { client, close } = await connect({ ...platform, config: { allowTrading: true }, confirm: answer });
    try {
      const r = await client.callTool({ name: "place_spot_order", arguments: ORDER });
      assert.match(textOf(r), /Cancelled/);
      assert.ok(!platform.calls.some((c) => c.method === "POST"), `nothing sent for ${JSON.stringify(answer)}`);
    } finally { await close(); }
  }
});

test("a client that cannot ask for confirmation is refused, not trusted", async () => {
  const platform = fakePlatform();
  const { client, close } = await connect({ ...platform, config: { allowTrading: true } });
  try {
    const r = await client.callTool({ name: "place_spot_order", arguments: ORDER });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /cannot ask for confirmation/);
    assert.equal(platform.calls.length, 0);
  } finally { await close(); }
});

test("a confirmed order on the LIVE account is still refused unless live trading is allowed", async () => {
  const platform = fakePlatform({ mode: "live", paper: false });
  const { client, close } = await connect({ ...platform, config: { allowTrading: true }, confirm: { action: "accept", content: { confirm: true } } });
  try {
    const r = await client.callTool({ name: "place_spot_order", arguments: ORDER });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /LIVE account/);
    assert.ok(!platform.calls.some((c) => c.method === "POST"));
  } finally { await close(); }
});

test("the real stdio entry point starts, lists tools and answers a call against a platform over HTTP", async () => {
  const seen = [];
  const platform = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url.startsWith("/api/market/price") ? { symbol: "ETHUSDT", price: 3100 } : {}));
  });
  await new Promise((r) => platform.listen(0, "127.0.0.1", r));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "mcp.js")],
    env: { ...process.env, PLATFORM_URL: `http://127.0.0.1:${platform.address().port}`, APP_USERNAME: "admin", APP_PASSWORD: "pw", MCP_ALLOW_TRADING: "" },
    stderr: "ignore",
  });
  const client = new Client({ name: "stdio-test", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 10);
    assert.ok(!tools.some((t) => t.name === "place_spot_order"));
    const r = await client.callTool({ name: "get_price", arguments: { symbol: "ETHUSDT" } });
    assert.equal(JSON.parse(textOf(r)).price, 3100);
    assert.equal(seen[0].auth, `Basic ${Buffer.from("admin:pw").toString("base64")}`, "the dashboard login is sent");
  } finally {
    await client.close();
    platform.close();
  }
});
