/**
 * Unit tests for MCP proxy extension generation (tool-activation.ts)
 * and the OpenMemory REST bridge (openmemory-mcp-bridge.mjs).
 *
 * Tests cover:
 * - Proxy extension code generation with try/catch wrapping
 * - Error handling (network errors resolve, not reject)
 * - Response parsing for MCP content blocks
 * - Fallback to "(no results)" for empty responses
 * - OpenMemory bridge JSON-RPC protocol
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateMcpProxyExtension } from "../src/server/agent/tool-activation.ts";

// ---------------------------------------------------------------------------
// generateMcpProxyExtension
// ---------------------------------------------------------------------------

describe("generateMcpProxyExtension", () => {
	const sampleTools = [
		{
			name: "search_memory",
			description: "Search memories",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
			},
		},
		{
			name: "add_memories",
			description: "Add a memory",
			inputSchema: {
				type: "object",
				properties: {
					text: { type: "string" },
					infer: { type: "boolean" },
				},
				required: ["text"],
			},
		},
	];

	it("generates valid JavaScript with tool registrations", () => {
		const code = generateMcpProxyExtension("memory", sampleTools);
		assert.ok(code.includes("export default function(pi)"));
		assert.ok(code.includes('pi.registerTool('));
		assert.ok(code.includes('"mcp__memory__search_memory"'));
		assert.ok(code.includes('"mcp__memory__add_memories"'));
	});

	it("wraps execute body in try/catch", () => {
		const code = generateMcpProxyExtension("memory", sampleTools);
		assert.ok(code.includes("execute: async (args) => {"));
		assert.ok(code.includes("try {"));
		assert.ok(code.includes("} catch (err) {"));
		assert.ok(code.includes('return "MCP tool error: "'));
	});

	it("resolves network errors instead of rejecting", () => {
		const code = generateMcpProxyExtension("memory", sampleTools);
		// Should NOT have: req.on("error", reject)
		assert.ok(!code.includes('"error", reject'));
		// Should have: req.on("error", (err) => resolve(...))
		assert.ok(code.includes('"error", (err) => resolve('));
		assert.ok(code.includes("MCP call error:"));
	});

	it("falls back to '(no results)' for empty text", () => {
		const code = generateMcpProxyExtension("memory", sampleTools);
		assert.ok(code.includes('return text || "(no results)"'));
	});

	it("reads gateway-url and token from BOBBIT_DIR", () => {
		const code = generateMcpProxyExtension("memory", sampleTools);
		assert.ok(code.includes('process.env.BOBBIT_DIR'));
		assert.ok(code.includes('"state", "gateway-url"'));
		assert.ok(code.includes('"state", "token"'));
	});

	it("sends Accept header for SSE compatibility", () => {
		// The extension itself doesn't set Accept (that's in mcp-client.ts),
		// but it does set Authorization and Content-Type
		const code = generateMcpProxyExtension("memory", sampleTools);
		assert.ok(code.includes('"Authorization": "Bearer "'));
		assert.ok(code.includes('"Content-Type": "application/json"'));
	});

	it("generates correct TypeBox schema from JSON Schema", () => {
		const code = generateMcpProxyExtension("memory", sampleTools);
		// search_memory: query is required string
		assert.ok(code.includes("Type.String()"));
		// add_memories: infer is optional boolean
		assert.ok(code.includes("Type.Optional(Type.Boolean())"));
	});

	it("handles tools with no description", () => {
		const tools = [
			{
				name: "test_tool",
				inputSchema: { type: "object", properties: {} },
			},
		];
		const code = generateMcpProxyExtension("srv", tools);
		assert.ok(code.includes('"MCP tool test_tool from srv"'));
	});

	it("handles empty tools array", () => {
		const code = generateMcpProxyExtension("empty", []);
		assert.ok(code.includes("export default function(pi)"));
		assert.ok(!code.includes("pi.registerTool"));
	});

	it("properly escapes server and tool names in JSON", () => {
		const tools = [
			{
				name: "tool-with-dashes",
				description: 'Has "quotes" and \\backslashes',
				inputSchema: { type: "object", properties: {} },
			},
		];
		const code = generateMcpProxyExtension("my-server", tools);
		assert.ok(code.includes('"mcp__my-server__tool-with-dashes"'));
		// Description should be properly JSON-escaped
		assert.ok(code.includes('\\"quotes\\"'));
	});
});

// ---------------------------------------------------------------------------
// MCP response parsing logic (extracted from generated code for testing)
// ---------------------------------------------------------------------------

describe("MCP proxy response parsing", () => {
	// Simulate the response parsing logic from the generated extension
	function parseProxyResponse(r: unknown): string {
		let text: string | undefined;
		const result = r as any;
		if (result && result.content && Array.isArray(result.content)) {
			text = result.content.map((c: any) => c.text || "").join("\n");
		} else if (result && result.error) {
			text = "Error: " + result.error;
		} else {
			text = JSON.stringify(result);
		}
		return text || "(no results)";
	}

	it("parses standard MCP content response", () => {
		const r = { content: [{ type: "text", text: "Hello world" }] };
		assert.equal(parseProxyResponse(r), "Hello world");
	});

	it("joins multiple content blocks", () => {
		const r = {
			content: [
				{ type: "text", text: "Line 1" },
				{ type: "text", text: "Line 2" },
			],
		};
		assert.equal(parseProxyResponse(r), "Line 1\nLine 2");
	});

	it("returns '(no results)' for empty content array", () => {
		const r = { content: [] };
		assert.equal(parseProxyResponse(r), "(no results)");
	});

	it("returns '(no results)' for content with empty text", () => {
		const r = { content: [{ type: "text", text: "" }] };
		assert.equal(parseProxyResponse(r), "(no results)");
	});

	it("handles error response", () => {
		const r = { error: "Something went wrong" };
		assert.equal(parseProxyResponse(r), "Error: Something went wrong");
	});

	it("handles null/undefined", () => {
		assert.equal(parseProxyResponse(null), "null");
		assert.equal(parseProxyResponse(undefined), "(no results)");
	});

	it("handles non-MCP JSON response", () => {
		const r = { status: "ok", data: [1, 2, 3] };
		assert.equal(parseProxyResponse(r), JSON.stringify(r));
	});

	it("handles content with mixed types (image + text)", () => {
		const r = {
			content: [
				{ type: "image", data: "base64..." },
				{ type: "text", text: "Caption" },
			],
		};
		// Image has no .text, falls back to ""
		assert.equal(parseProxyResponse(r), "\nCaption");
	});
});
