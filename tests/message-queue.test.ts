/**
 * Tests for the message queue state machine.
 *
 * Run with: npx tsx --test tests/message-queue.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MessageQueue, type MessageQueueStorage } from "../src/ui/components/message-queue.js";

/** In-memory storage that mimics sessionStorage */
class MockStorage implements MessageQueueStorage {
	private data = new Map<string, string>();
	getItem(key: string) { return this.data.get(key) ?? null; }
	setItem(key: string, value: string) { this.data.set(key, value); }
	removeItem(key: string) { this.data.delete(key); }
	/** Peek at raw stored value */
	raw(key: string) { return this.data.get(key); }
}

describe("MessageQueue", () => {
	const KEY = "bobbit_queue_test-session";
	let storage: MockStorage;
	let queue: MessageQueue;

	beforeEach(() => {
		storage = new MockStorage();
		queue = new MessageQueue(KEY, storage);
	});

	// ── Basic enqueue / dequeue ──

	it("starts empty", () => {
		assert.equal(queue.length, 0);
		assert.deepEqual(queue.messages, []);
	});

	it("enqueue adds a message with auto-incremented id", () => {
		const m1 = queue.enqueue("hello");
		const m2 = queue.enqueue("world");
		assert.equal(queue.length, 2);
		assert.equal(m1.id, "q_1");
		assert.equal(m2.id, "q_2");
		assert.equal(m1.text, "hello");
		assert.equal(m2.text, "world");
		assert.equal(m1.steered, undefined);
	});

	it("enqueue persists to storage", () => {
		queue.enqueue("persisted");
		const raw = storage.raw(KEY);
		assert.ok(raw);
		const parsed = JSON.parse(raw!);
		assert.equal(parsed.length, 1);
		assert.equal(parsed[0].text, "persisted");
	});

	it("enqueue strips empty attachments", () => {
		const m = queue.enqueue("no attach", []);
		assert.equal(m.attachments, undefined);
	});

	it("enqueue preserves non-empty attachments", () => {
		const m = queue.enqueue("with attach", [{ id: "a1" }]);
		assert.deepEqual(m.attachments, [{ id: "a1" }]);
	});

	// ── Remove ──

	it("remove deletes a message by id", () => {
		queue.enqueue("keep");
		const m2 = queue.enqueue("remove me");
		queue.enqueue("also keep");

		queue.remove(m2.id);
		assert.equal(queue.length, 2);
		assert.ok(queue.messages.every((m) => m.id !== m2.id));
	});

	it("remove updates storage", () => {
		const m = queue.enqueue("bye");
		queue.remove(m.id);
		assert.equal(storage.raw(KEY), undefined); // empty queue removes key
	});

	// ── Steer ──

	it("steer marks a message as steered", () => {
		const m = queue.enqueue("steer me");
		const steered = queue.steer(m.id);

		assert.ok(steered);
		assert.equal(steered!.steered, true);
		assert.equal(steered!.text, "steer me");
		assert.equal(queue.messages[0].steered, true);
	});

	it("steer persists steered flag to storage", () => {
		const m = queue.enqueue("steer me");
		queue.steer(m.id);

		const parsed = JSON.parse(storage.raw(KEY)!);
		assert.equal(parsed[0].steered, true);
	});

	it("steer on non-existent id returns undefined", () => {
		queue.enqueue("exists");
		const result = queue.steer("q_999");
		assert.equal(result, undefined);
	});

	// ── Drain ──

	it("drain returns non-steered messages and clears queue", () => {
		queue.enqueue("pending 1");
		const m2 = queue.enqueue("steered");
		queue.enqueue("pending 2");
		queue.steer(m2.id);

		const drained = queue.drain();

		assert.equal(drained.length, 2);
		assert.equal(drained[0].text, "pending 1");
		assert.equal(drained[1].text, "pending 2");
		assert.equal(queue.length, 0);
	});

	it("drain clears storage", () => {
		queue.enqueue("msg");
		queue.drain();
		assert.equal(storage.raw(KEY), undefined);
	});

	it("drain with only steered messages returns empty array", () => {
		const m = queue.enqueue("steered only");
		queue.steer(m.id);

		const drained = queue.drain();
		assert.equal(drained.length, 0);
		assert.equal(queue.length, 0);
	});

	// ── handleEvent ──

	it("handleEvent agent_end returns drain", () => {
		assert.equal(queue.handleEvent("agent_end"), "drain");
	});

	it("handleEvent other events return none", () => {
		assert.equal(queue.handleEvent("message_start"), "none");
		assert.equal(queue.handleEvent("agent_start"), "none");
		assert.equal(queue.handleEvent("message_update"), "none");
		assert.equal(queue.handleEvent("turn_start"), "none");
	});

	// ── Restore ──

	it("restore loads non-steered messages from storage", () => {
		// Seed storage with a mix of steered and non-steered
		storage.setItem(KEY, JSON.stringify([
			{ id: "q_1", text: "pending" },
			{ id: "q_2", text: "was steered", steered: true },
			{ id: "q_3", text: "also pending" },
		]));

		queue.restore();

		assert.equal(queue.length, 2);
		assert.equal(queue.messages[0].text, "pending");
		assert.equal(queue.messages[1].text, "also pending");
	});

	it("restore filters out steered messages and updates storage", () => {
		storage.setItem(KEY, JSON.stringify([
			{ id: "q_1", text: "steered", steered: true },
		]));

		queue.restore();

		assert.equal(queue.length, 0);
		// Storage should be cleaned up too
		assert.equal(storage.raw(KEY), undefined);
	});

	it("restore continues id counter from stored messages", () => {
		storage.setItem(KEY, JSON.stringify([
			{ id: "q_5", text: "old msg" },
		]));

		queue.restore();
		const m = queue.enqueue("new msg");

		// Should be q_6, not q_1
		assert.equal(m.id, "q_6");
	});

	it("restore with invalid JSON is a no-op", () => {
		storage.setItem(KEY, "not json{{{");
		queue.restore();
		assert.equal(queue.length, 0);
	});

	it("restore with no storage key is a no-op", () => {
		const noKeyQueue = new MessageQueue(undefined, storage);
		noKeyQueue.restore(); // should not throw
		assert.equal(noKeyQueue.length, 0);
	});

	// ── Full scenario: steer lifecycle ──

	describe("steer lifecycle", () => {
		it("steered message persists through queue updates until agent_end drains", () => {
			// User queues a message while agent is busy
			const m1 = queue.enqueue("fix the bug");

			// User clicks Steer
			queue.steer(m1.id);
			assert.equal(queue.messages[0].steered, true);
			assert.equal(queue.length, 1);

			// User queues another message
			queue.enqueue("also do this");
			assert.equal(queue.length, 2);

			// Agent still running — steered message stays
			queue.handleEvent("message_start");
			assert.equal(queue.length, 2);
			assert.equal(queue.messages[0].steered, true);

			// Agent ends turn — drain clears everything
			const action = queue.handleEvent("agent_end");
			assert.equal(action, "drain");
			const drained = queue.drain();
			assert.equal(drained.length, 1);
			assert.equal(drained[0].text, "also do this");
			assert.equal(queue.length, 0);
		});

		it("steered message does NOT survive page reload", () => {
			const m = queue.enqueue("steer me");
			queue.steer(m.id);

			// Simulate page reload — new queue instance, same storage
			const queue2 = new MessageQueue(KEY, storage);
			queue2.restore();

			// Steered message should be gone
			assert.equal(queue2.length, 0);
		});

		it("non-steered messages DO survive page reload", () => {
			queue.enqueue("pending 1");
			queue.enqueue("pending 2");

			const queue2 = new MessageQueue(KEY, storage);
			queue2.restore();

			assert.equal(queue2.length, 2);
			assert.equal(queue2.messages[0].text, "pending 1");
			assert.equal(queue2.messages[1].text, "pending 2");
		});

		it("mixed steered/pending survives reload correctly", () => {
			queue.enqueue("pending");
			const m2 = queue.enqueue("steered");
			queue.enqueue("also pending");
			queue.steer(m2.id);

			const queue2 = new MessageQueue(KEY, storage);
			queue2.restore();

			assert.equal(queue2.length, 2);
			assert.equal(queue2.messages[0].text, "pending");
			assert.equal(queue2.messages[1].text, "also pending");
		});
	});

	// ── No storage ──

	it("works without storage (no persistence)", () => {
		const ephemeral = new MessageQueue();
		ephemeral.enqueue("msg");
		assert.equal(ephemeral.length, 1);
		ephemeral.drain();
		assert.equal(ephemeral.length, 0);
	});
});
