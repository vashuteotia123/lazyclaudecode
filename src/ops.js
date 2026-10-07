// Everything that writes: the sidecar (tags, archive, pin), rename, trash, branch checkout, export.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ancestors, buildTree, claudeDir, dataDir, loadTranscript, munge, readJson, readRecords, writeJson } from './store.js';
import { dt, ymd } from './term.js';

const metaFile = (cd) => path.join(dataDir(cd), 'meta.json');
const trashDir = (cd) => path.join(dataDir(cd), 'trash');

export function loadMeta(cd = claudeDir()) {
  const m = readJson(metaFile(cd), null);
  return m && typeof m.sessions === 'object' ? m : { v: 1, sessions: {} };
}

export function saveMeta(meta, cd = claudeDir()) {
  for (const [id, e] of Object.entries(meta.sessions)) {
    if (!e.archived && !e.pinned && !(e.tags && e.tags.length)) delete meta.sessions[id];
  }
  writeJson(metaFile(cd), meta);
}

// Resolve a configured folder: `~` is the home directory, anything relative hangs off `base`.
export const expandDir = (dir, base = process.cwd()) => path.resolve(base, dir.replace(/^~(?=\/|$)/, os.homedir()));

export function loadConfig(cd = claudeDir()) {
  return { exportDir: './claude-exports', refreshSeconds: 5, sort: 'recent', ...readJson(path.join(dataDir(cd), 'config.json'), {}) };
}

// Same two records `/rename` writes, so the title also shows in Claude Code's own picker.
export function renameSession(s, title) {
  const size = fs.statSync(s.file).size;
  let lead = '';
  if (size) {
    const fd = fs.openSync(s.file, 'r');
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    fs.closeSync(fd);
    if (last[0] !== 10) lead = '\n';
  }
  const line = (d) => `${JSON.stringify({ ...d, sessionId: s.id })}\n`;
  fs.appendFileSync(s.file, lead + line({ type: 'custom-title', customTitle: title }) + line({ type: 'agent-name', agentName: title }));
}

export function trashSessions(list, cd = claudeDir()) {
  const ids = [];
  list.forEach((s, i) => {
    const trashId = `${Date.now()}${String(i).padStart(4, '0')}-${s.id}`;
    const dest = path.join(trashDir(cd), trashId);
    fs.mkdirSync(dest, { recursive: true });
    fs.renameSync(s.file, path.join(dest, `${s.id}.jsonl`));
    const side = s.file.slice(0, -'.jsonl'.length);
    let size = s.size;
    if (fs.existsSync(side)) {
      fs.renameSync(side, path.join(dest, s.id));
      for (const a of s.agents || []) size += a.size;
    }
    writeJson(path.join(dest, 'manifest.json'), { trashId, id: s.id, dir: s.dir, title: s.title, project: s.project, prompts: s.prompts, updatedAt: s.updatedAt, size, deletedAt: Date.now() });
    ids.push(trashId);
  });
  return ids;
}

