import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMisconfiguredServer, fixFor, TOOL_NAMES } from "../../src/misconfigured.js";
import { createServer } from "../../src/server.js";
import { buildDeps } from "../../src/app.js";
import { defaultConfig } from "../../src/config.js";
import { createLogger } from "../../src/log.js";

async function connect(server: { connect: (t: any) => Promise<void> }) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await server.connect(st); await client.connect(ct);
  return client;
}

describe("not-configured mode", () => {
  it("offers the same tool names as a configured server (default settings)", async () => {
    const client = await connect(createServer(buildDeps(defaultConfig(), { log: createLogger("error", false, () => {}) })));
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    await client.close();
  });
  it("puts the problem and fix in the instructions and returns mcp-misconfigured from every tool", async () => {
    const m = { problem: "SUBTITLE_API_KEY_FILE: the file /k does not exist.", fix: fixFor("SUBTITLE_API_KEY_FILE: the file /k does not exist.") };
    const client = await connect(createMisconfiguredServer(m, "0.0.0"));
    expect(client.getInstructions()).toContain(m.problem); expect(client.getInstructions()).toContain("api_keys.txt");
    for (const name of TOOL_NAMES) {
      const r: any = await client.callTool({ name, arguments: { anything: 1 } });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error).toMatchObject({ source: "mcp", code: "mcp-misconfigured" });
      expect(r.content).toEqual([{ type: "text", text: JSON.stringify(r.structuredContent) }]); expect(r.structuredContent.error.detail).toContain("/k does not exist");
    }
    await client.close();
  });
});
