import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RpcBridgeOptions {
	/** Path to pi-coding-agent cli.js. Auto-resolved if omitted. */
	cliPath?: string;
	/** Working directory for the agent process */
	cwd?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Extra environment variables */
	env?: Record<string, string>;
}

export type RpcEventListener = (event: any) => void;

/**
 * Lightweight bridge to a pi-coding-agent running in RPC mode.
 * Communicates via JSONL (one JSON object per line) over stdin/stdout.
 */
export class RpcBridge {
	private process: ChildProcess | null = null;
	private requestId = 0;
	private pending = new Map<string, { resolve: (value: any) => void; reject: (reason: any) => void; timeout: ReturnType<typeof setTimeout> }>();
	private eventListeners: RpcEventListener[] = [];
	private lineBuffer = "";

	constructor(private options: RpcBridgeOptions = {}) {}

	async start(): Promise<void> {
		const cliPath = this.options.cliPath || findAgentCli();
		const args = ["--mode", "rpc"];
		if (this.options.cwd) args.push("--cwd", this.options.cwd);
		if (this.options.args) args.push(...this.options.args);

		this.process = spawn("node", [cliPath, ...args], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
		});

		this.process.stdout!.on("data", (chunk: Buffer) => {
			this.handleData(chunk.toString("utf-8"));
		});

		this.process.stderr!.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
		});

		this.process.on("exit", (code) => {
			for (const [, p] of this.pending) {
				clearTimeout(p.timeout);
				p.reject(new Error(`Agent process exited with code ${code}`));
			}
			this.pending.clear();
			this.process = null;
		});

		// Brief pause for process initialization
		await new Promise((r) => setTimeout(r, 200));
	}

	/** Subscribe to agent events. Returns unsubscribe function. */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx >= 0) this.eventListeners.splice(idx, 1);
		};
	}

	/** Send an RPC command and wait for its response. */
	sendCommand(command: Record<string, any>, timeoutMs = 30_000): Promise<any> {
		if (!this.process?.stdin) {
			throw new Error("Agent process not running");
		}

		const id = `req_${++this.requestId}`;
		const msg = { ...command, id };

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Command timed out: ${command.type}`));
			}, timeoutMs);

			this.pending.set(id, { resolve, reject, timeout });
			this.process!.stdin!.write(JSON.stringify(msg) + "\n");
		});
	}

	// --- Convenience methods matching the RPC protocol ---

	prompt(text: string, images?: string[]) {
		return this.sendCommand({ type: "prompt", message: text, ...(images?.length ? { images } : {}) });
	}

	steer(text: string) {
		return this.sendCommand({ type: "steer", message: text });
	}

	followUp(text: string) {
		return this.sendCommand({ type: "follow_up", message: text });
	}

	abort() {
		return this.sendCommand({ type: "abort" });
	}

	getState() {
		return this.sendCommand({ type: "get_state" });
	}

	setModel(provider: string, modelId: string) {
		return this.sendCommand({ type: "set_model", provider, modelId });
	}

	compact() {
		return this.sendCommand({ type: "compact" });
	}

	getMessages() {
		return this.sendCommand({ type: "get_messages" });
	}

	async stop(): Promise<void> {
		if (!this.process) return;

		return new Promise((resolve) => {
			const killTimer = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 3000);

			this.process!.on("exit", () => {
				clearTimeout(killTimer);
				resolve();
			});

			this.process!.kill("SIGTERM");
		});
	}

	get running(): boolean {
		return this.process !== null;
	}

	// --- Private ---

	private handleData(data: string) {
		this.lineBuffer += data;
		const lines = this.lineBuffer.split("\n");
		this.lineBuffer = lines.pop()!; // keep incomplete trailing fragment

		for (const line of lines) {
			const trimmed = line.replace(/\r$/, "").trim();
			if (!trimmed) continue;

			let parsed: any;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue; // skip non-JSON output (e.g. log lines)
			}

			// Response to a pending request
			if (parsed.type === "response" && parsed.id && this.pending.has(parsed.id)) {
				const p = this.pending.get(parsed.id)!;
				clearTimeout(p.timeout);
				this.pending.delete(parsed.id);
				p.resolve(parsed);
			} else {
				// Agent event — forward to listeners
				for (const listener of this.eventListeners) {
					listener(parsed);
				}
			}
		}
	}
}

/** Resolve the pi-coding-agent cli.js path from the installed package */
function findAgentCli(): string {
	try {
		// import.meta.resolve returns the URL of the package's main entry
		const mainUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
		const mainPath = fileURLToPath(mainUrl);
		// Main entry is dist/index.js; cli.js is in the same directory
		return path.join(path.dirname(mainPath), "cli.js");
	} catch {
		throw new Error(
			"Could not find pi-coding-agent CLI. " +
				"Either install @mariozechner/pi-coding-agent or pass --agent-cli /path/to/cli.js",
		);
	}
}
