import { cpSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import * as path from "node:path";

export type PostCreateHook =
	| { type: "command"; command: string; env?: Record<string, string>; work_dir?: string }
	| { type: "copy"; from: string; to: string }
	| { type: "symlink"; from: string; to: string };

function detail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function mapping(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
		throw new Error(`${label} must be a mapping.`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0")) {
		throw new Error(`${label} must be ${allowEmpty ? "a" : "a nonempty"} string without NUL characters.`);
	}
	return value;
}

function pathField(value: unknown, label: string): string {
	const input = text(value, label);
	const normalized = path.normalize(input);
	if (!path.isAbsolute(input) && (normalized === ".." || normalized.startsWith(`..${path.sep}`))) {
		throw new Error(`${label} escapes its base directory.`);
	}
	return input;
}

function parseHook(value: unknown): PostCreateHook {
	const hook = mapping(value, "Hook");
	const type = hook.type;
	if (type !== "command" && type !== "copy" && type !== "symlink") {
		throw new Error("Hook type must be 'command', 'copy', or 'symlink'.");
	}
	const allowed = type === "command" ? ["type", "command", "env", "work_dir"] : ["type", "from", "to"];
	for (const key of Object.keys(hook)) {
		if (!allowed.includes(key)) throw new Error(`Field ${JSON.stringify(key)} is not supported for ${type} hooks.`);
	}
	if (type === "command") {
		const command = text(hook.command, "command");
		let env: Record<string, string> | undefined;
		if (hook.env !== undefined) {
			const entries = Object.entries(mapping(hook.env, "env"));
			env = Object.fromEntries(entries.map(([key, value]) => {
				if (!key || key.includes("=") || key.includes("\0")) throw new Error("env contains an invalid variable name.");
				return [key, text(value, `env.${key}`, true)];
			}));
		}
		const work_dir = hook.work_dir === undefined ? undefined : text(hook.work_dir, "work_dir", true);
		return { type, command, env, work_dir };
	}
	const from = pathField(hook.from, "from");
	let to = hook.to;
	if (type === "copy" && (to === undefined || to === "")) {
		if (path.isAbsolute(from)) throw new Error("Copy hooks with an absolute from require to.");
		to = from;
	}
	return { type, from, to: pathField(to, "to") };
}

export function readPostCreateHooks(primaryPath: string): PostCreateHook[] {
	let configPath: string | undefined;
	try {
		const candidates = [".wtp.yml", ".wtp.yaml"].map(name => path.join(primaryPath, name));
		const existing = candidates.filter(candidate => lstatSync(candidate, { throwIfNoEntry: false }) !== undefined);
		if (existing.length > 1) throw new Error("Both .wtp.yml and .wtp.yaml exist; keep only one WTP configuration file.");
		configPath = existing[0];
		if (!configPath) return [];
		const contents = readFileSync(configPath, "utf8");
		if (!contents.trim()) return [];
		const parsed: unknown = Bun.YAML.parse(contents);
		if (parsed === null || parsed === undefined) return [];
		const config = mapping(parsed, "WTP configuration");
		if (config.hooks === undefined || config.hooks === null) return [];
		const hooks = mapping(config.hooks, "hooks");
		if (hooks.post_create === undefined || hooks.post_create === null) return [];
		if (!Array.isArray(hooks.post_create)) throw new Error("hooks.post_create must be a list.");
		return hooks.post_create.map((value: unknown, index: number) => {
			try {
				return parseHook(value);
			} catch (error) {
				throw new Error(`Invalid post_create hook ${index + 1}: ${detail(error)}`);
			}
		});
	} catch (error) {
		throw new Error(`Cannot load WTP hooks${configPath ? ` from ${JSON.stringify(configPath)}` : ""}: ${detail(error)}`);
	}
}

function fileHook(hook: Extract<PostCreateHook, { type: "copy" | "symlink" }>, primaryPath: string, worktreePath: string): void {
	const source = path.resolve(primaryPath, hook.from);
	const destination = path.resolve(worktreePath, hook.to);
	const sourceInfo = statSync(source);
	const destinationInfo = statSync(destination, { throwIfNoEntry: false });
	if (source === destination || (destinationInfo && sourceInfo.dev === destinationInfo.dev && sourceInfo.ino === destinationInfo.ino)) {
		throw new Error(`Source and destination paths must be different: ${JSON.stringify(source)} -> ${JSON.stringify(destination)}.`);
	}
	if (hook.type === "symlink" && lstatSync(destination, { throwIfNoEntry: false })) {
		throw new Error(`Destination path already exists: ${JSON.stringify(destination)}.`);
	}
	mkdirSync(path.dirname(destination), { recursive: true });
	if (hook.type === "copy") {
		// cp also guards same-file entries and copying a directory into itself.
		cpSync(source, destination, { recursive: true, dereference: true, force: true });
	} else {
		symlinkSync(source, destination, sourceInfo.isDirectory() ? "dir" : "file");
	}
}

const OUTPUT_LIMIT = 16 * 1024;

async function commandHook(
	hook: Extract<PostCreateHook, { type: "command" }>,
	primaryPath: string,
	worktreePath: string,
	report?: (message: string) => void,
): Promise<void> {
	const inherited = { ...process.env };
	delete inherited.WTP_SHELL_INTEGRATION;
	const proc = Bun.spawn(["sh", "-c", hook.command], {
		cwd: hook.work_dir ? path.resolve(worktreePath, hook.work_dir) : worktreePath,
		env: {
			...inherited,
			...hook.env,
			GIT_WTP_REPO_ROOT: primaryPath,
			GIT_WTP_WORKTREE_PATH: worktreePath,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	// One shared ring retains a bounded tail while both pipes are drained concurrently.
	const buffer = Buffer.alloc(OUTPUT_LIMIT);
	let offset = 0;
	let retained = 0;
	let truncated = false;
	async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (retained + value.length > OUTPUT_LIMIT) truncated = true;
				const chunk = value.length > OUTPUT_LIMIT ? value.subarray(value.length - OUTPUT_LIMIT) : value;
				const first = Math.min(chunk.length, OUTPUT_LIMIT - offset);
				buffer.set(chunk.subarray(0, first), offset);
				buffer.set(chunk.subarray(first), 0);
				offset = (offset + chunk.length) % OUTPUT_LIMIT;
				retained = Math.min(OUTPUT_LIMIT, retained + chunk.length);
			}
		} finally {
			reader.releaseLock();
		}
	}
	const results = await Promise.allSettled([drain(proc.stdout), drain(proc.stderr), proc.exited]);
	const bytes = retained < OUTPUT_LIMIT ? buffer.subarray(0, retained) :
		Buffer.concat([buffer.subarray(offset), buffer.subarray(0, offset)], retained);
	const output = `${truncated ? "[Earlier command output truncated; showing final 16 KiB]\n" : ""}${bytes.toString("utf8")}`;
	if (output) report?.(output);
	for (const result of results) {
		if (result.status === "rejected") throw new Error(`Command execution failed: ${detail(result.reason)}${output ? `\n${output}` : ""}`);
	}
	const exited = results[2];
	if (exited.status === "fulfilled" && exited.value !== 0) {
		throw new Error(`Command failed with exit code ${exited.value}${proc.signalCode ? ` (${proc.signalCode})` : ""}.${output ? `\n${output}` : ""}`);
	}
}

export async function runPostCreateHooks(
	hooks: PostCreateHook[],
	primaryPath: string,
	worktreePath: string,
	report?: (message: string) => void,
): Promise<void> {
	for (const [index, hook] of hooks.entries()) {
		try {
			report?.(`Running post_create hook ${index + 1} of ${hooks.length} (${hook.type})...`);
			if (hook.type === "command") await commandHook(hook, primaryPath, worktreePath, report);
			else fileHook(hook, primaryPath, worktreePath);
		} catch (error) {
			throw new Error(`Post-create hook ${index + 1} (${hook.type}) failed: ${detail(error)}`);
		}
	}
}
