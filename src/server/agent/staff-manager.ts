import { randomUUID } from "node:crypto";
import { StaffStore, type PersistedStaff, type StaffState, type StaffTrigger } from "./staff-store.js";
import type { SessionManager } from "./session-manager.js";

export class StaffManager {
	private store = new StaffStore();

	createStaff(
		name: string,
		description: string,
		systemPrompt: string,
		cwd: string,
		opts?: { triggers?: StaffTrigger[]; roleId?: string },
	): PersistedStaff {
		const now = Date.now();
		const id = randomUUID();

		// Auto-assign UUIDs to triggers missing IDs
		const triggers = (opts?.triggers ?? []).map((t) => ({
			...t,
			id: t.id || randomUUID(),
		}));

		const staff: PersistedStaff = {
			id,
			name,
			description,
			systemPrompt,
			cwd,
			state: "active",
			triggers,
			memory: "",
			roleId: opts?.roleId,
			createdAt: now,
			updatedAt: now,
		};
		this.store.put(staff);
		return staff;
	}

	getStaff(id: string): PersistedStaff | undefined {
		return this.store.get(id);
	}

	listStaff(): PersistedStaff[] {
		return this.store.getAll();
	}

	updateStaff(
		id: string,
		updates: {
			name?: string;
			description?: string;
			systemPrompt?: string;
			cwd?: string;
			state?: StaffState;
			triggers?: StaffTrigger[];
			memory?: string;
			roleId?: string;
			currentSessionId?: string;
		},
	): boolean {
		// Auto-assign UUIDs to triggers missing IDs
		if (updates.triggers) {
			updates.triggers = updates.triggers.map((t) => ({
				...t,
				id: t.id || randomUUID(),
			}));
		}
		return this.store.update(id, updates);
	}

	deleteStaff(id: string): boolean {
		const staff = this.store.get(id);
		if (!staff) return false;
		this.store.remove(id);
		return true;
	}

	/**
	 * Update a specific trigger's runtime state (lastFired, lastSeenSha).
	 */
	updateTriggerState(
		staffId: string,
		triggerId: string,
		updates: { lastFired?: number; lastSeenSha?: string },
	): boolean {
		const staff = this.store.get(staffId);
		if (!staff) return false;

		const trigger = staff.triggers.find((t) => t.id === triggerId);
		if (!trigger) return false;

		if (updates.lastFired !== undefined) trigger.lastFired = updates.lastFired;
		if (updates.lastSeenSha !== undefined) trigger.lastSeenSha = updates.lastSeenSha;

		this.store.update(staffId, { triggers: staff.triggers });
		return true;
	}

	/**
	 * Wake a staff agent: create a new session with the staff's system prompt + memory,
	 * enqueue the prompt, and track the session.
	 */
	async wake(
		staffId: string,
		prompt: string | undefined,
		sessionManager: SessionManager,
	): Promise<string> {
		const staff = this.store.get(staffId);
		if (!staff) throw new Error("Staff agent not found");
		if (staff.state !== "active") throw new Error(`Staff agent is ${staff.state}, cannot wake`);

		// Build system prompt: staff's base prompt + memory context
		let fullPrompt = staff.systemPrompt;
		if (staff.memory) {
			fullPrompt += "\n\n---\n\n## Memory (persistent context from prior sessions)\n\n" + staff.memory;
		}

		// Create session with staff's system prompt injected as goal spec
		const session = await sessionManager.createSession(staff.cwd, undefined, undefined, undefined, {
			rolePrompt: fullPrompt,
			env: { BOBBIT_STAFF_ID: staffId },
		});

		// Mark the session as belonging to this staff agent
		session.staffId = staffId;
		sessionManager.persistSessionMetadata(session).catch((err: any) => {
			console.error(`[staff-manager] Failed to persist staff session metadata for ${session.id}:`, err);
		});

		// Update staff state
		this.store.update(staffId, {
			lastWakeAt: Date.now(),
			currentSessionId: session.id,
		});

		// Enqueue the wake prompt
		const wakePrompt = prompt || "You have been woken. Review your memory and carry out your mission.";
		await sessionManager.enqueuePrompt(session.id, wakePrompt);

		console.log(`[staff-manager] Woke staff "${staff.name}" (${staffId}) → session ${session.id}`);
		return session.id;
	}

	/**
	 * Get all sessions belonging to a staff agent.
	 */
	getSessionsByStaffId(staffId: string, sessionManager: SessionManager): Array<{
		id: string;
		title: string;
		status: string;
		createdAt: number;
		lastActivity: number;
	}> {
		return sessionManager.listSessions()
			.filter((s) => s.staffId === staffId)
			.map((s) => ({
				id: s.id,
				title: s.title,
				status: s.status,
				createdAt: s.createdAt,
				lastActivity: s.lastActivity,
			}));
	}
}
