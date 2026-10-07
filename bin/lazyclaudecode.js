#!/usr/bin/env node
import { exportMarkdown, loadConfig, loadMeta } from '../src/ops.js';
import { readJson, scan, searchSession } from '../src/store.js';
import { clean, fit, rel, strip, tilde } from '../src/term.js';
import { createApp, parseKeys, run } from '../src/tui.js';

const USAGE = `lazyclaudecode — a lazygit-style browser for Claude Code sessions

  lazycc                     open the interface
  lazycc list [--json]       print sessions, most recent first
  lazycc search <query>      find sessions whose prompts or replies mention the query
  lazycc export <id> [--full] [--out <dir>]
                             write one session as markdown (id may be a prefix)
  lazycc --version           print the version

lazycc is the short name for lazyclaudecode; both run the same program.

Press ? inside the interface for keys. Set CLAUDE_CONFIG_DIR to point at another Claude Code home.`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

function table(sessions, extra = () => '') {
  for (const s of sessions) {
    const marks = `${s.live ? '●' : ' '}${s.branches > 1 ? `⑂${s.branches}` : '  '}`;
    console.log(`${s.id.slice(0, 8)}  ${rel(s.updatedAt).padStart(6)}  ${fit(marks, 4)} ${fit(tilde(s.project).split('/').pop(), 22)} ${fit(clean(s.title), 50, false)}${extra(s)}`);
  }
}

const cmd = args[0];
if (flag('--help') || flag('-h')) console.log(USAGE);
else if (flag('--version') || flag('-v')) console.log(readJson(new URL('../package.json', import.meta.url), {}).version);
else if (cmd === 'list') {
  const sessions = scan().sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  if (flag('--json')) {
    const meta = loadMeta();
    console.log(JSON.stringify(sessions.map(({ tree, agents, ...s }) => ({ ...s, subagents: agents.length, ...meta.sessions[s.id] })), null, 2));
  } else table(sessions);
} else if (cmd === 'search') {
  const q = args.slice(1).join(' ');
  if (!q) throw new Error('usage: lazycc search <query>');
  const hits = new Map();
  const sessions = scan().sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of sessions) {
    const h = searchSession(s, q);
    if (h) hits.set(s.id, h);
  }
  table(sessions.filter((s) => hits.has(s.id)), (s) => `\n          ${hits.get(s.id).count}×  …${clean(hits.get(s.id).snippet)}…`);
} else if (cmd === 'export') {
  const { sessions } = scan();
  const found = sessions.filter((s) => args[1] && s.id.startsWith(args[1]));
  if (found.length !== 1) {
    console.error(found.length ? `"${args[1]}" matches ${found.length} sessions; give more of the id.` : `No session id starts with "${args[1] || ''}".`);
    process.exit(1);
  }
  const s = found[0];
  console.log(exportMarkdown(s, { full: flag('--full'), outDir: value('--out') || loadConfig().exportDir, tags: loadMeta().sessions[s.id]?.tags || [] }));
} else if (cmd === '--frame') {
  // Render one frame without a terminal, after optional keystrokes: lazycc --frame 120x36 --keys 'jj3'
  const [w, h] = (args[1] || '120x36').split('x').map(Number);
  const app = createApp({ sync: true });
  for (const k of parseKeys(JSON.parse(`"${value('--keys') || ''}"`))) {
    const action = app.key(k);
    if (action) console.log(`[action] ${JSON.stringify(action)}`);
  }
  console.log(app.frame(w, h).rows.map((r) => (flag('--color') ? r : strip(r))).join('\n'));
} else if (cmd) {
  console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
  process.exit(1);
} else if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error('lazyclaudecode needs an interactive terminal. Try "lazycc list".');
  process.exit(1);
} else run();
