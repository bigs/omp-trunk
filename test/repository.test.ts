import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addWorktree, discoverRepository, removeWorktree, resolveWorktree, TrunkError } from "../src/repository";
import { parseArgs } from "../src/args";
import { completeTrunkArguments } from "../src/completions";

let dir: string;
let primary: string;
let first: string;
let latest: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: path.join(dir, "empty-global-config"),
			GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
			GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
	return stdout.trim();
}

beforeEach(async () => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-trunk-test-")));
	primary = path.join(dir, "repo with spaces");
	fs.mkdirSync(primary);
	await git(primary, "init", "--initial-branch=main");
	await git(primary, "config", "user.name", "Trunk Test");
	await git(primary, "config", "user.email", "trunk-test@example.invalid");
	await git(primary, "config", "commit.gpgSign", "false");
	await git(primary, "config", "tag.gpgSign", "false");
	await git(primary, "config", "core.hooksPath", path.join(dir, "no-hooks"));
	await git(primary, "config", "core.autocrlf", "false");
	await git(primary, "config", "core.attributesFile", path.join(dir, "no-attributes"));
	fs.writeFileSync(path.join(primary, "file.txt"), "first\n");
	fs.writeFileSync(path.join(primary, ".gitignore"), "ignored/\n");
	await git(primary, "add", "--", "file.txt", ".gitignore");
	await git(primary, "commit", "-m", "first");
	first = await git(primary, "rev-parse", "HEAD");
	fs.writeFileSync(path.join(primary, "file.txt"), "latest\n");
	await git(primary, "commit", "-am", "latest");
	latest = await git(primary, "rev-parse", "HEAD");
});

