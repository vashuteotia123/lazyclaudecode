// Read-only view of Claude Code's session store: scanning, branch trees, transcripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const dataDir = (cd = claudeDir()) => path.join(cd, 'lazycode');
// Claude Code names a project's folder after its path with every non-alphanumeric replaced.
export const munge = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function readRecords(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = text.length;
    if (nl > pos) {
      try {
        const d = JSON.parse(text.slice(pos, nl));
        if (d && typeof d === 'object') out.push(d);
      } catch {
        // a partially written last line is expected while a session is live
      }
    }
    pos = nl + 1;
  }
  return out;
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

export function kindOf(d, side = false) {
  if (d.type !== 'user') return d.type;
  if (d.isSidechain && !side) return 'side';
  const content = d.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return 'toolres';
  if (d.isMeta) return 'meta';
  if (d.isCompactSummary) return 'compact';
  return 'prompt';
}

// What the human typed, or '' when the record is harness plumbing and not a prompt.
export function promptText(d) {
  const content = d.message?.content;
  let t = textOf(content);
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
    return `${cmd[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(t);
  if (bash) return `! ${bash[1].trim()}`;
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (/^<(local-command|bash-std|task-notification|command-message|user-prompt-submit-hook)/.test(t)) return '';
  if (/^\[Request interrupted/.test(t) || /^Caveat: The messages below/.test(t)) return '';
  if (!t && Array.isArray(content) && content.some((b) => b?.type === 'image')) return '[image]';
  return t;
}

// Link records into a tree by parentUuid. `np` is the number of prompts in a node's subtree and
// `last` the highest file position in it; together they separate real forks from parallel tool calls.
export function buildTree(recs, { side = false } = {}) {
  const nodes = new Map();
  recs.forEach((d, i) => {
    if (!d.uuid || nodes.has(d.uuid)) return;
    const prompt = kindOf(d, side) === 'prompt' ? promptText(d) : '';
    nodes.set(d.uuid, { d, i, uuid: d.uuid, parent: null, children: [], prompt, np: 0, last: i });
  });
  const roots = [];
  let prev = null;
  for (const n of nodes.values()) {
    // A compaction boundary has no parentUuid; logicalParentUuid keeps the history connected.
    // That message is not always in the file, and then the boundary follows whatever preceded it.
    let p = nodes.get(n.d.parentUuid) || nodes.get(n.d.logicalParentUuid);
    if (!p && n.d.type === 'system' && n.d.subtype === 'compact_boundary') p = prev;
    if (p && p !== n) {
      n.parent = p;
      p.children.push(n);
    } else roots.push(n);
    if (side || !n.d.isSidechain) prev = n;
  }
  const order = [];
  const stack = [...roots];
  const seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    order.push(n);
    for (const k of n.children) stack.push(k);
  }
  let active = null;
  for (let j = order.length - 1; j >= 0; j--) {
    const n = order[j];
    n.np += n.prompt ? 1 : 0;
    if (n.parent) {
      n.parent.np += n.np;
      if (n.last > n.parent.last) n.parent.last = n.last;
    }
    if ((side || !n.d.isSidechain) && (!active || n.i > active.i)) active = n;
  }
  return { nodes, roots, active };
}

export const promptKids = (n) => n.children.filter((k) => k.np > 0);

// The child the conversation continued through when there is no fork at `n`.
export function mainChild(n, activeSet) {
  const kids = promptKids(n);
  if (kids.length) return (activeSet && kids.find((k) => activeSet.has(k.uuid))) || kids[0];
  return n.children.reduce((a, b) => (!a || b.last > a.last ? b : a), null);
}

export function ancestors(n) {
  const out = [];
  const seen = new Set();
  for (let x = n; x && !seen.has(x); x = x.parent) {
    seen.add(x);
    out.push(x);
  }
  return out.reverse();
}

const stamp = (n) => Date.parse(n.d.timestamp) || 0;

function segment(head, activeSet) {
  const seg = { head: head.uuid, tip: head.uuid, first: '', prompts: 0, start: 0, end: 0, active: activeSet.has(head.uuid), children: [] };
  for (let n = head; n; ) {
    if (n.prompt) {
      seg.prompts++;
      if (!seg.first) seg.first = n.prompt.slice(0, 160);
    }
    const t = stamp(n);
    if (t) {
      seg.end = t;
      if (!seg.start) seg.start = t;
    }
    seg.tip = n.uuid;
    const kids = promptKids(n);
    if (kids.length >= 2) {
      seg.children = kids.map((k) => segment(k, activeSet));
      break;
    }
    n = mainChild(n);
  }
  return seg;
}

// Collapse the record tree into branch segments: each runs from a fork child to the next fork or tip.
export function segmentTree(tree) {
  const activeSet = new Set(ancestors(tree.active).map((n) => n.uuid));
  const roots = tree.roots.filter((r) => r.np > 0);
  if (roots.length === 1) return segment(roots[0], activeSet);
  if (roots.length > 1) {
    return { head: null, tip: null, first: '', prompts: 0, start: 0, end: 0, active: true, virtual: true, children: roots.map((r) => segment(r, activeSet)) };
  }
  const any = tree.roots.reduce((a, b) => (!a || b.last > a.last ? b : a), null);
  return any ? segment(any, activeSet) : null;
}

export const leafCount = (seg) => (!seg ? 0 : seg.children.length ? seg.children.reduce((n, k) => n + leafCount(k), 0) : 1);

function summarize(file, st) {
  const recs = readRecords(file);
  const dir = path.basename(path.dirname(file));
  const s = {
    id: path.basename(file, '.jsonl'),
    file,
    dir,
    size: st.size,
    mtime: st.mtimeMs,
    birth: st.birthtimeMs || st.mtimeMs,
    cwd: '',
    gitBranch: '',
    version: '',
    entrypoint: '',
    title: '',
    named: false,
    firstPrompt: '',
    lastPrompt: '',
    startedAt: 0,
    updatedAt: 0,
    prompts: 0,
    turns: 0,
    tools: 0,
    compactions: 0,
    models: [],
    tokensOut: 0,
    context: 0,
    cost: 0,
    prs: [],
    rootUuid: '',
    tree: null,
    branches: 0,
  };
  let custom = '';
  let agentName = '';
  let ai = '';
  let firstCwd = '';
  let lastUsage = null;
  const usage = new Map();
  const models = new Map();
  const prs = new Map();
  for (const d of recs) {
    if (d.type === 'custom-title') custom = d.customTitle || '';
    else if (d.type === 'agent-name') agentName = d.agentName || '';
    else if (d.type === 'ai-title') ai = d.aiTitle || '';
    else if (d.type === 'cost-state') s.cost = Math.max(s.cost, d.totalCostUSD || 0);
    else if (d.type === 'pr-link' && d.prUrl) prs.set(d.prUrl, { number: d.prNumber, url: d.prUrl, repo: d.prRepository });
    if (!d.uuid) continue;
    if (!s.rootUuid) s.rootUuid = d.uuid;
    const t = Date.parse(d.timestamp);
    if (t) {
      if (!s.startedAt || t < s.startedAt) s.startedAt = t;
      if (t > s.updatedAt) s.updatedAt = t;
    }
    if (d.cwd) {
      if (!firstCwd) firstCwd = d.cwd;
      if (!s.cwd && munge(d.cwd) === dir) s.cwd = d.cwd;
    }
    if (d.gitBranch) s.gitBranch = d.gitBranch;
    if (d.version) s.version = d.version;
    if (d.entrypoint && !s.entrypoint) s.entrypoint = d.entrypoint;
    if (d.isSidechain) continue;
    if (d.type === 'system' && d.subtype === 'compact_boundary') s.compactions++;
    if (d.type === 'assistant') {
      const m = d.message || {};
      if (m.model && m.model !== '<synthetic>') models.set(m.model, (models.get(m.model) || 0) + 1);
      if (Array.isArray(m.content)) s.tools += m.content.filter((b) => b?.type === 'tool_use').length;
      // One API message is split across several records that repeat its usage.
      if (m.id && m.usage) {
        usage.set(m.id, m.usage.output_tokens || 0);
        lastUsage = m.usage;
      }
    } else if (kindOf(d) === 'prompt') {
      const p = promptText(d);
      if (p) {
        s.prompts++;
        if (!s.firstPrompt) s.firstPrompt = p.slice(0, 300);
        s.lastPrompt = p.slice(0, 300);
      }
    }
  }
  s.cwd = s.cwd || firstCwd;
  s.turns = usage.size;
  for (const n of usage.values()) s.tokensOut += n;
  if (lastUsage) s.context = (lastUsage.input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0) + (lastUsage.cache_creation_input_tokens || 0);
  s.models = [...models.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  s.prs = [...prs.values()];
  s.named = Boolean(custom || agentName);
  s.title = custom || agentName || ai || s.firstPrompt.split('\n')[0].slice(0, 80) || '(no prompt)';
  s.startedAt = s.startedAt || s.birth;
  s.updatedAt = s.updatedAt || s.mtime;
  s.tree = segmentTree(buildTree(recs));
  s.branches = leafCount(s.tree);
  s.records = recs.length;
  return s;
}

function listSubagents(sessionFile) {
  const dir = path.join(sessionFile.slice(0, -'.jsonl'.length), 'subagents');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    const meta = readJson(path.join(dir, `agent-${m[1]}.meta.json`), {});
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    out.push({ id: m[1], file, type: meta.agentType || 'agent', name: meta.name || '', description: meta.description || '', size: st.size, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Claude Code registers each running process in sessions/<pid>.json.
function readLive(cd) {
  const live = new Map();
  let names = [];
  try {
    names = fs.readdirSync(path.join(cd, 'sessions'));
  } catch {
    return live;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const d = readJson(path.join(cd, 'sessions', name), null);
    if (!d?.sessionId || !d.pid || !alive(d.pid)) continue;
    live.set(d.sessionId, { pid: d.pid, status: d.status || 'idle', since: d.statusUpdatedAt || d.updatedAt || 0, kind: d.kind || '' });
  }
  return live;
}

// A linked git worktree belongs to its main repository's project.
function repoOf(cwd, memo) {
  if (memo.has(cwd)) return memo.get(cwd);
  let r = { root: cwd, worktree: '' };
  try {
    const m = /^gitdir:\s*(.+?)\/\.git\/worktrees\/[^/\n]+\s*$/m.exec(fs.readFileSync(path.join(cwd, '.git'), 'utf8'));
    if (m) r = { root: m[1], worktree: path.basename(cwd) };
  } catch {
    // .git is a directory (a main checkout) or the folder is gone
  }
  if (!r.worktree) {
    const m = /^(.*)\/\.claude\/worktrees\/([^/]+)$/.exec(cwd);
    if (m) r = { root: m[1], worktree: m[2] };
  }
  memo.set(cwd, r);
  return r;
}

// Bump when summarize() changes shape or meaning, so stale summaries are rebuilt.
const CACHE_VERSION = 4;

export function scan({ cd = claudeDir(), useCache = true } = {}) {
  const cacheFile = path.join(dataDir(cd), 'cache', 'index.json');
  const old = (useCache && readJson(cacheFile, null)) || {};
  const cache = old.v === CACHE_VERSION ? old : { v: CACHE_VERSION, files: {} };
  const next = { v: CACHE_VERSION, files: {} };
  let dirty = false;
  const projectsDir = path.join(cd, 'projects');
  const sessions = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    // no projects folder yet
  }
  for (const d of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(projectsDir, d.name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(projectsDir, d.name, name);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      let entry = cache.files[file];
      if (!entry || entry.mtime !== st.mtimeMs || entry.size !== st.size) {
        try {
          entry = { mtime: st.mtimeMs, size: st.size, s: summarize(file, st) };
        } catch {
          continue;
        }
        dirty = true;
      }
      next.files[file] = entry;
      if (entry.s.rootUuid) sessions.push({ ...entry.s, agents: listSubagents(file) });
    }
  }
  if (Object.keys(cache.files).length !== Object.keys(next.files).length) dirty = true;
  if (useCache && dirty) {
    try {
      writeJson(cacheFile, next);
    } catch {
      // the cache is an optimisation; a read-only home must not break the tool
    }
  }

  const live = readLive(cd);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const byRoot = new Map();
  const memo = new Map();
  const exists = new Map();
  for (const s of sessions) {
    s.live = live.get(s.id) || null;
    s.forks = [];
    s.forkParent = null;
    if (!byRoot.has(s.rootUuid)) byRoot.set(s.rootUuid, []);
    byRoot.get(s.rootUuid).push(s);
    const r = repoOf(s.cwd, memo);
    s.project = r.root;
    s.worktree = r.worktree;
    if (!exists.has(s.cwd)) exists.set(s.cwd, Boolean(s.cwd) && fs.existsSync(s.cwd));
    s.cwdMissing = !exists.get(s.cwd);
  }
  // Worktrees whose folder is gone can only be matched to their repository by name.
  const rootsByName = new Map();
  for (const s of sessions) if (!s.worktree) rootsByName.set(path.basename(s.project), s.project);
  for (const s of sessions) {
    const m = !s.worktree && /\/worktrees\/([^/]+)\/([^/]+)$/.exec(s.cwd);
    if (m && rootsByName.has(m[1]) && rootsByName.get(m[1]) !== s.project) {
      s.project = rootsByName.get(m[1]);
      s.worktree = m[2];
    }
  }
  // A fork copies its parent's history under a new session id and records no link back, so
  // sessions that start with the same message are one family and the oldest file is the parent.
  for (const s of sessions) {
    const family = byRoot.get(s.rootUuid);
    const oldest = family.reduce((a, b) => (b.birth < a.birth ? b : a));
    if (family.length > 1 && oldest !== s) s.forkParent = oldest.id;
  }
  for (const s of sessions) if (s.forkParent) byId.get(s.forkParent).forks.push(s.id);

  const projects = new Map();
  for (const s of sessions) {
    let p = projects.get(s.project);
    if (!p) projects.set(s.project, (p = { key: s.project, path: s.project, name: path.basename(s.project) || s.project, count: 0, updatedAt: 0, live: 0 }));
    p.count++;
    p.updatedAt = Math.max(p.updatedAt, s.updatedAt);
    if (s.live) p.live++;
  }
  const list = [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const seen = new Map();
  for (const p of list) seen.set(p.name, (seen.get(p.name) || 0) + 1);
  for (const p of list) if (seen.get(p.name) > 1) p.name = `${path.basename(path.dirname(p.path))}/${p.name}`;
  return { sessions, projects: list, byId };
}

function briefInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.query ?? input.url ?? input.skill ?? Object.values(input).find((x) => typeof x === 'string');
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 200) : '';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b?.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n');
}

// The conversation along one branch, as display items.
//   tip      end the path at this message (default: where the session currently is)
//   through  follow the conversation down from this message to its tip instead
//   from     flag items from this message on as `inSeg`
//   results  attach each tool call's output
export function loadTranscript(file, { tip, through, from, side = false, results = false } = {}) {
  const recs = readRecords(file);
  const tree = buildTree(recs, { side });
  const activeSet = new Set(ancestors(tree.active).map((n) => n.uuid));
  let end = tree.nodes.get(tip) || null;
  if (!end && through && tree.nodes.has(through)) {
    end = tree.nodes.get(through);
    for (let k = mainChild(end, activeSet); k; k = mainChild(k, activeSet)) end = k;
  }
  const nodes = ancestors(end || tree.active);
  const outputs = new Map();
  if (results) {
    for (const d of recs) {
      if (d.type !== 'user' || !Array.isArray(d.message?.content)) continue;
      for (const b of d.message.content) if (b?.type === 'tool_result') outputs.set(b.tool_use_id, resultText(b.content));
    }
  }
  const items = [];
  let inSeg = !from;
  for (const n of nodes) {
    if (n.uuid === from) inSeg = true;
    const d = n.d;
    const ts = stamp(n);
    if (n.prompt) items.push({ role: 'user', text: n.prompt, ts, uuid: n.uuid, inSeg });
    else if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) {
        if (b?.type === 'text' && b.text?.trim()) items.push({ role: 'assistant', text: b.text, ts, uuid: n.uuid, inSeg });
        else if (b?.type === 'tool_use') items.push({ role: 'tool', name: b.name, text: briefInput(b.name, b.input), output: outputs.get(b.id), ts, uuid: n.uuid, inSeg });
      }
    } else if (kindOf(d, side) === 'compact') items.push({ role: 'note', text: 'context compacted here', ts, uuid: n.uuid, inSeg });
    const forks = promptKids(n).length;
    if (forks >= 2 && n !== nodes[nodes.length - 1]) items.push({ role: 'fork', text: `fork point · ${forks} branches`, ts, uuid: n.uuid, inSeg });
  }
  return { items, tip: nodes.length ? nodes[nodes.length - 1].uuid : null };
}

// Count matches of `q` in what the human typed and what Claude said, across every branch.
export function searchSession(s, q) {
  const needle = q.toLowerCase();
  let raw;
  try {
    raw = fs.readFileSync(s.file, 'utf8');
  } catch {
    return null;
  }
  // Cheap reject before parsing: the text is JSON-escaped on disk.
  if (!raw.toLowerCase().includes(JSON.stringify(needle).slice(1, -1))) return null;
  let count = 0;
  let uuid = '';
  let snippet = '';
  for (const d of readRecords(s.file)) {
    if (!d.uuid || d.isSidechain) continue;
    let text = '';
    if (d.type === 'assistant') text = textOf(d.message?.content);
    else if (kindOf(d) === 'prompt') text = promptText(d);
    if (!text) continue;
    const low = text.toLowerCase();
    for (let at = low.indexOf(needle); at >= 0; at = low.indexOf(needle, at + needle.length)) {
      if (!count) {
        uuid = d.uuid;
        snippet = text.slice(Math.max(0, at - 40), at + needle.length + 60).replace(/\s+/g, ' ');
      }
      count++;
    }
  }
  return count ? { count, uuid, snippet } : null;
}
