/**
 * E2E test to capture the exact event order when a prompt is sent.
 * Goal: understand if there's a window where user message_end can be lost.
 */
import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { readE2EToken, BASE, WS_BASE } from "./e2e-setup.js";

const TOKEN = readE2EToken();

async function createSession(): Promise<string> {
	const resp = await fetch(`${BASE}/api/sessions`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ cwd: process.cwd() }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json() as { id: string };
	return data.id;
}

test("capture event order after prompt", async () => {
	const sessionId = await createSession();
	const ws = new WebSocket(`${WS_BASE}/ws/${sessionId}`);
	const events: any[] = [];
	
	await new Promise<void>((resolve, reject) => {
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
		});
		ws.on("message", (data) => {
			const msg = JSON.parse(data.toString());
			events.push(msg);
			if (msg.type === "auth_ok") resolve();
		});
		ws.on("error", reject);
		setTimeout(() => reject(new Error("timeout")), 10000);
	});
	
	// Clear auth events
	events.length = 0;
	
	// Send prompt
	ws.send(JSON.stringify({ type: "prompt", text: "Say hello" }));
	
	// Collect events for 5 seconds
	await new Promise(r => setTimeout(r, 5000));
	
	// Log the event order
	const eventSummary = events.map(e => {
		if (e.type === "event") {
			const d = e.data;
			if (d.type === "message_end") return `event:message_end(role=${d.message?.role})`;
			if (d.type === "message_start") return `event:message_start(role=${d.message?.role})`;
			if (d.type === "message_update") return `event:message_update(role=${d.message?.role})`;
			return `event:${d.type}`;
		}
		return e.type;
	});
	
	console.log("Event order after prompt:");
	eventSummary.forEach((e, i) => console.log(`  ${i}: ${e}`));
	
	// Verify user message_end appears
	const userMsgEnd = events.find(e => 
		e.type === "event" && e.data?.type === "message_end" && e.data?.message?.role === "user"
	);
	expect(userMsgEnd).toBeTruthy();
	
	// Check: does agent_start come before or after user message_end?
	const agentStartIdx = eventSummary.findIndex(e => e === "event:agent_start");
	const userMsgEndIdx = eventSummary.findIndex(e => e === "event:message_end(role=user)");
	
	console.log(`\nagent_start index: ${agentStartIdx}`);
	console.log(`user message_end index: ${userMsgEndIdx}`);
	console.log(`Order: ${userMsgEndIdx < agentStartIdx ? "user_msg BEFORE agent_start" : "agent_start BEFORE user_msg"}`);
	
	ws.close();
});

test("reconnect race: send get_messages while agent streams, check for user message", async () => {
	const sessionId = await createSession();
	const ws = new WebSocket(`${WS_BASE}/ws/${sessionId}`);
	const events: any[] = [];
	
	await new Promise<void>((resolve, reject) => {
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
		});
		ws.on("message", (data) => {
			const msg = JSON.parse(data.toString());
			events.push(msg);
			if (msg.type === "auth_ok") resolve();
		});
		ws.on("error", reject);
		setTimeout(() => reject(new Error("timeout")), 10000);
	});
	
	events.length = 0;
	
	// Send prompt
	ws.send(JSON.stringify({ type: "prompt", text: "Write a haiku about testing" }));
	
	// Wait for agent to start streaming
	await new Promise<void>((resolve) => {
		const check = setInterval(() => {
			if (events.some(e => e.type === "event" && e.data?.type === "agent_start")) {
				clearInterval(check);
				resolve();
			}
		}, 50);
		setTimeout(() => { clearInterval(check); resolve(); }, 10000);
	});
	
	// Now send get_messages (simulates reconnect requesting message state)
	ws.send(JSON.stringify({ type: "get_messages" }));
	
	// Wait for messages response
	const messagesResponse = await new Promise<any>((resolve) => {
		const handler = (data: any) => {
			const msg = JSON.parse(data.toString());
			if (msg.type === "messages") {
				ws.off("message", handler);
				resolve(msg);
			}
		};
		ws.on("message", handler);
		setTimeout(() => resolve(null), 10000);
	});
	
	expect(messagesResponse).toBeTruthy();
	
	const msgs = Array.isArray(messagesResponse.data) 
		? messagesResponse.data 
		: messagesResponse.data?.messages;
	
	const userMsg = msgs?.find((m: any) => 
		m.role === "user" && Array.isArray(m.content) &&
		m.content.some((c: any) => c.text?.includes("haiku"))
	);
	
	console.log(`\nget_messages during streaming: ${msgs?.length} messages`);
	console.log(`User message present: ${!!userMsg}`);
	
	expect(userMsg).toBeTruthy();
	
	ws.close();
});
