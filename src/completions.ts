import * as path from "node:path";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { parseArgs, parseCompletionPrefix, SUBCOMMANDS } from "./args.ts";
import { discoverRepositoryForCompletion, resolveWorktree } from "./repository.ts";

function quoteSelector(selector: string): string {
	return /[\s"'\\]/u.test(selector) ? `"${selector.replace(/["\\]/gu, "\\$&")}"` : selector;
}

export function completeTrunkArguments(prefix: string, cwd: string): AutocompleteItem[] | null {
	try {
		const parsed = parseCompletionPrefix(prefix);
		if (!parsed) return null;
		const { subcommand, targetPrefix } = parsed;
		if (targetPrefix === undefined) {
			return Object.entries(SUBCOMMANDS)
				.filter(([name]) => name.startsWith(subcommand) && name !== subcommand)
				.map(([name, description]) => ({ value: `${name} `, label: name, description }));
		}
		if (subcommand !== "cd" && subcommand !== "remove") return null;
		const repo = discoverRepositoryForCompletion(cwd);
		const items: AutocompleteItem[] = [];
		for (const worktree of repo.worktrees) {
			const primary = worktree.path === repo.primaryPath;
			const relative = path.relative(worktree.path, repo.cwd);
			const current = relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
			if (subcommand === "remove" && (primary || current || worktree.locked !== undefined)) continue;
			if (/[\r\n\0]/u.test(worktree.path) || (subcommand === "cd" && worktree.path !== worktree.path.trimEnd())) continue;
			const selectors = [...(primary ? ["@"] : []), ...(worktree.branch ? [worktree.branch] : []), worktree.path];
			let selector: string | undefined = selectors.find(candidate => candidate.startsWith(targetPrefix));
			if (selector === undefined) continue;
			try {
				// A branch can collide with another checkout's conventional path. Insert an explicit path then.
				try {
					if (resolveWorktree(repo, selector).path !== worktree.path) selector = worktree.path;
				} catch {
					selector = worktree.path;
				}
				resolveWorktree(repo, selector);
			} catch {
				// Stale/prunable registrations must not turn completion into an error notification.
				continue;
			}
			// Like /swarm: an exact match must leave Enter free to submit, not accept a completion.
			if (selector === targetPrefix) {
				try {
					parseArgs(prefix);
					continue;
				} catch {
					// An unfinished quote/escape still needs a completion before it can be submitted.
				}
			}
			const labels = [worktree.branch ?? "detached HEAD", ...(primary ? ["primary"] : []), ...(current ? ["current"] : [])];
			items.push({
				value: `${subcommand} ${quoteSelector(selector)}`,
				label: selector,
				description: `${labels.join(", ")} — ${worktree.path}`,
			});
		}
		return items;
	} catch {
		// Completion is best-effort outside repositories or while Git/worktree paths are unavailable.
		return null;
	}
}
