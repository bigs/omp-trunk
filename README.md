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

`/trunk cd ` and `/trunk remove ` offer Tab completion from the repository's live registered worktrees. Suggestions prefer branch names, include `@` for the primary checkout with `cd`, and use absolute paths for detached or ambiguous targets. Paths and branch names needing quotes are inserted with the command parser's escaping rules; partially quoted input is supported. Exact, complete matches stop suggesting themselves so Enter submits normally.

`remove` suggestions omit the primary, current, locked, and unavailable checkouts. Completion does not check for dirty files; Git's removal safeguards still apply. Suggestions follow the current directory after navigation and include worktrees created by other tools.

### Create and enter

```text
/trunk add -b feature/auth
/trunk add -b fix/login origin/main
/trunk add -b experiment/parser HEAD~3 --no-cd
```

`-b` creates a new branch. Its source is the current checkout's `HEAD` unless a revision is supplied: an existing branch, remote-tracking ref, tag, or commit expression. Source refs must already exist locally; the plugin never fetches.

Without `-b`, `add` checks out an existing local branch. If no local branch exists, one uniquely matching remote-tracking branch creates a local tracking branch. Ambiguous remote matches fail; choose explicitly with `add -b <new-name> <remote>/<branch>`.

`add` runs configured WTP `post_create` hooks by default, then navigates into the checkout. `--no-cd` still runs the hooks but leaves the conversation in its current directory. A branch already checked out elsewhere is refused; use `cd` to enter its existing worktree.

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

Worktree layout remains convention-based: WTP's `defaults.base_dir` does not change it. The plugin does not depend on the `wtp` executable. Git creates a normal checkout; ignored files and uncommitted edits are not copied unless a configured hook explicitly does so. Repository-configured native Git hooks still belong to Git.

## Default post-create hooks

**Every `/trunk add` automatically runs `hooks.post_create` from `.wtp.yml` or `.wtp.yaml` in the primary checkout's root.** No opt-in flag or approval prompt is required, including with `--no-cd`. Review the configuration before adding worktrees in an unfamiliar repository: command hooks execute shell code with your account's permissions and inherited environment. File hooks can overwrite files or attach credentials; this is not a sandbox.

Configuration is always read from the primary checkout's filesystem, including uncommitted changes—not from the caller's linked checkout or the new branch. If neither file exists, or the configuration has no post-create hooks, creation proceeds without extra setup. Having both filenames is an error rather than an implicit precedence rule.

```yaml
version: "1.0"
hooks:
  post_create:
    - type: copy
      from: .env
      # For relative copy sources, omitted `to` defaults to `from`.
    - type: symlink
      from: .bin
      to: .bin
    - type: command
      command: pnpm install
      work_dir: .
      env:
        NODE_ENV: development
```

Hooks run sequentially after Git creates the checkout and before navigation. This is compatibility with WTP's `post_create` hooks, not its entire configuration: unrelated settings and other lifecycle sections are ignored. Invalid YAML, malformed hook entries, unknown hook types, and unsupported per-hook fields fail before creating a worktree or branch.

| Hook | Behavior |
| --- | --- |
| `copy` | Copy a file or directory recursively, including ignored content. Follows source symlinks, preserves file modes, and overwrites existing destination files. Requires `from`; `to` defaults to `from` only for a relative source. |
| `symlink` | Create a symlink with an absolute target. Requires both `from` and `to`, an existing source, and a destination that does not already exist. |
| `command` | Run `command` using `sh -c` in the new checkout. Optional `work_dir` changes its working directory; optional `env` is a mapping of strings overriding inherited environment variables. |

Path rules:

- Relative `from` paths are anchored to the primary checkout; relative `to` paths are anchored to the new checkout. Absolute paths are supported. Relative file-hook paths containing an escape outside their base are rejected; symlinks are not confined to that base.
- Relative command `work_dir` paths are anchored to the new checkout; absolute paths are also supported.
- File-hook paths are literal: neither `~` nor `$HOME` is expanded. Use a command hook when shell expansion is needed.
- Commands receive `GIT_WTP_REPO_ROOT` and `GIT_WTP_WORKTREE_PATH`, set to the primary and new checkout paths respectively, overriding configured values. Inherited `WTP_SHELL_INTEGRATION` is removed.
- Commands are noninteractive (stdin is closed). Hook progress and command output appear as OMP notifications; command output is reported on completion, retaining only the final combined 16 KiB of stdout/stderr. Avoid printing secrets.

For a canonical environment file in your home directory, use a repository-owned linking script instead of the copy example:

```yaml
hooks:
  post_create:
    - type: command
      command: bash scripts/link-env.sh
```

That script is supplied by your repository, not this plugin. It can link `$HOME/.config/kiki/dev.env` to `.env` while refusing to overwrite an existing file. Commands do not require `wtp` unless the command itself invokes it.

If a hook fails, later hooks stop and navigation is not requested. The error identifies the failed hook and the created checkout. The worktree, branch, and earlier hook effects remain: there is no rollback. Fix setup inside that checkout, then use `/trunk cd <branch>` to enter it. `cd`, `list`, and `remove` never rerun post-create hooks.

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

Regression tests use isolated real Git repositories. They cover source revisions, slash branches, creation from linked checkouts, remote ambiguity, unusual registered paths, symlink containment, safe removal, and WTP hook ordering, path/config anchoring, file modes, environment, validation, and partial-failure preservation.

Runtime verification exercised OMP 18.7 RPC navigation: actual process/session cwd, conversation retention, destination context refresh, system-priority notification, and removal safeguards. A native ANSI TUI smoke also exercised `add`, automatic navigation, `cd @`, and removal while preserving session identity. Temporary instrumentation used a local probe model and aborted policy capture before provider dispatch; no model request was needed.

Hook runtime verification exercised the actual OMP 18.7 RPC CLI with both config filenames: ordered copy/symlink/command setup, `--no-cd`, native navigation after setup, retained session identity, visible hook output without corrupting RPC framing, and failed setup from a linked checkout leaving the new worktree registered without navigating. No model request was made.

Completion runtime verification exercised the actual OMP 18.7 ANSI TUI: visible `cd` and `remove` target menus, Tab insertion, one-Enter submission after an exact completion, native navigation, removal from the destination checkout, and disappearance of removed worktrees from subsequent suggestions. Regression tests also cover detached/quoted paths, ambiguous selectors, incomplete quotes, current/locked/unavailable filtering, and live Git state.
