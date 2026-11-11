/** stdio entry point: `pnpm mcp`. Never write to stdout here — it carries the MCP protocol. */
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DB_PATH } from "../config.js";
import { openDb } from "../store/db.js";
import { createServer } from "./server.js";

const server = createServer(() => {
  if (!fs.existsSync(DB_PATH)) throw new Error(`no database at ${DB_PATH} yet — run \`pnpm listen\` and drive some laps`);
  return openDb(DB_PATH, { readonly: true });
});
await server.connect(new StdioServerTransport());
console.error(`forza-telemetry MCP server on stdio (db: ${DB_PATH})`);