afterEach(() => {
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function remote(name: string, branch: string, commit = first): Promise<void> {
	await git(primary, "remote", "add", name, path.join(dir, `uncontacted-${name}`));
	await git(primary, "update-ref", `refs/remotes/${name}/${branch}`, commit);
}

describe("repository discovery", () => {
	test("primary and secondary subdirectories share one canonical base", async () => {
		const nestedPrimary = path.join(primary, "nested");
		fs.mkdirSync(nestedPrimary);
		const initial = await discoverRepository(nestedPrimary);
		expect(initial).toMatchObject({ primaryPath: primary, baseDir: `${primary}.worktrees`, cwd: nestedPrimary });
		const linked = await addWorktree(initial, { branch: "feature/secondary", createBranch: true });
		const nestedLinked = path.join(linked.path, "nested");
		fs.mkdirSync(nestedLinked);
		const secondary = await discoverRepository(nestedLinked);
		expect(secondary).toMatchObject({ primaryPath: primary, baseDir: initial.baseDir, cwd: nestedLinked });
		expect(secondary.worktrees.map(worktree => worktree.path)).toEqual([primary, linked.path]);
		const alias = path.join(dir, "secondary-alias");
		fs.symlinkSync(linked.path, alias, "dir");
		expect((await discoverRepository(alias)).cwd).toBe(linked.path);
	});

	test("NUL porcelain preserves unusual paths and lock reasons", async () => {
		const unusual = path.join(dir, 'linked \t"quote"\\backslash\nline');
		await git(primary, "worktree", "add", "--detach", "--", unusual, first);
		const reason = 'mounted on\na device with "quotes" and \\slashes';
		await git(primary, "worktree", "lock", "--reason", reason, "--", unusual);
		const repo = await discoverRepository(primary);
		const linked = repo.worktrees.find(worktree => worktree.path === unusual);
		expect(linked).toEqual({ path: unusual, head: first, bare: false, locked: reason });
		expect(resolveWorktree(repo, unusual)).toBe(linked!);
		const alias = path.join(dir, "alias\\backslash\nline");
		fs.symlinkSync(unusual, alias, "dir");
		expect(resolveWorktree(repo, alias)).toBe(linked!);
		expect((await discoverRepository(alias)).cwd).toBe(unusual);
		const nested = path.join(unusual, "nested");
		fs.mkdirSync(nested);
		expect((await discoverRepository(path.join(alias, "nested"))).cwd).toBe(nested);
		await git(primary, "worktree", "unlock", "--", unusual);
		await git(primary, "worktree", "lock", "--", unusual);
		expect((await discoverRepository(primary)).worktrees.find(worktree => worktree.path === unusual)?.locked).toBe("");
	});

	test("missing registered worktrees remain listed but cannot be selected", async () => {
		const linked = await addWorktree(await discoverRepository(primary), { branch: "missing", createBranch: true });
		fs.renameSync(linked.path, path.join(dir, "moved-outside-git"));
		const repo = await discoverRepository(primary);
		const missing = repo.worktrees.find(worktree => worktree.branch === "missing");
		expect(missing?.path).toBe(linked.path);
		expect(typeof missing?.prunable).toBe("string");
		expect(() => resolveWorktree(repo, "missing")).toThrow(/unavailable/u);
		await expect(removeWorktree(repo, linked)).rejects.toThrow(/unavailable/u);
		expect(await git(primary, "rev-parse", "refs/heads/missing")).toBe(latest);
	});

	test("bare primary repositories and non-repository directories fail clearly", async () => {
		const bare = path.join(dir, "bare.git");
		fs.mkdirSync(bare);
		await git(bare, "init", "--bare", "--initial-branch=main");
		await expect(discoverRepository(bare)).rejects.toThrow(/bare primary.*non-bare/u);
		await expect(discoverRepository(dir)).rejects.toThrow(TrunkError);
	});
});

describe("adding standard linked worktrees", () => {
	test("an existing slash branch keeps its ref, path hierarchy, and Git link", async () => {
		await git(primary, "branch", "feature/topic", first);
		const repo = await discoverRepository(primary);
		const linked = await addWorktree(repo, { branch: "feature/topic", createBranch: false });
		expect(linked).toEqual({ path: path.join(`${primary}.worktrees`, "feature/topic"), branch: "feature/topic", head: first, bare: false });
		expect(fs.statSync(path.join(linked.path, ".git")).isFile()).toBe(true);
		expect(path.resolve(linked.path, await git(linked.path, "rev-parse", "--git-common-dir"))).toBe(path.join(primary, ".git"));
		expect(await git(primary, "rev-parse", "refs/heads/feature/topic")).toBe(first);
		expect(fs.readFileSync(path.join(linked.path, "file.txt"), "utf8")).toBe("first\n");
	});

	test("new branches accept tags, ancestor expressions, commit IDs, local and remote refs", async () => {
		await git(primary, "tag", "source-tag", first);
		await git(primary, "branch", "source/local", first);
		await remote("origin", "source/remote");
		const sources = ["source-tag", "HEAD~1", first, "source/local", "refs/remotes/origin/source/remote"];
		for (const [index, revision] of sources.entries()) {
			const branch = `from-source/${index}`;
			const linked = await addWorktree(await discoverRepository(primary), { branch, createBranch: true, revision });
			expect(linked).toMatchObject({ branch, head: first });
			expect(await git(linked.path, "rev-parse", "HEAD")).toBe(first);
		}
	});

	test("default HEAD is from the caller's secondary checkout without copying local changes", async () => {
		const beforeCwd = process.cwd();
		const initial = await discoverRepository(primary);
		const secondary = await addWorktree(initial, { branch: "secondary", createBranch: true, revision: first });
		fs.mkdirSync(path.join(secondary.path, "nested"));
		fs.mkdirSync(path.join(secondary.path, "ignored"));
		fs.writeFileSync(path.join(secondary.path, "ignored", "artifact"), "do not copy");
		fs.writeFileSync(path.join(secondary.path, "untracked.txt"), "do not copy");
		fs.writeFileSync(path.join(secondary.path, "file.txt"), "dirty\n");
		const caller = await discoverRepository(path.join(secondary.path, "nested"));
		const linked = await addWorktree(caller, { branch: "feature/from-secondary", createBranch: true });
		expect(linked.path).toBe(path.join(initial.baseDir, "feature/from-secondary"));
		expect(linked.head).toBe(first);
		expect(fs.readFileSync(path.join(linked.path, "file.txt"), "utf8")).toBe("first\n");
		expect(fs.existsSync(path.join(linked.path, "ignored"))).toBe(false);
		expect(fs.existsSync(path.join(linked.path, "untracked.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(secondary.path, "file.txt"), "utf8")).toBe("dirty\n");
		expect(process.cwd()).toBe(beforeCwd);
	});

	test("a unique remote branch becomes a tracking local branch", async () => {
		await remote("origin", "remote/topic");
		const linked = await addWorktree(await discoverRepository(primary), { branch: "remote/topic", createBranch: false });
		expect(linked).toMatchObject({ branch: "remote/topic", head: first });
		expect(await git(linked.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/remote/topic");
	});

	test("multiple remotes require an explicit source, not checkout.defaultRemote", async () => {
		await remote("origin", "shared", first);
		await remote("other", "shared", latest);
		await git(primary, "config", "checkout.defaultRemote", "origin");
		const repo = await discoverRepository(primary);
		await expect(addWorktree(repo, { branch: "shared", createBranch: false })).rejects.toThrow(/ambiguous/u);
		expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/shared")).toBe("");
		expect(fs.existsSync(path.join(repo.baseDir, "shared"))).toBe(false);
		const linked = await addWorktree(repo, { branch: "shared", createBranch: true, revision: "other/shared" });
		expect(linked.head).toBe(latest);
	});

	test("local branches take priority over matching remote branches", async () => {
		await remote("origin", "topic", first);
		await remote("other", "topic", first);
		await git(primary, "branch", "topic", latest);
		const linked = await addWorktree(await discoverRepository(primary), { branch: "topic", createBranch: false });
		expect(linked.head).toBe(latest);
	});

	test("remote suffixes are not mistaken for exact branch names", async () => {
		await remote("origin", "nested/topic");
		await expect(addWorktree(await discoverRepository(primary), { branch: "topic", createBranch: false })).rejects.toThrow(/not found/u);
		expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/topic")).toBe("");
	});

	test("an existing empty directory fails before creating a branch", async () => {
		const repo = await discoverRepository(primary);
		const existing = path.join(repo.baseDir, "occupied");
		fs.mkdirSync(existing, { recursive: true });
		await expect(addWorktree(repo, { branch: "occupied", createBranch: true })).rejects.toThrow(/already exists/u);
		expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/occupied")).toBe("");
		expect(fs.readdirSync(existing)).toEqual([]);
	});

	test("invalid source, duplicate branch, and duplicate checkout failures leave no new refs or paths", async () => {
		const repo = await discoverRepository(primary);
		await expect(addWorktree(repo, { branch: "bad-source", createBranch: true, revision: "missing-revision" })).rejects.toThrow(TrunkError);
		expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/bad-source")).toBe("");
		expect(fs.existsSync(path.join(repo.baseDir, "bad-source"))).toBe(false);
		await git(primary, "branch", "already-exists", first);
		await expect(addWorktree(repo, { branch: "already-exists", createBranch: true })).rejects.toThrow(/already exists/u);
		expect(await git(primary, "rev-parse", "refs/heads/already-exists")).toBe(first);
		expect(fs.existsSync(path.join(repo.baseDir, "already-exists"))).toBe(false);
		await expect(addWorktree(repo, { branch: "main", createBranch: false })).rejects.toThrow(/already checked out/u);
		expect(fs.existsSync(path.join(repo.baseDir, "main"))).toBe(false);
		const linked = await addWorktree(repo, { branch: "created", createBranch: true });
		await expect(addWorktree(repo, { branch: "created", createBranch: false })).rejects.toThrow(TrunkError);
		expect((await discoverRepository(primary)).worktrees.filter(worktree => worktree.branch === "created")).toEqual([linked]);
	});

	test("a branch checked out outside the conventional base cannot be duplicated", async () => {
		const external = path.join(dir, "external-checkout");
		await git(primary, "worktree", "add", "-b", "external", "--", external, first);
		const repo = await discoverRepository(primary);
		await expect(addWorktree(repo, { branch: "external", createBranch: false })).rejects.toThrow(/already checked out/u);
		expect(fs.existsSync(path.join(repo.baseDir, "external"))).toBe(false);
	});

	test("invalid branch names and sources cannot be interpreted as Git options", async () => {
		const repo = await discoverRepository(primary);
		for (const branch of ["../escape", "/absolute", "-f", "HEAD", "@{-1}", "bad\0branch", "bad branch", "feature//topic"]) {
			await expect(addWorktree(repo, { branch, createBranch: true })).rejects.toThrow(TrunkError);
		}
		await expect(addWorktree(repo, { branch: "option-source", createBranch: true, revision: "--all" })).rejects.toThrow(TrunkError);
		await expect(addWorktree(repo, { branch: "main", createBranch: false, revision: first })).rejects.toThrow(/requires.*-b/u);
		expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/")).toBe("refs/heads/main");
		expect(fs.existsSync(repo.baseDir)).toBe(false);
	});

	test("literal shell punctuation and non-ASCII whitespace remain branch data", async () => {
		for (const branch of ["$(false);literal", "\u00a0topic\u00a0"]) {
			const linked = await addWorktree(await discoverRepository(primary), { branch, createBranch: true, revision: first });
			expect(linked.branch).toBe(branch);
			expect(linked.path).toBe(path.join(`${primary}.worktrees`, branch));
			expect(linked.head).toBe(first);
			expect(resolveWorktree(await discoverRepository(primary), branch).path).toBe(linked.path);
		}
	});
});

describe("WTP post-create hooks", () => {
	test(".wtp.yml runs ordered copy, symlink, and command hooks with source contents and modes", async () => {
		const assets = path.join(primary, "local assets");
		fs.mkdirSync(path.join(assets, "nested"), { recursive: true });
		fs.writeFileSync(path.join(assets, "nested", "run.sh"), "#!/bin/sh\nprintf setup\n", { mode: 0o751 });
		fs.chmodSync(path.join(assets, "nested", "run.sh"), 0o751);
		fs.symlinkSync("nested/run.sh", path.join(assets, "alias"));
		fs.writeFileSync(path.join(primary, ".wtp.yml"), `
defaults:
  base_dir: ignored-layout
hooks:
  post_create:
    - type: copy
      from: local assets
    - type: copy
      from: local assets/nested/run.sh
      to: file.txt
    - type: symlink
      from: local assets/nested/run.sh
      to: linked-script
    - type: command
      command: 'test -L linked-script && cmp linked-script file.txt && ./file.txt > setup-result'
`);
		const linked = await addWorktree(await discoverRepository(primary), { branch: "hook/mixed", createBranch: true });
		expect(linked.path).toBe(path.join(`${primary}.worktrees`, "hook/mixed"));
		expect(fs.readFileSync(path.join(linked.path, "setup-result"), "utf8")).toBe("setup");
		expect(fs.readFileSync(path.join(linked.path, "local assets", "nested", "run.sh"), "utf8")).toBe("#!/bin/sh\nprintf setup\n");
		expect(fs.statSync(path.join(linked.path, "local assets", "nested", "run.sh")).mode & 0o777).toBe(0o751);
		expect(fs.statSync(path.join(linked.path, "file.txt")).mode & 0o777).toBe(0o751);
		expect(fs.lstatSync(path.join(linked.path, "local assets", "alias")).isSymbolicLink()).toBe(false);
		expect(fs.readFileSync(path.join(linked.path, "local assets", "alias"), "utf8")).toBe("#!/bin/sh\nprintf setup\n");
		expect(fs.readlinkSync(path.join(linked.path, "linked-script"))).toBe(path.join(assets, "nested", "run.sh"));
	});

	test(".wtp.yaml is anchored to the primary checkout even from a linked subdirectory", async () => {
		const secondary = await addWorktree(await discoverRepository(primary), { branch: "hook-caller", createBranch: true, revision: first });
		const nested = path.join(secondary.path, "nested");
		fs.mkdirSync(nested);
		for (const cwd of [secondary.path, nested]) {
			fs.writeFileSync(path.join(cwd, ".wtp.yml"), "hooks: { post_create: [{ type: unknown }] }\n");
			fs.writeFileSync(path.join(cwd, ".wtp.yaml"), "not: [valid\n");
		}
		fs.mkdirSync(path.join(primary, "config"));
		fs.writeFileSync(path.join(primary, "config", "private"), "primary only\n");
		fs.writeFileSync(path.join(primary, ".wtp.yaml"), `
hooks:
  post_create:
    - type: copy
      from: config
      to: setup
    - type: command
      work_dir: setup
      env:
        HOOK_VALUE: "value with spaces"
        GIT_WTP_REPO_ROOT: wrong-root
        GIT_WTP_WORKTREE_PATH: wrong-worktree
      command: |
        printf '%s\\n' "$HOOK_VALUE" "$GIT_WTP_REPO_ROOT" "$GIT_WTP_WORKTREE_PATH" > metadata
        pwd -P > cwd
        cat private > copied
`);
		const linked = await addWorktree(await discoverRepository(nested), { branch: "hook-primary", createBranch: true });
		expect(linked.head).toBe(first);
		expect(fs.readFileSync(path.join(linked.path, "setup", "metadata"), "utf8")).toBe(`value with spaces\n${primary}\n${linked.path}\n`);
		expect(fs.readFileSync(path.join(linked.path, "setup", "cwd"), "utf8")).toBe(`${linked.path}/setup\n`);
		expect(fs.readFileSync(path.join(linked.path, "setup", "copied"), "utf8")).toBe("primary only\n");
	});

	test("absolute paths work and home-like path fields remain literal", async () => {
		const external = path.join(dir, "external source");
		fs.writeFileSync(external, "external\n");
		for (const name of ["~", "$HOME"]) {
			fs.mkdirSync(path.join(primary, name));
			fs.writeFileSync(path.join(primary, name, "secret"), `${name}\n`);
		}
		const destination = path.join(dir, "external copy");
		fs.writeFileSync(path.join(primary, ".wtp.yml"), JSON.stringify({
			hooks: { post_create: [
				{ type: "copy", from: external, to: destination },
				{ type: "copy", from: "~/secret" },
				{ type: "copy", from: "$HOME/secret" },
				{ type: "symlink", from: external, to: "external-link" },
			] },
		}));
		const linked = await addWorktree(await discoverRepository(primary), { branch: "hook-paths", createBranch: true });
		expect(fs.readFileSync(destination, "utf8")).toBe("external\n");
		for (const name of ["~", "$HOME"]) {
			expect(fs.readFileSync(path.join(linked.path, name, "secret"), "utf8")).toBe(`${name}\n`);
		}
		expect(fs.readlinkSync(path.join(linked.path, "external-link"))).toBe(external);
	});

	test.each([
		["invalid YAML", "hooks: [\n"],
		["scalar root", "42\n"],
		["array root", "[]\n"],
		["scalar hooks", "hooks: true\n"],
		["non-list hooks", "hooks: { post_create: {} }\n"],
		["null entry", "hooks: { post_create: [null] }\n"],
		["unknown type", "hooks: { post_create: [{ type: unknown }] }\n"],
		["missing command", "hooks: { post_create: [{ type: command }] }\n"],
		["non-string command", "hooks: { post_create: [{ type: command, command: 42 }] }\n"],
		["invalid env", "hooks: { post_create: [{ type: command, command: 'true', env: { X: 42 } }] }\n"],
		["invalid work_dir", "hooks: { post_create: [{ type: command, command: 'true', work_dir: [] }] }\n"],
		["command with from", "hooks: { post_create: [{ type: command, command: 'true', from: file.txt }] }\n"],
		["command with to", "hooks: { post_create: [{ type: command, command: 'true', to: file.txt }] }\n"],
		["copy without from", "hooks: { post_create: [{ type: copy, to: file.txt }] }\n"],
		["absolute copy without to", "hooks: { post_create: [{ type: copy, from: /absolute-source }] }\n"],
		["copy with command", "hooks: { post_create: [{ type: copy, from: file.txt, command: 'true' }] }\n"],
		["symlink without to", "hooks: { post_create: [{ type: symlink, from: file.txt }] }\n"],
		["symlink with command", "hooks: { post_create: [{ type: symlink, from: file.txt, to: link, command: 'true' }] }\n"],
		["source escape", "hooks: { post_create: [{ type: copy, from: ../outside, to: inside }] }\n"],
		["destination escape", "hooks: { post_create: [{ type: copy, from: file.txt, to: ../outside }] }\n"],
	])("%s fails before creating any worktree or branch", async (_name, config) => {
		fs.writeFileSync(path.join(primary, ".wtp.yml"), config);
		const repo = await discoverRepository(primary);
		await expect(addWorktree(repo, { branch: "invalid-hooks", createBranch: true })).rejects.toThrow(TrunkError);
		expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/invalid-hooks")).toBe("");
		expect(fs.existsSync(path.join(repo.baseDir, "invalid-hooks"))).toBe(false);
		expect((await discoverRepository(primary)).worktrees.map(worktree => worktree.path)).toEqual([primary]);
	});

	test("both config filenames are ambiguous even when empty", async () => {
		fs.writeFileSync(path.join(primary, ".wtp.yml"), "");
		fs.writeFileSync(path.join(primary, ".wtp.yaml"), "");
		const repo = await discoverRepository(primary);
		await expect(addWorktree(repo, { branch: "ambiguous-hooks", createBranch: true })).rejects.toThrow(TrunkError);
		expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/ambiguous-hooks")).toBe("");
		expect(fs.existsSync(path.join(repo.baseDir, "ambiguous-hooks"))).toBe(false);
		expect((await discoverRepository(primary)).worktrees.map(worktree => worktree.path)).toEqual([primary]);
	});

	test.each(["", "hooks: null\n", "hooks: {}\n", "hooks: { post_create: null }\n"])("empty hook configuration %j is a no-op", async config => {
		fs.writeFileSync(path.join(primary, ".wtp.yml"), config);
		const linked = await addWorktree(await discoverRepository(primary), { branch: "empty-hooks", createBranch: true });
		expect(fs.readFileSync(path.join(linked.path, "file.txt"), "utf8")).toBe("latest\n");
		expect(await git(linked.path, "status", "--porcelain")).toBe("");
	});

	test("failed commands preserve the worktree and branch, report both streams, and stop later hooks", async () => {
		fs.writeFileSync(path.join(primary, ".wtp.yml"), `
hooks:
  post_create:
    - type: command
      command: printf before > before
    - type: command
      command: 'printf command-output; printf command-error >&2; exit 23'
    - type: command
      command: touch should-not-exist
`);
		const messages: string[] = [];
		const repo = await discoverRepository(primary);
		await expect(addWorktree(repo, { branch: "failed-command", createBranch: true }, message => messages.push(message))).rejects.toThrow(/23/u);
		const linked = (await discoverRepository(primary)).worktrees.find(worktree => worktree.branch === "failed-command");
		expect(linked?.path).toBe(path.join(repo.baseDir, "failed-command"));
		expect(await git(primary, "rev-parse", "refs/heads/failed-command")).toBe(latest);
		expect(fs.readFileSync(path.join(linked!.path, "before"), "utf8")).toBe("before");
		expect(fs.existsSync(path.join(linked!.path, "should-not-exist"))).toBe(false);
		expect(messages.join("\n")).toContain("command-output");
		expect(messages.join("\n")).toContain("command-error");
	});

	test.each(["copy", "symlink"])("a missing %s source stops later hooks without undoing creation", async type => {
		fs.writeFileSync(path.join(primary, ".wtp.yml"), JSON.stringify({
			hooks: { post_create: [
				{ type, from: "missing-source", to: "missing-target" },
				{ type: "command", command: "touch should-not-exist" },
			] },
		}));
		const repo = await discoverRepository(primary);
		await expect(addWorktree(repo, { branch: "missing-hook-source", createBranch: true })).rejects.toThrow(TrunkError);
		const linked = (await discoverRepository(primary)).worktrees.find(worktree => worktree.branch === "missing-hook-source");
		expect(linked?.path).toBe(path.join(repo.baseDir, "missing-hook-source"));
		expect(await git(primary, "rev-parse", "refs/heads/missing-hook-source")).toBe(latest);
		expect(fs.existsSync(path.join(linked!.path, "missing-target"))).toBe(false);
		expect(fs.existsSync(path.join(linked!.path, "should-not-exist"))).toBe(false);
	});

	test("symlink hooks refuse an existing dangling destination without replacing it", async () => {
		fs.writeFileSync(path.join(primary, ".wtp.yml"), JSON.stringify({
			hooks: { post_create: [
				{ type: "command", command: "ln -s missing-target collision" },
				{ type: "symlink", from: "file.txt", to: "collision" },
				{ type: "command", command: "touch should-not-exist" },
			] },
		}));
		const repo = await discoverRepository(primary);
		await expect(addWorktree(repo, { branch: "hook-collision", createBranch: true })).rejects.toThrow(TrunkError);
		const linked = (await discoverRepository(primary)).worktrees.find(worktree => worktree.branch === "hook-collision");
		expect(linked?.path).toBe(path.join(repo.baseDir, "hook-collision"));
		expect(fs.readlinkSync(path.join(linked!.path, "collision"))).toBe("missing-target");
		expect(fs.existsSync(path.join(linked!.path, "should-not-exist"))).toBe(false);
		expect(await git(primary, "rev-parse", "refs/heads/hook-collision")).toBe(latest);
	});

	test("copy hooks reject the same inode without truncating the source", async () => {
		const source = path.join(primary, "private-source");
		const alias = path.join(dir, "hardlink-alias");
		fs.writeFileSync(source, "must survive\n");
		fs.linkSync(source, alias);
		fs.writeFileSync(path.join(primary, ".wtp.yml"), JSON.stringify({
			hooks: { post_create: [
				{ type: "copy", from: source, to: alias },
				{ type: "command", command: "touch should-not-exist" },
			] },
		}));
		const repo = await discoverRepository(primary);
		await expect(addWorktree(repo, { branch: "same-inode", createBranch: true })).rejects.toThrow(TrunkError);
		expect(fs.readFileSync(source, "utf8")).toBe("must survive\n");
		expect(fs.readFileSync(alias, "utf8")).toBe("must survive\n");
		expect(await git(primary, "rev-parse", "refs/heads/same-inode")).toBe(latest);
		const linked = (await discoverRepository(primary)).worktrees.find(worktree => worktree.branch === "same-inode");
		expect(linked?.path).toBe(path.join(repo.baseDir, "same-inode"));
		expect(fs.existsSync(path.join(linked!.path, "should-not-exist"))).toBe(false);
	});
});

describe("worktree target completion", () => {
	test("cd suggests registered branches and the primary alias, with live changes and exact matches suppressed", async () => {
		await git(primary, "branch", "not-checked-out");
		const linked = await addWorktree(await discoverRepository(primary), { branch: "feature/topic", createBranch: true });
		expect(completeTrunkArguments("cd ", primary)?.map(item => item.value)).toEqual(["cd @", "cd feature/topic"]);
		expect(completeTrunkArguments("cd fea", primary)?.map(item => item.value)).toEqual(["cd feature/topic"]);
		expect(completeTrunkArguments("cd feature/topic", primary)).toEqual([]);
		expect(completeTrunkArguments("cd @", primary)).toEqual([]);
		expect(completeTrunkArguments("cd main", primary)).toEqual([]);
		await removeWorktree(await discoverRepository(primary), linked);
		expect(completeTrunkArguments("cd fea", primary)).toEqual([]);
		expect(completeTrunkArguments("c", dir)?.map(item => item.value)).toEqual(["cd "]);
		expect(completeTrunkArguments("cd ", dir)).toBeNull();
	});

	test("remove excludes primary, current, locked, and unavailable worktrees", async () => {
		const current = await addWorktree(await discoverRepository(primary), { branch: "current", createBranch: true });
		await addWorktree(await discoverRepository(primary), { branch: "removable", createBranch: true });
		const locked = await addWorktree(await discoverRepository(primary), { branch: "locked", createBranch: true });
		await git(primary, "worktree", "lock", locked.path);
		const missing = await addWorktree(await discoverRepository(primary), { branch: "missing", createBranch: true });
		fs.renameSync(missing.path, path.join(dir, "moved"));
		const nested = path.join(current.path, "nested");
		fs.mkdirSync(nested);
		expect(completeTrunkArguments("remove ", nested)?.map(item => item.value)).toEqual(["remove removable"]);
		expect(completeTrunkArguments("remove rem", nested)?.map(item => item.value)).toEqual(["remove removable"]);
		expect(completeTrunkArguments("remove removable", nested)).toEqual([]);
		expect(completeTrunkArguments("cd ", nested)?.map(item => item.value)).toEqual(["cd @", "cd current", "cd locked", "cd removable"]);
	});

	test("detached paths with spaces, quotes, and backslashes complete to executable selectors", async () => {
		const detached = path.join(dir, `detached \"quote\" 'single' \\backslash`);
		await git(primary, "worktree", "add", "--detach", detached, first);
		for (const prefix of ["cd ", "remove ", `cd \"${dir}/detached `, `cd '${dir}/detached `, `cd ${dir}/detached\\ `]) {
			const items = completeTrunkArguments(prefix, primary) ?? [];
			const item = items.find(candidate => candidate.label === detached);
			expect(item).toBeDefined();
			const command = parseArgs(item!.value);
			expect(command.op === "cd" || command.op === "remove").toBe(true);
			if (command.op !== "cd" && command.op !== "remove") throw new Error("Expected a worktree selector.");
			expect(resolveWorktree(await discoverRepository(primary), command.target).path).toBe(detached);
			expect(completeTrunkArguments(item!.value, primary)).toEqual([]);
		}
	});

	test("branch/path collisions complete to unambiguous absolute paths", async () => {
		const external = path.join(dir, "external");
		const conventional = `${primary}.worktrees/collision`;
		await git(primary, "worktree", "add", "-b", "collision", external, first);
		await git(primary, "worktree", "add", "-b", "other", conventional, latest);
		const item = completeTrunkArguments("cd coll", primary)?.[0];
		expect(item).toBeDefined();
		const command = parseArgs(item!.value);
		expect(command).toEqual({ op: "cd", target: external });
		if (command.op !== "cd") throw new Error("Expected cd.");
		expect(resolveWorktree(await discoverRepository(primary), command.target).path).toBe(external);
	});

	test("quoted branch prefixes use the same escaping rules as command submission", async () => {
		const branch = 'feature/a\"quote';
		const linked = await addWorktree(await discoverRepository(primary), { branch, createBranch: true });
		const item = completeTrunkArguments('cd \"feature/a', primary)?.[0];
		expect(item).toBeDefined();
		const command = parseArgs(item!.value);
		expect(command).toEqual({ op: "cd", target: branch });
		if (command.op !== "cd") throw new Error("Expected cd.");
		expect(resolveWorktree(await discoverRepository(primary), command.target).path).toBe(linked.path);
		expect(completeTrunkArguments(item!.value, primary)).toEqual([]);
		expect(completeTrunkArguments(`cd '${branch}`, primary)?.map(candidate => parseArgs(candidate.value)))
			.toEqual([{ op: "cd", target: branch }]);
		for (const prefix of ["cd feature/ extra", "cd feature/ ", "remove feature/ extra", "add feature/", "list ", "cd bad\0"]) {
			expect(completeTrunkArguments(prefix, primary)).toBeNull();
		}
	});
});

describe("destination containment", () => {
	test("a symlinked base is refused without modifying the destination or branch refs", async () => {
		const repo = await discoverRepository(primary);
		const outside = path.join(dir, "outside");
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, repo.baseDir, "dir");
		await expect(addWorktree(repo, { branch: "escaped", createBranch: true })).rejects.toThrow(/symlink/u);
		expect(fs.readdirSync(outside)).toEqual([]);
		expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/escaped")).toBe("");
	});

	test("symlinks in slash-branch parents and dangling destination symlinks are refused", async () => {
		const repo = await discoverRepository(primary);
		const outside = path.join(dir, "outside");
		fs.mkdirSync(outside);
		fs.mkdirSync(repo.baseDir);
		fs.symlinkSync(outside, path.join(repo.baseDir, "feature"), "dir");
		await expect(addWorktree(repo, { branch: "feature/escaped", createBranch: true })).rejects.toThrow(/symlink/u);
		fs.symlinkSync(path.join(outside, "missing"), path.join(repo.baseDir, "dangling"), "dir");
		await expect(addWorktree(repo, { branch: "dangling", createBranch: true })).rejects.toThrow(/symlink/u);
		expect(fs.readdirSync(outside)).toEqual([]);
		expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/")).toBe("refs/heads/main");
	});

	test("an existing registered checkout cannot contain a new worktree", async () => {
		const repo = await discoverRepository(primary);
		const parent = path.join(repo.baseDir, "feature");
		await git(primary, "worktree", "add", "--detach", "--", parent, first);
		await expect(addWorktree(repo, { branch: "feature/inside", createBranch: true })).rejects.toThrow(/inside registered worktree/u);
		expect(fs.existsSync(path.join(parent, "inside"))).toBe(false);
		expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/feature/inside")).toBe("");
	});
});

describe("registered worktree selectors", () => {
	test("primary, branch, base-relative, absolute and explicit cwd-relative paths resolve", async () => {
		const repo = await discoverRepository(primary);
		const linked = await addWorktree(repo, { branch: "feature/topic", createBranch: true });
		const external = path.join(dir, "custom checkout");
		await git(primary, "worktree", "add", "-b", "custom-branch", "--", external, first);
		const alias = path.join(repo.baseDir, "path-alias");
		await git(primary, "worktree", "add", "-b", "different-branch", "--", alias, first);
		const fresh = await discoverRepository(primary);
		expect(resolveWorktree(fresh).path).toBe(primary);
		expect(resolveWorktree(fresh, "@").path).toBe(primary);
		expect(resolveWorktree(fresh, "main").path).toBe(primary);
		expect(resolveWorktree(fresh, "feature/topic").path).toBe(linked.path);
		expect(resolveWorktree(fresh, linked.path).path).toBe(linked.path);
		expect(resolveWorktree(fresh, path.relative(primary, linked.path)).path).toBe(linked.path);
		expect(resolveWorktree(fresh, ".").path).toBe(primary);
		expect(resolveWorktree(fresh, "custom-branch").path).toBe(external);
		expect(resolveWorktree(fresh, "path-alias").path).toBe(alias);
		expect(resolveWorktree(fresh, "different-branch").path).toBe(alias);
		const secondary = await discoverRepository(linked.path);
		expect(resolveWorktree(secondary).path).toBe(primary);
		expect(resolveWorktree(secondary, path.relative(linked.path, external)).path).toBe(external);
	});

	test("explicit relative paths disambiguate branch and conventional path collisions", async () => {
		const repo = await discoverRepository(primary);
		const external = path.join(dir, "collision-branch");
		const conventional = path.join(repo.baseDir, "collision");
		await git(primary, "worktree", "add", "-b", "collision", "--", external, first);
		await git(primary, "worktree", "add", "-b", "other-branch", "--", conventional, latest);
		const fresh = await discoverRepository(primary);
		expect(() => resolveWorktree(fresh, "collision")).toThrow(/Ambiguous/u);
		expect(resolveWorktree(fresh, conventional).branch).toBe("other-branch");
		expect(resolveWorktree(fresh, path.relative(primary, external)).branch).toBe("collision");
	});

	test("a blocked conventional base does not hide an existing registered branch", async () => {
		const repo = await discoverRepository(primary);
		fs.writeFileSync(repo.baseDir, "not a directory");
		expect(resolveWorktree(repo, "main").path).toBe(primary);
		await expect(addWorktree(repo, { branch: "new", createBranch: true })).rejects.toThrow(/parent is not a directory/u);
		expect(await git(primary, "for-each-ref", "--format=%(refname)", "refs/heads/new")).toBe("");
	});

	test("existing unregistered directories and worktree subdirectories are not selectors", async () => {
		const repo = await discoverRepository(primary);
		const unrelated = path.join(dir, "unrelated");
		const nested = path.join(primary, "nested");
		fs.mkdirSync(unrelated);
		fs.mkdirSync(nested);
		for (const target of [unrelated, "./nested", "not-registered", "", "bad\0path"]) {
			expect(() => resolveWorktree(repo, target)).toThrow(TrunkError);
		}
	});
});

describe("safe removal", () => {
	test("a clean linked worktree is removed without deleting its branch or unrelated files", async () => {
		const repo = await discoverRepository(primary);
		const linked = await addWorktree(repo, { branch: "feature/removable", createBranch: true, revision: first });
		const unrelated = path.join(dir, "keep.txt");
		fs.writeFileSync(unrelated, "keep");
		await removeWorktree(repo, linked);
		expect(fs.existsSync(linked.path)).toBe(false);
		expect(fs.existsSync(path.dirname(linked.path))).toBe(true);
		expect(await git(primary, "rev-parse", "refs/heads/feature/removable")).toBe(first);
		expect((await discoverRepository(primary)).worktrees.map(worktree => worktree.path)).toEqual([primary]);
		expect(fs.readFileSync(unrelated, "utf8")).toBe("keep");
	});

	test("primary and current checkouts are refused, including nested symlinked cwd", async () => {
		const repo = await discoverRepository(primary);
		await expect(removeWorktree(repo, resolveWorktree(repo))).rejects.toThrow(/primary/u);
		const linked = await addWorktree(repo, { branch: "current", createBranch: true });
		const nested = path.join(linked.path, "nested");
		fs.mkdirSync(nested);
		const cwdAlias = path.join(dir, "current-alias");
		fs.symlinkSync(nested, cwdAlias, "dir");
		const current = await discoverRepository(cwdAlias);
		await expect(removeWorktree(current, linked)).rejects.toThrow(/current/u);
		expect(fs.existsSync(linked.path)).toBe(true);
	});

	test("Git refuses tracked and untracked dirt without force", async () => {
		const repo = await discoverRepository(primary);
		const tracked = await addWorktree(repo, { branch: "dirty-tracked", createBranch: true });
		fs.writeFileSync(path.join(tracked.path, "file.txt"), "keep dirty change\n");
		await expect(removeWorktree(repo, tracked)).rejects.toThrow(TrunkError);
		expect(fs.readFileSync(path.join(tracked.path, "file.txt"), "utf8")).toBe("keep dirty change\n");
		const untracked = await addWorktree(repo, { branch: "dirty-untracked", createBranch: true });
		fs.writeFileSync(path.join(untracked.path, "new.txt"), "keep untracked");
		await expect(removeWorktree(repo, untracked)).rejects.toThrow(TrunkError);
		expect(fs.readFileSync(path.join(untracked.path, "new.txt"), "utf8")).toBe("keep untracked");
		expect(await git(primary, "rev-parse", "refs/heads/dirty-tracked")).toBe(latest);
		expect(await git(primary, "rev-parse", "refs/heads/dirty-untracked")).toBe(latest);
	});

	test("a lock set after discovery is respected by native Git", async () => {
		const repo = await discoverRepository(primary);
		const linked = await addWorktree(repo, { branch: "locked", createBranch: true });
		await git(primary, "worktree", "lock", "--reason", "keep mounted", "--", linked.path);
		await expect(removeWorktree(repo, linked)).rejects.toThrow(/locked/u);
		expect(fs.existsSync(linked.path)).toBe(true);
		expect((await discoverRepository(primary)).worktrees.find(worktree => worktree.branch === "locked")?.locked).toBe("keep mounted");
	});

	test("forged unregistered targets cannot remove arbitrary directories", async () => {
		const repo = await discoverRepository(primary);
		const unrelated = path.join(dir, "unregistered");
		fs.mkdirSync(unrelated);
		await expect(removeWorktree(repo, { path: unrelated, head: first, bare: false })).rejects.toThrow(/Not a registered/u);
		expect(fs.existsSync(unrelated)).toBe(true);
	});
});
