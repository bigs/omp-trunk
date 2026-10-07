import { describe, expect, test } from "bun:test";
import { parseArgs, SUBCOMMANDS } from "../src/args";
import { TrunkError } from "../src/repository";

describe("command grammar", () => {
	test("empty input and help show help", () => {
		expect(parseArgs("")).toEqual({ op: "help" });
		expect(parseArgs("  \t ")).toEqual({ op: "help" });
		expect(parseArgs("help")).toEqual({ op: "help" });
		expect(parseArgs("list")).toEqual({ op: "list" });
		expect(Object.keys(SUBCOMMANDS).sort()).toEqual(["add", "cd", "help", "list", "remove"]);
	});

	test("navigation accepts a single registered selector", () => {
		expect(parseArgs("cd")).toEqual({ op: "cd" });
		expect(parseArgs("cd @")).toEqual({ op: "cd", target: "@" });
		expect(parseArgs("cd feature/topic")).toEqual({ op: "cd", target: "feature/topic" });
		expect(parseArgs('cd "../repo with spaces.worktrees/topic"')).toEqual({ op: "cd", target: "../repo with spaces.worktrees/topic" });
		expect(parseArgs("remove './linked checkout'")).toEqual({ op: "remove", target: "./linked checkout" });
	});

	test("add uses an existing branch and navigates by default", () => {
		expect(parseArgs("add feature/topic")).toEqual({ op: "add", branch: "feature/topic", createBranch: false, cd: true });
		for (const args of ["add feature/topic --no-cd", "add --no-cd feature/topic"]) {
			expect(parseArgs(args)).toEqual({ op: "add", branch: "feature/topic", createBranch: false, cd: false });
		}
	});

	test("new branches accept source revisions and flags around positional arguments", () => {
		for (const args of [
			"add -b feature/topic HEAD~1 --no-cd",
			"add --no-cd -b feature/topic HEAD~1",
			"add feature/topic -b --no-cd HEAD~1",
			"add feature/topic HEAD~1 --no-cd -b",
		]) {
			expect(parseArgs(args)).toEqual({ op: "add", branch: "feature/topic", createBranch: true, revision: "HEAD~1", cd: false });
		}
		expect(parseArgs("add -b new-branch")).toEqual({ op: "add", branch: "new-branch", createBranch: true, cd: true });
		expect(parseArgs("add -b new-branch origin/source")).toMatchObject({ revision: "origin/source" });
	});

	test("quotes and escapes compose tokens without shell interpretation", () => {
		expect(parseArgs("cd ../linked\\ checkout")).toEqual({ op: "cd", target: "../linked checkout" });
		expect(parseArgs('cd ./"linked "checkout')).toEqual({ op: "cd", target: "./linked checkout" });
		expect(parseArgs('cd "./a\\\"b\\\\c"')).toEqual({ op: "cd", target: './a"b\\c' });
		expect(parseArgs("cd './literal\\backslash'")).toEqual({ op: "cd", target: "./literal\\backslash" });
		for (const literal of ["$HOME", "$(touch sentinel)", "`touch sentinel`", "~/checkout", "a;b", "*"]) {
			expect(parseArgs(`cd '${literal}'`)).toEqual({ op: "cd", target: literal });
		}
	});

	test("bad grammar is rejected rather than silently discarded", () => {
		for (const args of [
			"unknown", "--help", "constructor", "toString", "help extra", "list extra", "list --no-cd",
			"cd first second", "cd --no-cd", "remove", "remove first second", "remove -f topic",
			"add", "add -b", "add --no-cd", "add existing HEAD", "add -b new HEAD extra",
			"add --force topic", "add -B topic", "add -- topic", "add -b -b topic",
			"add --no-cd topic --no-cd", 'cd ""', "remove ''", "add -b topic ''",
			'cd "unterminated', "cd 'unterminated", "cd dangling\\", "cd bad\0path",
		]) {
			expect(() => parseArgs(args), args).toThrow(TrunkError);
		}
	});
});
