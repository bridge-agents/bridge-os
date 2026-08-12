#!/usr/bin/env node
// Minimal MCP server over stdio, used to prove the client speaks the protocol.
import { createInterface } from "node:readline";

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  switch (message.method) {
    case "initialize":
      return reply(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      });
    case "tools/list":
      return reply(message.id, {
        tools: [
          {
            name: "echo",
            description: "Echo a message back.",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
          { name: "explode", description: "Always fails." },
        ],
      });
    case "tools/call": {
      const { name, arguments: args } = message.params;
      if (name === "explode") {
        return reply(message.id, { content: [{ type: "text", text: "boom" }], isError: true });
      }
      return reply(message.id, { content: [{ type: "text", text: `echo: ${args.message}` }] });
    }
    default:
      return reply(message.id, {});
  }
});
