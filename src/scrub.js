// Scrubbed copies of a session: the structure Claude Code wrote, with nothing anyone typed, read or
// ran. They become test fixtures and get attached to bug reports, so both end up public.
//
// Values survive only by name. A field on the KEEP list is copied as written; ids are swapped for
// fakes that keep every link intact; text is swapped for a numbered label, keeping only the harness
// tags that prompt detection looks for; timestamps keep their spacing but move to a fixed date.
// Any other field keeps its name and gets a placeholder of the same kind, so a field Claude Code
// starts writing tomorrow still shows up in a capture without its value.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildTree, readJson, readRecords, segmentTree } from './store.js';

// Copied as written. Every one is an enum, a flag, a version or a model name.
const KEEP = new Set([
  'type',
  'subtype',
  'version',
  'entrypoint',
  'userType',
  'role',
  'model',
  'stop_reason',
  'level',
  'operation',
  'mode',
  'permissionMode',
  'isSidechain',
  'isMeta',
  'isCompactSummary',
  'isVisibleInTranscriptOnly',
  'isApiErrorMessage',
  'is_error',
]);

const IDS = new Set([
  'uuid',
  'parentUuid',
  'logicalParentUuid',
  'sessionId',
  'session_id',
  'leafUuid',
  'messageId',
  'promptId',
  'requestId',
  'id',
  'tool_use_id',
  'toolUseID',
  'sourceToolUseID',
  'sourceToolAssistantUUID',
  'parentToolUseID',
  'snapshotMessageId',
  'interruptedMessageId',
  'commandUuid',
  'bridgeSessionId',
  'agentId',
]);

// Text a person or a tool produced. Replaced by a label, harness tags aside.
const TEXT = new Set(['text', 'content', 'lastPrompt', 'summary']);
const TITLES = new Set(['customTitle', 'aiTitle', 'agentName']);
// Tool input and output: dropped outright.
const DROP = new Set(['input', 'toolUseResult']);
// Token counts and cost are harmless and the detail pane shows them.
const COUNTS = new Set(['usage', 'totalCostUSD', 'prNumber']);

// Tags Claude Code wraps around harness text. promptText() decides what counts as a prompt from
// these, so they survive with their contents replaced (a command name excepted).
export const HARNESS_TAGS = [
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'task-notification',
  'system-reminder',
  'user-prompt-submit-hook',
];
const TAGGED = new RegExp(`<(${HARNESS_TAGS.join('|')})>([\\s\\S]*?)</\\1>`, 'g');
const KNOWN_PREFIXES = ['[Request interrupted by user', 'Caveat: The messages below'];
const BUILTIN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'output-style-setup', 'claude-code-guide']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;
const FIXED_START = Date.parse('2026-01-01T00:00:00Z');
const MAX_ARRAY = 5;

