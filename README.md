# omp-trunk

Convention-based Git worktree management for [OMP](https://github.com/can1357/oh-my-pi). `/trunk` lists, creates, removes, and navigates worktrees without replacing the current conversation.

## Install

Requires OMP 18.7 or newer and Git with `worktree list --porcelain -z` support.

```sh
omp plugin install github:bigs/omp-trunk
```

Start a new OMP session after installing. To work on a local clone instead:

```sh
git clone https://github.com/bigs/omp-trunk.git ~/Code/omp-trunk
cd ~/Code/omp-trunk
bun install
omp plugin link .
```

Start a new OMP session after linking. For a one-off session without installing the plugin:

```sh
omp -e ~/Code/omp-trunk/src/trunk.ts --cwd /path/to/repo
```

Install/link the plugin on the machine where OMP runs. With a remote Tern session, that is the remote host, not merely the Mac displaying it.

## Commands

```text
/trunk list
/trunk add <existing-branch> [--no-cd]
/trunk add -b <new-branch> [revision] [--no-cd]
/trunk cd [branch|path|@]
/trunk remove <branch|path>
/trunk help
```

Flags may appear before or after the positional arguments. Quote paths containing spaces.

### Create and enter

```text
/trunk add -b feature/auth
/trunk add -b fix/login origin/main
/trunk add -b experiment/parser HEAD~3 --no-cd
```

`-b` creates a new branch. Its source is the current checkout's `HEAD` unless a revision is supplied: an existing branch, remote-tracking ref, tag, or commit expression. Source refs must already exist locally; the plugin never fetches.

Without `-b`, `add` checks out an existing local branch. If no local branch exists, one uniquely matching remote-tracking branch creates a local tracking branch. Ambiguous remote matches fail; choose explicitly with `add -b <new-name> <remote>/<branch>`.

`add` navigates into the checkout by default. `--no-cd` creates it without moving the conversation. A branch already checked out elsewhere is refused; use `cd` to enter its existing worktree.

### Navigate

```text
/trunk cd feature/auth
/trunk cd @
/trunk cd
/trunk cd "/path/to/an existing worktree"
```

`@` and an omitted target select the primary checkout. A selector can be an exact branch name or a registered worktree path. Plain relative paths are resolved under the conventional worktree directory; `./` and `../` paths are relative to the current working directory. Ambiguous selectors require an explicit path. Navigation only accepts registered, available worktrees, including ones created by other tools.

Navigation delegates to OMP's native `/move`. That relocates the session and artifacts and refreshes workspace-derived settings, skills, commands, and repository context. It does not open another Tern tab or move other panes.

On the next agent turn, the plugin observes the live destination before adding a system-priority working-directory-change notice and a visible history message. It never starts an agent turn merely to announce navigation. A refused or failed `/move` produces no success notice; a newly created worktree remains available for a later `cd`.

### Remove

```text
/trunk cd @
/trunk remove feature/auth
```

Removal keeps the Git branch. It refuses the primary checkout and the checkout containing the current working directory. Git also refuses dirty or locked worktrees. There is no force-removal or branch-deletion flag.

`list` shows every registered worktree for the current repository, with its branch/HEAD, path, primary/current designation, and lock/prunable information—not just worktrees created by this plugin.

## Layout

For a primary checkout at `/path/repo`, creation uses:

```text
/path/repo/
/path/repo.worktrees/
  feature/auth/
  fix/login/
```

Branch slashes remain directory separators. This convention is anchored to the primary checkout even when invoked from a linked worktree or a subdirectory. Destination symlinks and paths that escape or overlap registered checkouts are refused.

There are no configuration files. Existing `.wtp.yml` files are ignored. The plugin does not depend on `wtp`, copy ignored build artifacts or uncommitted edits, or run custom pre/post hooks. Creation uses normal Git checkout semantics; repository-configured native Git hooks still belong to Git.

## Host boundaries

- Main-session commands only; subagents do not navigate with `/trunk`.
- Creation, removal, and navigation are refused while the agent is running or messages are queued.
- Navigation supports normal TUI submission and RPC **`prompt`** submission. OMP's native input hook is what lets the plugin hand off to `/move`.
- Do not submit navigation as RPC `steer`, `follow_up`, or `abort_and_prompt`: those host routes do not execute native `/move`, and OMP's input event does not expose which RPC route was used. A registered command invoked without input interception (for example, programmatically or in print/ACP mode) refuses navigation before creating anything; `list`, `remove`, and `add --no-cd` remain non-navigation operations.
- Navigation cannot preserve directory paths containing CR/LF/NUL or trailing whitespace through native slash-command parsing. It refuses them rather than moving somewhere else.
- Bare primary repositories are unsupported.

Native `/wt` and its `/worktree` alias remain untouched.

## Development

```sh
bun run check
bun test
```

Regression tests use isolated real Git repositories. They cover source revisions, slash branches, creation from linked checkouts, remote ambiguity, unusual registered paths, symlink containment, and safe removal.

Runtime verification exercised OMP 18.7 RPC navigation: actual process/session cwd, conversation retention, destination context refresh, system-priority notification, and removal safeguards. A native ANSI TUI smoke also exercised `add`, automatic navigation, `cd @`, and removal while preserving session identity. Temporary instrumentation used a local probe model and aborted policy capture before provider dispatch; no model request was needed.
