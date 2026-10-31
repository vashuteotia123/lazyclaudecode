# Changelog

## 0.2.0

Guarding against changes in Claude Code's undocumented session format.

- `lazycc doctor` lists the Claude Code versions your sessions come from and anything in them this
  version has not seen: new record types, or prompts that start with an unfamiliar tag. The
  interface says so once at startup when it finds any.
- `lazycc capture <id>` writes a scrubbed copy of a session for bug reports: its structure, with
  every prompt, reply, tool input and output, path, title and branch name replaced.
- Checking out a branch now reads the new session back and removes it if it is not that branch.
- The tests can run on scrubbed real sessions from each Claude Code version, and check branch
  rules every session must keep on those and on the demo home.
- A weekly check opens an issue when a Claude Code release is newer than the tested sessions.

## 0.1.0

First release.

- Browse every Claude Code session across all projects, with git worktrees grouped under their
  repository and running sessions marked.
- Branch tree for each session: rewind branches, session forks and subagents.
- Check out an abandoned branch or fork point as a new session without changing the original.
- Resume, fork and create sessions; rename, tag, pin and archive them.
- Filter the list, and search inside transcripts with highlighted matches.
- Trash with undo, restore and purge.
- Export a session, branch or subagent as markdown.
- `lazyclaudecode list`, `lazyclaudecode search` and `lazyclaudecode export` for use from the shell.