export function createScrubber() {
  const salt = crypto.randomBytes(16);
  const ids = new Map();
  const roots = new Map();
  const worktrees = new Map();
  const branches = new Map();
  const tools = new Map();
  const kept = new Set();
  let texts = 0;
  let base = null;

  const fake = (v) => {
    if (!ids.has(v)) {
      const h = crypto.createHmac('sha256', salt).update(v).digest('hex');
      ids.set(v, UUID.test(v) ? `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}` : `id_${h.slice(0, 12)}`);
    }
    return ids.get(v);
  };
  const numbered = (map, v, make) => {
    if (!map.has(v)) map.set(v, make(map.size + 1));
    return map.get(v);
  };
  const keep = (v) => {
    if (typeof v === 'string') kept.add(v);
    return v;
  };

  function cwd(v) {
    // A worktree path must still look like one, or it would no longer group under its repository.
    const wt = /^(.*)\/\.claude\/worktrees\/([^/]+)$/.exec(v);
    const root = (r) => numbered(roots, r, (n) => (n === 1 ? '/home/user/project' : `/home/user/project-${n}`));
    return wt ? `${root(wt[1])}/.claude/worktrees/${numbered(worktrees, wt[2], (n) => `worktree-${n}`)}` : root(v);
  }

  function time(v) {
    const t = Date.parse(v);
    if (!t) return '…';
    if (base === null) base = t;
    return new Date(FIXED_START + (t - base)).toISOString();
  }

  function text(v) {
    if (typeof v !== 'string' || !v.trim()) return v;
    const label = () => `text ${++texts}`;
    for (const p of KNOWN_PREFIXES) if (v.startsWith(p)) return keep(p);
    const out = [];
    let at = 0;
    const plain = (s) => {
      if (s.trim()) out.push(label());
    };
    const lead = /^\s*<([a-zA-Z][\w-]{0,40})>/.exec(v);
    if (lead && !HARNESS_TAGS.includes(lead[1])) {
      // An unfamiliar tag at the start is what drift detection looks for, so its name survives.
      keep(lead[1]);
      return `<${lead[1]}>${label()}</${lead[1]}>`;
    }
    for (const m of v.matchAll(TAGGED)) {
      plain(v.slice(at, m.index));
      const inner = m[1] === 'command-name' ? keep(/^\/?[\w:.-]{1,60}$/.test(m[2].trim()) ? m[2].trim() : '/command') : '…';
      out.push(`<${m[1]}>${inner}</${m[1]}>`);
      at = m.index + m[0].length;
    }
    plain(v.slice(at));
    return out.join('\n');
  }

  function tool(name) {
    // Built-in tools are CamelCase words; anything else (MCP, plugins) can name private systems.
    if (typeof name === 'string' && /^[A-Z][A-Za-z]{1,40}$/.test(name)) return keep(name);
    return numbered(tools, name, (n) => `mcp__server__tool_${n}`);
  }

  // A value with no rule: same kind, no content.
  function placeholder(v) {
    if (typeof v === 'string') return '…';
    if (typeof v === 'number') return 0;
    if (Array.isArray(v)) return v.slice(0, MAX_ARRAY).map(placeholder);
    if (v && typeof v === 'object') {
      const out = {};
      Object.entries(v).forEach(([k, x], i) => {
        out[IDENT.test(k) ? k : `key${i + 1}`] = placeholder(x);
      });
      return out;
    }
    return v;
  }

  const numbers = (v) => (typeof v === 'number' ? v : Array.isArray(v) ? [] : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => IDENT.test(k)).map(([k, x]) => [k, numbers(x)])) : placeholder(v));

  function value(key, v, parent) {
    if (v === null || v === undefined) return v;
    if (DROP.has(key)) return Array.isArray(v) ? [] : typeof v === 'object' ? {} : '…';
    if (KEEP.has(key) && typeof v !== 'object') return keep(v);
    if (IDS.has(key) && typeof v === 'string') return fake(v);
    if (key === 'timestamp' && typeof v === 'string') return time(v);
    if (key === 'cwd' && typeof v === 'string') return cwd(v);
    if (key === 'gitBranch' && typeof v === 'string') return v === 'HEAD' ? keep(v) : numbered(branches, v, (n) => `branch-${n}`);
    if (key === 'name' && parent?.type === 'tool_use') return tool(v);
    if (TITLES.has(key)) return 'Title';
    if (key === 'prUrl') return 'https://example.com/owner/repo/pull/1';
    if (key === 'prRepository') return 'owner/repo';
    if (COUNTS.has(key)) return numbers(v);
    if (TEXT.has(key) && typeof v === 'string') return parent?.type === 'tool_result' ? '…' : text(v);
    if (Array.isArray(v)) return key === 'content' ? v.map((x) => record(x)) : v.slice(0, MAX_ARRAY).map((x) => (x && typeof x === 'object' ? record(x) : placeholder(x)));
    if (typeof v === 'object') return record(v);
    return placeholder(v);
  }

  function record(d) {
    if (!d || typeof d !== 'object') return placeholder(d);
    const out = {};
    Object.entries(d).forEach(([k, v], i) => {
      out[IDENT.test(k) ? k : `key${i + 1}`] = value(k, v, d);
    });
    return out;
  }

  return {
    record,
    // Agent metadata: the built-in agent types are public names, anything else is not.
    agentMeta: (m) => ({ agentType: BUILTIN_AGENTS.has(m.agentType) ? keep(m.agentType) : 'agent', description: m.description ? 'description' : '' }),
    fake,
    kept: () => [...kept].sort(),
  };
}

const jsonl = (recs) => recs.map((d) => `${JSON.stringify(d)}\n`).join('');

// Write a scrubbed copy of a session and its subagents into `outDir`:
//   session.jsonl
//   subagents/agent-<id>.jsonl, agent-<id>.meta.json
export function captureSession(s, outDir) {
  const sc = createScrubber();
  const recs = readRecords(s.file).map((d) => sc.record(d));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'session.jsonl'), jsonl(recs));
  for (const a of s.agents || []) {
    const id = sc.fake(a.id);
    const sub = path.join(outDir, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), jsonl(readRecords(a.file).map((d) => sc.record(d))));
    const meta = readJson(path.join(path.dirname(a.file), `agent-${a.id}.meta.json`), {});
    fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify(sc.agentMeta(meta)));
  }
  return { dir: outDir, records: recs.length, agents: (s.agents || []).length, kept: sc.kept(), tree: segmentTree(buildTree(recs)) };
}

// The branch tree as the Branches panel draws it, for checking a capture by eye.
export function treeLines(seg, lead = '', last = true, depth = 0) {
  if (!seg) return [];
  const lines = seg.virtual ? [] : [`${depth ? lead + (last ? '└─ ' : '├─ ') : ''}${seg.active && !seg.children.length ? '* ' : '  '}${seg.prompts}p  "${seg.first.replace(/\s+/g, ' ').slice(0, 60)}"`];
  const inner = depth ? lead + (last ? '   ' : '│  ') : '';
  seg.children.forEach((k, i) => lines.push(...treeLines(k, seg.virtual ? '' : inner, i === seg.children.length - 1, seg.virtual ? 1 : depth + 1)));
  return lines;
}