export function listTrash(cd = claudeDir()) {
  let names = [];
  try {
    names = fs.readdirSync(trashDir(cd));
  } catch {
    return [];
  }
  return names
    .map((n) => readJson(path.join(trashDir(cd), n, 'manifest.json'), null))
    .filter((m) => m && m.trashId)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

const trashPath = (cd, trashId) => {
  if (!/^\d+-[0-9a-zA-Z-]+$/.test(trashId)) throw new Error(`bad trash id: ${trashId}`);
  return path.join(trashDir(cd), trashId);
};

export function restoreTrash(trashIds, cd = claudeDir()) {
  let restored = 0;
  const failed = [];
  for (const trashId of trashIds) {
    const src = trashPath(cd, trashId);
    const m = readJson(path.join(src, 'manifest.json'), null);
    const destDir = m && path.join(cd, 'projects', m.dir);
    if (!m || fs.existsSync(path.join(destDir, `${m.id}.jsonl`))) {
      failed.push(trashId);
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(path.join(src, `${m.id}.jsonl`), path.join(destDir, `${m.id}.jsonl`));
    if (fs.existsSync(path.join(src, m.id))) fs.renameSync(path.join(src, m.id), path.join(destDir, m.id));
    fs.rmSync(src, { recursive: true, force: true });
    restored++;
  }
  return { restored, failed };
}

export function purgeTrash(trashIds, cd = claudeDir()) {
  for (const trashId of trashIds) fs.rmSync(trashPath(cd, trashId), { recursive: true, force: true });
}

const CARRIED = new Set(['ai-title', 'custom-title', 'agent-name', 'mode', 'permission-mode']);

// Write one branch of a session out as a new session file and return its id. The source is not
// modified. Like Claude Code's own fork, records are copied as they are apart from the session id.
export function extractBranch(s, tipUuid, { cd = claudeDir(), destCwd = '', title = '' } = {}) {
  const recs = readRecords(s.file);
  const tree = buildTree(recs);
  const tip = (tipUuid && tree.nodes.get(tipUuid)) || tree.active;
  if (!tip) throw new Error('nothing to check out');
  const keep = new Set(ancestors(tip).map((n) => n.uuid));
  // Parallel tool results and attachments hang off the path as prompt-less side subtrees; a
  // sibling subtree that contains a prompt is a rival branch and stays behind.
  const stack = [...keep].map((u) => tree.nodes.get(u));
  while (stack.length) {
    const n = stack.pop();
    for (const k of n.children) {
      if (keep.has(k.uuid) || k.np > 0) continue;
      keep.add(k.uuid);
      stack.push(k);
    }
  }
  const id = crypto.randomUUID();
  const out = [];
  for (const d of recs) {
    if (d.uuid) {
      if (!keep.has(d.uuid)) continue;
      const copy = { ...d, sessionId: id };
      if ('session_id' in d) copy.session_id = id;
      if (destCwd && d.cwd) copy.cwd = destCwd;
      out.push(copy);
    } else if (CARRIED.has(d.type)) out.push({ ...d, sessionId: id });
  }
  if (title) out.push({ type: 'custom-title', customTitle: title, sessionId: id }, { type: 'agent-name', agentName: title, sessionId: id });
  const dir = destCwd ? path.join(cd, 'projects', munge(destCwd)) : path.dirname(s.file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), out.map((d) => `${JSON.stringify(d)}\n`).join(''), { flag: 'wx' });
  return id;
}

const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';

function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [fence, text, fence];
}

const OUTPUT_LINES = 300;

// Render one branch (or one subagent) as markdown and return the file written.
export function exportMarkdown(s, { tip, agent, full = false, outDir, tags = [] } = {}) {
  const { items } = loadTranscript(agent ? agent.file : s.file, { tip, side: Boolean(agent), results: full });
  const title = agent ? `${s.title} · ${agent.type}${agent.description ? `: ${agent.description}` : ''}` : s.title;
  const md = [`# ${title.replace(/\s+/g, ' ')}`, ''];
  const fact = (k, v) => v && md.push(`- **${k}:** ${v}`);
  fact('Project', s.cwd);
  fact('Git branch', s.gitBranch !== 'HEAD' && s.gitBranch);
  fact('Session', s.id);
  fact('Subagent', agent && agent.id);
  fact('Started', dt(s.startedAt));
  fact('Last active', dt(s.updatedAt));
  fact('Model', s.models.join(', '));
  fact('Tags', tags.join(', '));
  fact('Pull requests', s.prs.map((p) => p.url).join(', '));
  let speaker = '';
  const heading = (who, ts) => {
    if (speaker === who && who === 'Claude') return;
    speaker = who;
    md.push('', `## ${who}${ts ? ` · ${dt(ts)}` : ''}`, '');
  };
  for (const it of items) {
    if (it.role === 'user') {
      heading('You', it.ts);
      md.push(it.text);
      speaker = '';
    } else if (it.role === 'assistant') {
      heading('Claude', it.ts);
      md.push(it.text, '');
    } else if (it.role === 'tool') {
      heading('Claude', it.ts);
      md.push(`- \`${`${it.name}: ${it.text}`.replace(/`/g, "'")}\``);
      if (full && it.output) {
        const lines = it.output.split('\n');
        const shown = lines.slice(0, OUTPUT_LINES).join('\n');
        md.push('', ...fenced(shown));
        if (lines.length > OUTPUT_LINES) md.push(`_… ${lines.length - OUTPUT_LINES} more lines omitted_`);
        md.push('');
      }
    } else {
      md.push('', `> ${it.text}`);
      speaker = '';
    }
  }
  const suffix = agent ? `-agent-${agent.id.slice(0, 8)}` : tip ? `-branch-${tip.slice(0, 6)}` : '';
  const file = path.join(expandDir(outDir), `${ymd(s.startedAt)}-${slug(s.title)}-${s.id.slice(0, 8)}${suffix}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${md.join('\n').replace(/\n{3,}/g, '\n\n')}\n`);
  return file;
}
