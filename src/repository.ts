import { lstatSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import * as path from "node:path";
import { readPostCreateHooks, runPostCreateHooks, type PostCreateHook } from "./hooks.ts";

export class TrunkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TrunkError";
	}
}

export interface Worktree {
	path: string;
	branch?: string;
	head: string;
	bare: boolean;
	locked?: string;
	prunable?: string;
}

export interface Repository {
	primaryPath: string;
	baseDir: string;
	cwd: string;
	worktrees: Worktree[];
}

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new TrunkError(stderr.trim() || `Git ${args[0]} failed (exit ${code}).`);
		return stdout;
	} catch (error) {
		if (error instanceof TrunkError) throw error;
		throw new TrunkError(`Could not run Git: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function canonicalPath(input: string): string {
	let candidate = path.resolve(input);
	const missing: string[] = [];
	let followedLinks = 0;
	for (;;) {
		try {
			return path.join(realpathSync(candidate), ...missing);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
				throw new TrunkError(`Cannot resolve path ${JSON.stringify(input)}: ${error instanceof Error ? error.message : String(error)}`);
			}
			let info: Stats | undefined;
			try {
				info = lstatSync(candidate, { throwIfNoEntry: false });
			} catch (inspectionError) {
				if (!(inspectionError instanceof Error) || !("code" in inspectionError) ||
					(inspectionError.code !== "ENOENT" && inspectionError.code !== "ENOTDIR")) {
					throw new TrunkError(`Cannot inspect path ${JSON.stringify(candidate)}: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}`);
				}
			}
			// A failed realpath can still name an existing symlink; follow it before reconstructing the path.
			if (info?.isSymbolicLink()) {
				if (++followedLinks > 40) throw new TrunkError(`Too many symbolic links while resolving ${JSON.stringify(input)}.`);
				candidate = path.resolve(path.dirname(candidate), readlinkSync(candidate));
				continue;
			}
			const parent = path.dirname(candidate);
			if (parent === candidate) throw new TrunkError(`Cannot resolve path ${JSON.stringify(input)}.`);
			missing.unshift(path.basename(candidate));
			candidate = parent;
		}
	}
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function parseWorktrees(output: string, cwd: string): Worktree[] {
	if (!output.endsWith("\0")) throw new TrunkError("Git returned invalid worktree porcelain output.");
	const worktrees: Worktree[] = [];
	let current: Worktree | undefined;
	for (const field of output.split("\0")) {
		if (!field) {
			if (current) {
				if (!current.bare && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(current.head)) {
					throw new TrunkError("Git returned a worktree without a valid HEAD.");
				}
				worktrees.push(current);
				current = undefined;
			}
			continue;
		}
		const separator = field.indexOf(" ");
		const label = separator === -1 ? field : field.slice(0, separator);
		const value = separator === -1 ? "" : field.slice(separator + 1);
		if (label === "worktree") {
			if (current || !value) throw new TrunkError("Git returned an invalid worktree record.");
			current = { path: canonicalPath(path.resolve(cwd, value)), head: "", bare: false };
			continue;
		}
		if (!current) throw new TrunkError("Git returned a worktree attribute outside a record.");
		if (label === "HEAD") current.head = value;
		else if (label === "branch") {
			if (!value.startsWith("refs/heads/") || value === "refs/heads/") throw new TrunkError("Git returned an invalid worktree branch.");
			current.branch = value.slice("refs/heads/".length);
		} else if (label === "bare") current.bare = true;
		else if (label === "locked") current.locked = value;
		else if (label === "prunable") current.prunable = value;
	}
	return worktrees;
}

function repositoryFromOutput(cwd: string, output: string): Repository {
	const worktrees = parseWorktrees(output, cwd);
	const primary = worktrees[0];
	if (!primary) throw new TrunkError("Git did not report a primary worktree.");
	if (primary.bare) {
		throw new TrunkError("/trunk does not support a bare primary repository. Use a non-bare clone with a primary checkout.");
	}
	return { primaryPath: primary.path, baseDir: `${primary.path}.worktrees`, cwd, worktrees };
}

export async function discoverRepository(cwd: string): Promise<Repository> {
	if (!cwd || cwd.includes("\0")) throw new TrunkError("A valid repository directory is required.");
	const canonicalCwd = canonicalPath(cwd);
	return repositoryFromOutput(canonicalCwd, await git(canonicalCwd, ["worktree", "list", "--porcelain", "-z"]));
}

// OMP's completion callback is synchronous. Read live Git state with a bounded wait.
export function discoverRepositoryForCompletion(cwd: string): Repository {
	if (!cwd || cwd.includes("\0")) throw new TrunkError("A valid repository directory is required.");
	const canonicalCwd = canonicalPath(cwd);
	const result = Bun.spawnSync(["git", "-C", canonicalCwd, "worktree", "list", "--porcelain", "-z"], {
		stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 1000,
	});
	if (result.exitCode !== 0) throw new TrunkError("Worktree completion is unavailable.");
	return repositoryFromOutput(canonicalCwd, result.stdout.toString());
}

function checkDestination(repo: Repository, branch: string): string {
	const destination = path.resolve(repo.baseDir, branch);
	if (destination === repo.baseDir || !isWithin(repo.baseDir, destination)) {
		throw new TrunkError("The branch would place its worktree outside the worktree directory.");
	}
	for (const worktree of repo.worktrees) {
		if (isWithin(worktree.path, destination)) {
			throw new TrunkError(`The destination is already inside registered worktree ${JSON.stringify(worktree.path)}.`);
		}
	}
	let current = repo.baseDir;
	const components = ["", ...path.relative(repo.baseDir, destination).split(path.sep)];
	for (const component of components) {
		if (component) current = path.join(current, component);
		const stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat) continue;
		if (stat.isSymbolicLink()) throw new TrunkError(`Refusing a symlink in the worktree destination: ${JSON.stringify(current)}.`);
		if (current === destination) throw new TrunkError(`The worktree path already exists: ${JSON.stringify(destination)}.`);
		if (!stat.isDirectory()) throw new TrunkError(`The worktree parent is not a directory: ${JSON.stringify(current)}.`);
	}
	return destination;
}

export async function addWorktree(
	repo: Repository,
	options: { branch: string; createBranch: boolean; revision?: string },
	reportHook?: (message: string) => void,
): Promise<Worktree> {
	const fresh = await discoverRepository(repo.cwd);
	const { branch, createBranch, revision } = options;
	if (!branch || branch.startsWith("-") || branch.includes("\0")) throw new TrunkError("A valid branch name is required.");
	const checkedName = (await git(fresh.cwd, ["check-ref-format", "--branch", branch])).replace(/\n$/u, "");
	if (checkedName !== branch) throw new TrunkError("Use a literal branch name, not a checkout-history expression.");
	if (!createBranch && revision !== undefined) throw new TrunkError("A source revision requires creating a branch with -b.");
	const destination = checkDestination(fresh, branch);
	const occupied = fresh.worktrees.find(worktree => worktree.branch === branch);
	if (occupied) throw new TrunkError(`Branch ${JSON.stringify(branch)} is already checked out at ${JSON.stringify(occupied.path)}.`);
	const refs = (await git(fresh.cwd, ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"])).split("\n");
	const localExists = refs.includes(`refs/heads/${branch}`);
	let args: string[];
	if (createBranch) {
		if (localExists) throw new TrunkError(`Branch ${JSON.stringify(branch)} already exists. Omit -b to use it.`);
		const source = revision ?? "HEAD";
		if (!source || source.includes("\0")) throw new TrunkError("A valid source revision is required.");
		await git(fresh.cwd, ["rev-parse", "--verify", "--end-of-options", `${source}^{commit}`]);
		args = ["worktree", "add", "-b", branch, "--", destination, source];
	} else if (localExists) {
		args = ["worktree", "add", "--", destination, branch];
	} else {
		const remotes = (await git(fresh.cwd, ["remote"])).split("\n").filter(Boolean);
		const matches = remotes.map(remote => `refs/remotes/${remote}/${branch}`).filter(ref => refs.includes(ref));
		if (matches.length === 0) {
			throw new TrunkError(`Branch ${JSON.stringify(branch)} was not found locally or on a remote. Use /trunk add -b <new-branch> [revision] to create one.`);
		}
		if (matches.length > 1) {
			throw new TrunkError(`Branch ${JSON.stringify(branch)} is ambiguous across remote branches: ${matches.map(ref => JSON.stringify(ref.slice("refs/remotes/".length))).join(", ")}. Use /trunk add -b <new-branch> <remote>/<branch> to choose a source.`);
		}
		args = ["worktree", "add", "--track", "-b", branch, "--", destination, matches[0]!];
	}
	let hooks: PostCreateHook[];
	try {
		hooks = readPostCreateHooks(fresh.primaryPath);
	} catch (error) {
		throw new TrunkError(`Invalid worktree hook configuration: ${error instanceof Error ? error.message : String(error)}`);
	}
	await git(fresh.cwd, args);
	const result = (await discoverRepository(fresh.cwd)).worktrees.find(worktree => worktree.path === destination && worktree.branch === branch);
	if (!result) throw new TrunkError("Git created the worktree, but its path and branch could not be confirmed. Inspect /trunk list.");
	try {
		await runPostCreateHooks(hooks, fresh.primaryPath, result.path, reportHook);
	} catch (error) {
		throw new TrunkError(
			`Worktree created at ${JSON.stringify(result.path)}, but post_create setup failed: ` +
				`${error instanceof Error ? error.message : String(error)}\n` +
				"The worktree and branch were kept; navigation was not requested. Fix setup in that checkout, then use /trunk cd.",
		);
	}
	return result;
}

export function resolveWorktree(repo: Repository, target?: string): Worktree {
	if (target !== undefined && (!target || target.includes("\0"))) throw new TrunkError("A valid worktree selector is required.");
	let matches: Worktree[];
	if (target === undefined || target === "@") {
		matches = repo.worktrees.filter(worktree => worktree.path === repo.primaryPath);
	} else {
		const explicit = path.isAbsolute(target) || target === "." || target === ".." || target.startsWith(`.${path.sep}`) || target.startsWith(`..${path.sep}`);
		const selectedPath = canonicalPath(path.resolve(explicit ? repo.cwd : repo.baseDir, target));
		matches = repo.worktrees.filter(worktree => worktree.path === selectedPath || (!explicit && worktree.branch === target));
	}
	if (matches.length === 0) throw new TrunkError(`No registered worktree matches ${JSON.stringify(target ?? "@")}. Use /trunk list.`);
	if (matches.length > 1) throw new TrunkError(`Ambiguous worktree selector ${JSON.stringify(target ?? "@")}. Use an explicit path.`);
	const result = matches[0]!;
	try {
		if (!statSync(result.path).isDirectory() || canonicalPath(result.path) !== result.path) throw new Error("not an available canonical directory");
	} catch {
		throw new TrunkError(`The registered worktree directory is unavailable: ${JSON.stringify(result.path)}.`);
	}
	return result;
}

export async function removeWorktree(repo: Repository, target: Worktree): Promise<void> {
	const fresh = await discoverRepository(repo.cwd);
	const registered = fresh.worktrees.find(worktree => worktree.path === target.path);
	if (!registered) throw new TrunkError(`Not a registered worktree: ${JSON.stringify(target.path)}.`);
	if (registered.path === fresh.primaryPath) throw new TrunkError("The primary worktree cannot be removed.");
	if (isWithin(registered.path, fresh.cwd)) throw new TrunkError("The current worktree cannot be removed. Move this conversation to another worktree first.");
	resolveWorktree(fresh, registered.path);
	await git(fresh.cwd, ["worktree", "remove", "--", registered.path]);
}
