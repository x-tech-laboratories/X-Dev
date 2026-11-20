#!/usr/bin/env node
// Stands in for claude -p in the runner's tests: reads the run's input, does what words in it ask, and answers in
// stream-json as Claude Code does.

import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const input = readFileSync(0, "utf8");
const option = (name) => argv[argv.indexOf(name) + 1];

function say(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Calls one of the run's X-Dev tools over its MCP config, as the agent would.
async function tool(name, args) {
  const config = JSON.parse(readFileSync(option("--mcp-config"), "utf8")).mcpServers["x-dev-run"];
  const response = await fetch(config.url, {
    method: "POST",
    headers: { ...config.headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  const data = /^data: (.+)$/m.exec(text)?.[1] ?? text;
  return JSON.parse(data).result;
}

const report = (next) => `Done.\n\n## Plan handoff\n**Next:** ${next}\n**Done:** - planned\n**Decisions:** none\n**Work:** none\n**Open questions:** None\n**Brief for next stage:** build it`;

say({ type: "system", subtype: "init", session_id: option("--session-id") ?? option("--resume") });
say({ type: "assistant", message: { content: [{ type: "text", text: "Reading the item." }, { type: "tool_use", name: "Bash", input: { command: "git status" } }] } });

if (input.includes("WRITE-FILE")) writeFileSync("made-by-run.txt", "made\n");
if (input.includes("STATUS")) await tool("update_item_status", { changes: { current_state: "Planned by the fake agent." } });
if (input.includes("PROPOSE")) {
  for (const title of ["Faster board drawing", "Another idea entirely", "A third proposal here", "A fourth proposal now"]) {
    const result = await tool("propose_item", { title, why: "It came up." });
    say({ type: "assistant", message: { content: [{ type: "text", text: result.content[0].text }] } });
  }
}

let text;
if (input.includes("The user answered")) text = report("implement");
else if (input.includes("ASK")) {
  await tool("ask_user", { questions: [{ question: "Which board layout?", why: "It changes the plan.", choices: ["Lanes", "Columns"] }] });
  text = "Waiting for the user.";
} else if (input.includes("NO-REPORT")) text = "I forgot the report.";
else if (input.includes("SLOW")) {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  text = report("specify");
} else text = report("specify");

say({ type: "result", subtype: "success", result: text, is_error: false, total_cost_usd: 0.25, session_id: option("--session-id") ?? option("--resume") });
