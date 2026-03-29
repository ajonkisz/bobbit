/**
 * Unit tests for MCP client HTTP transport enhancements:
 * - Accept header for streamable HTTP (application/json + text/event-stream)
 * - Mcp-Session-Id tracking across requests
 * - SSE response parsing (event: message / data: {...})
 *
 * These tests validate the HTTP transport logic without spawning real MCP servers.
 * They use a local HTTP server to simulate MCP responses.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { McpClient } from "../src/server/mcp/mcp-client.ts";

// Helper: create a local HTTP server that responds to MCP requests
function createMockServer(handler: (req: http.IncomingMessage, body: string) => { status?: number; headers?: Record<string, string>; body: string }): Promise<{ url: string; server: http.Server }> {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			let data = "";
			req.on("data", (chunk) => data += chunk);
			req.on("end", () => {
				const result = handler(req, data);
				const headers = { "Content-Type": "application/json", ...result.headers };
				res.writeHead(result.status || 200, headers);
				res.end(result.body);
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve({ url: `http://127.0.0.1:${addr.port}`, server });
		});
	});
}

let servers: http.Server[] = [];
afterEach(() => {
	for (const s of servers) s.close();
	servers = [];
});

// ---------------------------------------------------------------------------
// Accept header
// ---------------------------------------------------------------------------

describe("MCP client HTTP transport", () => {
	it("sends Accept header with both application/json and text/event-stream", async () => {
		let receivedAccept = "";
		const { url, server } = await createMockServer((req) => {
			receivedAccept = req.headers["accept"] || "";
			return {
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						protocolVersion: "2024-11-05",
						capabilities: {},
						serverInfo: { name: "test", version: "1.0" },
					},
				}),
			};
		});
		servers.push(server);

		const client = new McpClient("test-accept");
		await client.connect({ url });
		assert.ok(receivedAccept.includes("application/json"));
		assert.ok(receivedAccept.includes("text/event-stream"));
		await client.disconnect();
	});

	// ---------------------------------------------------------------------------
	// Session ID tracking
	// ---------------------------------------------------------------------------

	it("captures Mcp-Session-Id from initialize and sends it in subsequent requests", async () => {
		let requestCount = 0;
		let receivedSessionId = "";
		const { url, server } = await createMockServer((req, body) => {
			requestCount++;
			receivedSessionId = req.headers["mcp-session-id"] as string || "";
			const parsed = JSON.parse(body);

			if (parsed.method === "initialize") {
				return {
					headers: { "Mcp-Session-Id": "test-session-42" },
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: parsed.id,
						result: {
							protocolVersion: "2024-11-05",
							capabilities: { tools: {} },
							serverInfo: { name: "test", version: "1.0" },
						},
					}),
				};
			}

			if (parsed.method === "tools/list") {
				return {
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: parsed.id,
						result: { tools: [] },
					}),
				};
			}

			return { body: JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {} }) };
		});
		servers.push(server);

		const client = new McpClient("test-session");
		await client.connect({ url });

		// After initialize, the session ID should be captured.
		// Call listTools which will send a subsequent request.
		await client.listTools();

		// The tools/list request should have included the session ID
		assert.equal(receivedSessionId, "test-session-42");
		assert.ok(requestCount >= 3); // initialize + notification + tools/list
		await client.disconnect();
	});

	// ---------------------------------------------------------------------------
	// SSE response parsing
	// ---------------------------------------------------------------------------

	it("parses SSE-formatted responses (text/event-stream)", async () => {
		const { url, server } = await createMockServer((req, body) => {
			const parsed = JSON.parse(body);

			if (parsed.method === "initialize") {
				// Return SSE format like Graphiti does
				return {
					headers: { "Content-Type": "text/event-stream" },
					body: `event: message\ndata: ${JSON.stringify({
						jsonrpc: "2.0",
						id: parsed.id,
						result: {
							protocolVersion: "2024-11-05",
							capabilities: { tools: {} },
							serverInfo: { name: "graphiti-test", version: "1.0" },
						},
					})}\n\n`,
				};
			}

			if (parsed.method === "tools/list") {
				return {
					headers: { "Content-Type": "text/event-stream" },
					body: `event: message\ndata: ${JSON.stringify({
						jsonrpc: "2.0",
						id: parsed.id,
						result: {
							tools: [{ name: "search", inputSchema: { type: "object" } }],
						},
					})}\n\n`,
				};
			}

			return {
				body: JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {} }),
			};
		});
		servers.push(server);

		const client = new McpClient("test-sse");
		await client.connect({ url });

		const tools = await client.listTools();
		assert.equal(tools.length, 1);
		assert.equal(tools[0].name, "search");
		await client.disconnect();
	});

	it("handles mixed SSE and JSON responses from same server", async () => {
		let callCount = 0;
		const { url, server } = await createMockServer((req, body) => {
			callCount++;
			const parsed = JSON.parse(body);

			// Initialize returns JSON
			if (parsed.method === "initialize") {
				return {
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: parsed.id,
						result: {
							protocolVersion: "2024-11-05",
							capabilities: { tools: {} },
							serverInfo: { name: "mixed", version: "1.0" },
						},
					}),
				};
			}

			// tools/list returns SSE
			if (parsed.method === "tools/list") {
				return {
					headers: { "Content-Type": "text/event-stream" },
					body: `event: message\ndata: ${JSON.stringify({
						jsonrpc: "2.0",
						id: parsed.id,
						result: { tools: [] },
					})}\n\n`,
				};
			}

			return { body: JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {} }) };
		});
		servers.push(server);

		const client = new McpClient("test-mixed");
		await client.connect({ url });
		const tools = await client.listTools();
		assert.deepEqual(tools, []);
		await client.disconnect();
	});
});
