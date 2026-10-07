# Contributing

Bug reports, fixes and ideas are welcome. For anything larger than a fix, open an issue first so
the approach can be agreed before you write it.

## Setup

```sh
git clone https://github.com/vashuteotia123/lazyclaudecode.git && cd lazyclaudecode
npm link
npm test
```

There is nothing to install: lazyclaudecode has no dependencies and should stay that way. It runs on
Node 20 and later.

## Layout

| File | Role |
|---|---|
| `bin/lazyclaudecode.js` | Command line entry point and the shell subcommands |
| `src/store.js` | Read-only view of Claude Code's session store: scanning, branch trees, transcripts, search |
| `src/ops.js` | Everything that writes: tags, rename, trash, branch checkout, export |
| `src/tui.js` | The interface. `createApp()` is state and rendering with no terminal attached; `run()` connects it to one |
| `src/term.js` | Colours, width-aware truncation and wrapping, formatting |
| `scripts/demo-home.js` | Builds a fictional Claude home for screenshots and manual testing |
| `scripts/screenshots.js` | Renders the README screenshots from that home |

## Working on it

- **Never develop against your real `~/.claude`.** Build a demo home and point lazyclaudecode at it:

  ```sh
  node scripts/demo-home.js /tmp/lazyclaudecode-demo
  HOME=/tmp/lazyclaudecode-demo CLAUDE_CONFIG_DIR=/tmp/lazyclaudecode-demo/.claude lazyclaudecode
  ```

- `lazyclaudecode --frame 120x36 --keys 'jj3'` prints one frame as text after some keystrokes, which is
  the quickest way to check a rendering change.
- Tests build their own fixtures in a temporary folder. Add a test for any change to how sessions
  are read or written; `test/lazyclaudecode.test.js` shows how to build a session file by hand.
- If a change alters what the interface looks like, run `npm run screenshots` and commit the
  result. Add to the demo home if a new feature is not visible in it.

## Rules the code keeps

- A session file is only ever appended to (rename) or created (branch checkout). Nothing rewrites
  or deletes one; delete moves it to the trash.
- Transcript text is untrusted. Anything from a session passes through `clean()` before it reaches
  the terminal.
- No session data, real path or user name goes into the repository, including in tests,
  screenshots and issue reports.

## Releasing

1. Bump `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Merge that to `main`.
3. Publish a GitHub release whose tag is `v` plus the version, for example `v0.2.0`.

The `release` workflow then runs the tests, publishes the version to npm and attaches the package
to the release. It refuses a tag that does not match `package.json`, and skips the npm step when
that version is already published.
