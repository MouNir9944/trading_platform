/**
 * MCP server for the trading platform: lets Claude Desktop, Claude Code or any MCP client look at the platform (prices,
 * analysis, balances, orders, risk, favorites, news, company phase) and, if you allow it, place orders.
 *
 * It is a thin client of the platform's own HTTP API, so it works against this machine or a remote server, and it is
 * held to the same login and the same risk rules as the dashboard.
 *
 *   PLATFORM_URL         where the platform runs, default http://127.0.0.1:8000
 *   APP_USERNAME / APP_PASSWORD   the dashboard login
 *   MCP_ALLOW_TRADING=1  also expose the trading tools (off by default: read-only)
 *   MCP_ALLOW_LIVE=1     allow those tools on the LIVE account (off by default: paper only)
 *
 * Every trading call asks YOU to confirm through the client (MCP elicitation) with a plain sentence saying what will be
 * sent. A client that cannot ask is refused rather than trusted: nothing trades on the model's say-so.
 *
 * Run it as a stdio server:  node server/mcp.js
 */
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { TOOL_BY_NAME, ToolError, executeTool, httpApi, offeredTools } from "./agent/tools.js";

const annotationsFor = (tool) => ({
  title: tool.name.replace(/_/g, " "),
  readOnlyHint: tool.kind === "read",
  destructiveHint: tool.kind === "trade",
  idempotentHint: tool.kind !== "trade",
  openWorldHint: tool.kind === "trade" || tool.name === "get_news",
});

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (message) => ({ isError: true, ...text(message) });

/** Build the server. `api` is `(method, path, body) => json`; `config` is `{ allowTrading, allowLive }`. */
export function createMcpServer({ api, config = {} }) {
  const server = new Server({ name: "trading-platform", version: "1.0.0" }, { capabilities: { tools: {} } });
  const ctx = { api };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: offeredTools(config).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema, annotations: annotationsFor(t) })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      const tool = TOOL_BY_NAME[name];
      let confirmed = false;
      if (tool?.kind === "trade" && offeredTools(config).includes(tool)) {
        if (!server.getClientCapabilities()?.elicitation) {
          throw new ToolError("This MCP client cannot ask for confirmation, so trading tools are unavailable through it. Use the dashboard, or a client that supports confirmations.");
        }
        // Say what is about to happen, then ask. Anything but an explicit yes is a no.
        let answer;
        try {
          answer = await server.elicitInput({
            message: `Confirm this action:\n${tool.describe(args)}`,
            requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Yes, do it" } }, required: ["confirm"] },
          });
        } catch {
          // A malformed or failed answer is a "no", never a "yes".
          return text("Cancelled: the confirmation did not complete, so nothing was sent.");
        }
        if (answer.action !== "accept" || answer.content?.confirm !== true) return text("Cancelled: you did not confirm, so nothing was sent.");
        confirmed = true;
      }
      return text(await executeTool(name, args, ctx, config, { confirmed }));
    } catch (err) {
      return failure(err instanceof ToolError ? err.message : `Something went wrong: ${err.message}`);
    }
  });

  return server;
}

async function main() {
  const env = process.env;
  const api = httpApi({ baseUrl: env.PLATFORM_URL || "http://127.0.0.1:8000", username: env.APP_USERNAME, password: env.APP_PASSWORD });
  const config = { allowTrading: env.MCP_ALLOW_TRADING === "1", allowLive: env.MCP_ALLOW_LIVE === "1" };
  await createMcpServer({ api, config }).connect(new StdioServerTransport());
  // stdout carries the protocol: anything for a human goes to stderr
  console.error(`Trading platform MCP server ready (${env.PLATFORM_URL || "http://127.0.0.1:8000"}, trading ${config.allowTrading ? "ON" : "off"}${config.allowTrading ? `, live ${config.allowLive ? "ON" : "off"}` : ""})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
