import { TrunkError } from "./repository";

export const SUBCOMMANDS: Record<string, string> = {
	help: "Show worktree commands",
	list: "List registered worktrees",
	add: "Add an existing branch, or create one with -b",
	remove: "Remove a clean, non-current linked worktree",
	cd: "Move this conversation to a registered worktree",
};

export const USAGE = `Usage:
  /trunk list
  /trunk add <existing-branch> [--no-cd]
  /trunk add -b <new-branch> [revision] [--no-cd]
  /trunk cd [branch|path|@]
  /trunk remove <branch|path>
  /trunk help

Add moves this conversation by default; --no-cd only creates the worktree.
New branches start at the current checkout's HEAD unless a revision is given.
Worktrees live at <primary-repo>.worktrees/<branch>, including branch slashes.
Cd with no target, or @, selects the primary checkout. Paths must name a
registered worktree; ./ and ../ paths are relative to the current directory.
Quote paths containing spaces. Removal never forces or deletes branches.`;

export type TrunkCommand =
	| { op: "help" }
	| { op: "list" }
	| { op: "cd"; target?: string }
	| { op: "remove"; target: string }
	| { op: "add"; branch: string; createBranch: boolean; revision?: string; cd: boolean };

function tokenize(input: string): string[] {
	if (input.includes("\0")) throw new TrunkError("Command arguments cannot contain NUL characters.");
	const tokens: string[] = [];
	let token = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < input.length; i++) {
		const char = input[i]!;
		if (char === "\\" && quote !== "'") {
			if (i + 1 === input.length) throw new TrunkError("Incomplete escape at the end of the command.");
			token += input[++i]!;
			started = true;
		} else if (quote) {
			if (char === quote) quote = undefined;
			else token += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			started = true;
		} else if (/\s/u.test(char)) {
			if (started) tokens.push(token);
			token = "";
			started = false;
		} else {
			token += char;
			started = true;
		}
	}
	if (quote) throw new TrunkError("Unclosed quote in command arguments.");
	if (started) tokens.push(token);
	return tokens;
}

export function parseArgs(args: string): TrunkCommand {
	const [op = "help", ...tokens] = tokenize(args);
	if (!Object.hasOwn(SUBCOMMANDS, op)) throw new TrunkError(`Unknown /trunk command: ${JSON.stringify(op)}. Use /trunk help.`);
	let createBranch = false;
	let cd = true;
	const positional: string[] = [];
	for (const token of tokens) {
		if (op === "add" && token === "-b") {
			if (createBranch) throw new TrunkError("The -b flag may only be specified once.");
			createBranch = true;
		} else if (op === "add" && token === "--no-cd") {
			if (!cd) throw new TrunkError("The --no-cd flag may only be specified once.");
			cd = false;
		} else if (token.startsWith("-")) {
			throw new TrunkError(`Unknown flag for /trunk ${op}: ${JSON.stringify(token)}.`);
		} else {
			if (!token) throw new TrunkError("Branch names, revisions, and worktree selectors cannot be empty.");
			positional.push(token);
		}
	}
	if (op === "help" || op === "list") {
		if (positional.length) throw new TrunkError(`/trunk ${op} does not accept arguments.`);
		return { op };
	}
	if (op === "cd") {
		if (positional.length > 1) throw new TrunkError("Usage: /trunk cd [branch|path|@]");
		return positional.length ? { op, target: positional[0]! } : { op };
	}
	if (op === "remove") {
		if (positional.length !== 1) throw new TrunkError("Usage: /trunk remove <branch|path>");
		return { op, target: positional[0]! };
	}
	if (positional.length < 1 || positional.length > (createBranch ? 2 : 1)) {
		throw new TrunkError("Usage: /trunk add <existing-branch> [--no-cd], or /trunk add -b <new-branch> [revision] [--no-cd]");
	}
	return {
		op: "add",
		branch: positional[0]!,
		createBranch,
		...(positional.length === 2 ? { revision: positional[1]! } : {}),
		cd,
	};
}
