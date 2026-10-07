// The interface. createApp() is pure state + rendering (frame/key) so it can be driven from tests;
// run() attaches it to a real terminal.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { claudeDir, loadTranscript, scan, searchSession } from './store.js';
import { expandDir, exportMarkdown, extractBranch, listTrash, loadConfig, loadMeta, purgeTrash, renameSession, restoreTrash, saveMeta, trashSessions } from './ops.js';
import { bytes, c, clean, dt, dur, fit, highlight, num, rel, strip, tilde, width, wrap } from './term.js';

const PANELS = ['projects', 'sessions', 'branches'];
const SORTS = ['recent', 'created', 'prompts', 'size'];
const TAG_COLORS = [c.cyan, c.magenta, c.blue, c.yellow, c.green, c.red];
const tagColor = (t) => {
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const HELP = [
  ['Move', ''],
  ['1 2 3 · tab · h l', 'switch panel'],
  ['j k · g G · ctrl-d ctrl-u', 'move in the list'],
  ['J K · PgDn PgUp', 'scroll the detail pane'],
  ['', ''],
  ['Sessions', ''],
  ['enter', 'resume (asks first if it is already running)'],
  ['f', 'fork into a new session'],
  ['c', 'create a new session in this project'],
  ['r', 'rename'],
  ['t', 'tag: "wip -blocked" adds wip, removes blocked'],
  ['p', 'pin to the top'],
  ['a', 'archive / unarchive'],
  ['d', 'move to trash'],
  ['u', 'undo the last delete'],
  ['e · E', 'export markdown · with tool output'],
  ['y', 'copy session id'],
  ['', ''],
  ['Branches', ''],
  ['enter', 'check out an old branch or fork point as a new session'],
  ['e · E', 'export that branch or subagent'],
  ['', ''],
  ['Find', ''],
  ['/', 'filter by title, prompt, git branch, path, #tag'],
  ['s', 'search inside transcripts'],
  ['n N', 'next / previous match'],
  ['o', 'change sort order'],
  ['H', 'show archived and empty sessions'],
  ['esc', 'clear marks, then search, then filter'],
  ['', ''],
  ['Several at once', ''],
  ['space', 'mark / unmark'],
  ['v', 'mark a range'],
  ['*', 'mark everything listed'],
  ['', ''],
  ['Other', ''],
  ['T', 'trash: enter restores, d purges, X empties'],
  ['z', 'full or condensed transcript'],
  ['R', 'rescan'],
  ['q', 'quit'],
];

export function createApp({ cd = claudeDir(), sync = false, useCache = true, cwd = process.cwd() } = {}) {
  const config = loadConfig(cd);
  let meta = loadMeta(cd);
  let data = scan({ cd, useCache });
  let trash = [];
  let onChange = () => {};
  const S = {
    focus: 'sessions',
    view: 'sessions',
    mode: 'normal',
    projKey: null,
    sessId: null,
    sessIdx: 0,
    brSel: 0,
    trashSel: 0,
    top: { projects: 0, sessions: 0, branches: 0 },
    scroll: 0,
    anchored: '',
    filter: '',
    sort: SORTS.includes(config.sort) ? config.sort : 'recent',
    showHidden: false,
    full: false,
    marks: new Set(),
    range: null,
    search: null,
    undo: [],
    msg: '',
    input: null,
    confirm: null,
  };
  const transcripts = new Map();
  let rendered = { key: '', lines: [], anchor: -1 };
  let loadTimer = null;
  let lastDetail = { lines: [], matches: [], height: 0 };

  const metaOf = (id) => meta.sessions[id] || {};
  const tagsOf = (id) => metaOf(id).tags || [];
  const say = (m) => {
    S.msg = m;
  };
  const setMeta = (list, fn) => {
    for (const s of list) {
      const e = (meta.sessions[s.id] = meta.sessions[s.id] || {});
      fn(e);
    }
    saveMeta(meta, cd);
  };

  function refresh() {
    data = scan({ cd, useCache });
    meta = loadMeta(cd);
    if (S.view === 'trash') trash = listTrash(cd);
    for (const id of S.marks) if (S.view !== 'trash' && !data.byId.has(id)) S.marks.delete(id);
  }

  function matches(s, filter) {
    if (!filter) return true;
    const tags = tagsOf(s.id);
    const hay = `${s.title}\n${s.firstPrompt}\n${s.lastPrompt}\n${s.gitBranch}\n${s.cwd}\n${s.worktree}\n${s.id}\n${tags.join(' ')}`.toLowerCase();
    return filter
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => (term[0] === '#' && term.length > 1 ? tags.some((t) => t.toLowerCase() === term.slice(1)) : hay.includes(term)));
  }

  function view() {
    const projects = [{ key: null, name: 'All projects', path: '', count: data.sessions.length, live: data.sessions.filter((s) => s.live).length }, ...data.projects];
    let pi = projects.findIndex((p) => p.key === S.projKey);
    if (pi < 0) {
      pi = 0;
      S.projKey = null;
    }
    const hidden = { empty: 0, archived: 0 };
    let sessions = data.sessions.filter((s) => {
      if (S.projKey !== null && s.project !== S.projKey) return false;
      if (S.search && !S.search.hits.has(s.id)) return false;
      if (!matches(s, S.filter)) return false;
      const archived = metaOf(s.id).archived;
      const empty = !s.turns && !s.live;
      if (archived) hidden.archived++;
      else if (empty) hidden.empty++;
      return S.showHidden || (!archived && !empty);
    });
    const by = {
      recent: (a, b) => b.updatedAt - a.updatedAt,
      created: (a, b) => b.startedAt - a.startedAt,
      prompts: (a, b) => b.prompts - a.prompts,
      size: (a, b) => b.size - a.size,
    }[S.sort];
    sessions = sessions.sort((a, b) => Boolean(metaOf(b.id).pinned) - Boolean(metaOf(a.id).pinned) || by(a, b));
    let si = sessions.findIndex((s) => s.id === S.sessId);
    if (si < 0) si = clamp(S.sessIdx, 0, Math.max(0, sessions.length - 1));
    S.sessIdx = si;
    const sess = sessions[si] || null;
    S.sessId = sess ? sess.id : null;
    const rows = sess ? branchRows(sess) : [];
    S.brSel = clamp(S.brSel, 0, Math.max(0, rows.length - 1));
    S.trashSel = clamp(S.trashSel, 0, Math.max(0, trash.length - 1));
    return { projects, pi, sessions, si, sess, rows, hidden };
  }

  function branchRows(s) {
    const rows = [];
    const walk = (seg, lead, last, depth) => {
      rows.push({ type: 'seg', seg, prefix: depth ? lead + (last ? '└─ ' : '├─ ') : '' });
      const inner = depth ? lead + (last ? '   ' : '│  ') : '';
      seg.children.forEach((k, i) => walk(k, inner, i === seg.children.length - 1, depth + 1));
    };
    if (s.tree?.virtual) s.tree.children.forEach((k, i) => walk(k, '', i === s.tree.children.length - 1, 1));
    else if (s.tree) walk(s.tree, '', true, 0);
    if (s.forkParent) rows.push({ type: 'link', id: s.forkParent, label: 'forked from' });
    for (const id of s.forks) rows.push({ type: 'link', id, label: 'fork' });
    for (const agent of s.agents) rows.push({ type: 'agent', agent });
    return rows;
  }

  // ---- rows ---------------------------------------------------------------------------------

  function sessionRow(s, w, allProjects) {
    const m = metaOf(s.id);
    const mark = S.marks.has(s.id) ? c.cyan('✓') : ' ';
    const state = s.live ? (s.live.status === 'busy' ? c.green('●') : c.yellow('●')) : m.pinned ? c.yellow('★') : ' ';
    const right = [];
    if (w > 46) for (const t of (m.tags || []).slice(0, 2)) right.push(tagColor(t)(`#${t}`));
    if (S.search) right.push(c.yellow(`${S.search.hits.get(s.id)?.count ?? 0}×`));
    if (s.branches > 1) right.push(c.yellow(`⑂${s.branches}`));
    if (s.forkParent) right.push(c.yellow('⑂'));
    if (s.agents.length) right.push(c.dim(`◇${s.agents.length}`));
    if (s.entrypoint && s.entrypoint !== 'cli') right.push(c.dim('script'));
    if (allProjects && w > 58) right.push(c.dim(fit(s.worktree || s.project.split('/').pop(), 14, false)));
    right.push(c.dim(rel(S.sort === 'created' ? s.startedAt : s.updatedAt).padStart(3)));
    const tail = right.join(' ');
    let title = clean(s.title);
    if (m.archived) title = c.dim(`${title} (archived)`);
    else if (!s.turns && !s.live) title = c.dim(title);
    return `${mark}${state} ${fit(title, w - 4 - width(tail))} ${tail}`;
  }

  function branchRow(row, s, w) {
    if (row.type === 'seg') {
      const { seg } = row;
      const leaf = !seg.children.length;
      const star = seg.active && leaf ? c.green('* ') : '  ';
      const tail = c.dim(`${seg.prompts}p ${rel(seg.end).padStart(3)}`);
      const label = seg.first ? `"${clean(seg.first)}"` : '(no prompt)';
      const text = seg.active ? label : c.dim(label);
      return `${c.dim(row.prefix)}${star}${fit(text, w - width(row.prefix) - 3 - width(tail))} ${tail}`;
    }
    if (row.type === 'link') return fit(`${c.yellow('⑂')} ${c.dim(`${row.label}:`)} ${clean(data.byId.get(row.id)?.title || row.id)}`, w);
    const a = row.agent;
    return fit(`${c.dim('◇')} ${c.cyan(a.name || a.type)} ${c.dim(clean(a.description))}`, w);
  }

  // ---- detail pane --------------------------------------------------------------------------

  const kv = (k, v) => `${c.dim(k.padEnd(10))}${v}`;

  function sessionInfo(s, w) {
    const m = metaOf(s.id);
    const lines = [c.bold(fit(clean(s.title), w, false))];
    lines.push(kv('id', s.id));
    lines.push(kv('project', tilde(s.cwd) + (s.cwdMissing ? c.red('  directory missing') : '')));
    if (s.worktree) lines.push(kv('worktree', `${s.worktree} ${c.dim(`of ${tilde(s.project)}`)}`));
    if (s.gitBranch && s.gitBranch !== 'HEAD') lines.push(kv('git', s.gitBranch));
    const status = s.live ? `${s.live.status === 'busy' ? c.green('● busy') : c.yellow('● idle')} ${c.dim(`pid ${s.live.pid}${s.live.since ? ` · for ${dur(Date.now() - s.live.since)}` : ''}`)}` : c.dim('not running');
    lines.push(kv('status', status + (m.archived ? c.dim(' · archived') : '') + (m.pinned ? c.yellow(' · pinned') : '')));
    lines.push(kv('started', `${dt(s.startedAt)} ${c.dim(`· ${rel(s.startedAt)} ago`)}`));
    lines.push(kv('active', `${dt(s.updatedAt)} ${c.dim(`· span ${dur(s.updatedAt - s.startedAt)}`)}`));
    lines.push(kv('messages', `${plural(s.prompts, 'prompt')} · ${plural(s.turns, 'reply', 'replies')} · ${plural(s.tools, 'tool call')}`));
    const shape = [plural(s.branches, 'branch', 'branches')];
    if (s.agents.length) shape.push(plural(s.agents.length, 'subagent'));
    if (s.compactions) shape.push(plural(s.compactions, 'compaction'));
    lines.push(kv('branches', shape.join(' · ')));
    if (s.models.length) lines.push(kv('model', s.models.join(', ')));
    if (s.tokensOut) lines.push(kv('tokens', `${num(s.tokensOut)} out · context ${num(s.context)}${s.cost ? ` · ~$${s.cost.toFixed(2)}` : ''}`));
    if (m.tags?.length) lines.push(kv('tags', m.tags.map((t) => tagColor(t)(`#${t}`)).join(' ')));
    for (const p of s.prs) lines.push(kv('PR', `#${p.number} ${c.dim(p.url)}`));
    if (s.forkParent) lines.push(kv('forked', `from ${clean(data.byId.get(s.forkParent)?.title || s.forkParent)}`));
    if (s.lastPrompt && s.prompts > 1) lines.push(kv('last', fit(`"${clean(s.lastPrompt)}"`, Math.max(10, w - 10), false)));
    lines.push(kv('file', c.dim(`${bytes(s.size)} · Claude Code ${s.version || '?'}`)));
    return lines;
  }

  function projectInfo(v, w) {
    const p = v.projects[v.pi];
    const list = data.sessions.filter((s) => p.key === null || s.project === p.key);
    const lines = [c.bold(p.name)];
    if (p.path) lines.push(kv('path', tilde(p.path) + (fs.existsSync(p.path) ? '' : c.red('  directory missing'))));
    lines.push(kv('sessions', `${list.length} · ${list.filter((s) => s.live).length} running`));
    lines.push(kv('prompts', String(list.reduce((n, s) => n + s.prompts, 0))));
    lines.push(kv('on disk', bytes(list.reduce((n, s) => n + s.size + s.agents.reduce((x, a) => x + a.size, 0), 0))));
    if (list.length) {
      lines.push(kv('first', dt(Math.min(...list.map((s) => s.startedAt)))));
      lines.push(kv('latest', dt(Math.max(...list.map((s) => s.updatedAt)))));
    }
    const gits = [...new Set(list.map((s) => s.gitBranch).filter((b) => b && b !== 'HEAD'))];
    if (gits.length) lines.push(kv('git', fit(gits.join(', '), Math.max(10, w - 10), false)));
    const trees = [...new Set(list.map((s) => s.worktree).filter(Boolean))];
    if (trees.length) lines.push(kv('worktrees', trees.join(', ')));
    lines.push('', c.dim('Recent'));
    for (const s of [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12)) lines.push(`${c.dim(rel(s.updatedAt).padStart(6))}  ${clean(s.title)}`);
    return lines;
  }

  function renderTranscript(items, w, full, markStart) {
    const lines = [];
    let anchor = -1;
    let tools = [];
    const flush = () => {
      if (!tools.length) return;
      if (full) for (const t of tools) lines.push(c.dim(`  ⏺ ${t.name} ${clean(t.text)}`));
      else lines.push(c.dim(`  ⏺ ${[...new Set(tools.map((t) => t.name))].join(', ')}${tools.length > 1 ? ` (${tools.length} tools)` : ` ${clean(tools[0].text)}`}`));
      tools = [];
    };
    const capped = (text, cap, style) => {
      const all = wrap(text, w - 2);
      const shown = full ? all : all.slice(0, cap);
      for (const l of shown) lines.push(`  ${style(l)}`);
      if (all.length > shown.length) lines.push(c.dim(`  … ${all.length - shown.length} more lines (z for all)`));
    };
    for (const it of items) {
      if (it.role === 'tool') {
        tools.push(it);
        continue;
      }
      flush();
      if (it.inSeg && anchor < 0) {
        anchor = lines.length;
        if (markStart) lines.push('', c.yellow('── this branch starts here ──'));
      }
      if (it.role === 'user') {
        lines.push('', `${c.cyan('❯')} ${c.dim(dt(it.ts))}`);
        capped(it.text, 8, c.bold);
      } else if (it.role === 'assistant') capped(it.text, 10, (l) => l);
      else if (it.role === 'fork') lines.push(c.yellow(`  ⑂ ${it.text}`));
      else lines.push(c.dim(`  ── ${it.text} ──`));
    }
    flush();
    return { lines, anchor: Math.max(0, anchor) };
  }

  function detailSpec(v) {
    if (S.mode === 'help') {
      return { key: 'help', head: () => HELP.map(([k, d]) => (d ? `  ${c.cyan(k.padEnd(28))}${d}` : k ? c.bold(k) : '')) };
    }
    if (S.view === 'trash') {
      const t = trash[S.trashSel];
      if (!t) return { key: 'trash', head: () => [c.dim('Trash is empty.')] };
      return {
        key: `trash:${t.trashId}`,
        head: () => [c.bold(clean(t.title)), kv('id', t.id), kv('project', tilde(t.project)), kv('deleted', `${dt(t.deletedAt)} ${c.dim(`· ${rel(t.deletedAt)} ago`)}`), kv('prompts', String(t.prompts)), kv('size', bytes(t.size)), '', c.dim('enter restores · d purges for good')],
      };
    }
    if (S.focus === 'projects') return { key: 'project', head: (w) => projectInfo(v, w) };
    const s = v.sess;
    if (!s) return { key: 'none', head: () => [c.dim(S.search && !S.search.done ? 'Searching…' : 'No sessions match.')] };
    const row = S.focus === 'branches' ? v.rows[S.brSel] : null;
    if (row?.type === 'link') return { key: `link:${row.id}`, head: (w) => sessionInfo(data.byId.get(row.id), w) };
    if (row?.type === 'agent') {
      const a = row.agent;
      return {
        key: `agent:${a.file}:${a.mtime}`,
        head: (w) => [c.bold(fit(`◇ ${a.name || a.type}`, w, false)), kv('type', a.type), ...wrap(a.description, Math.max(10, w - 10)).slice(0, 4).map((l, i) => kv(i ? '' : 'task', l)), kv('finished', dt(a.mtime)), kv('size', bytes(a.size))],
        load: () => loadTranscript(a.file, { side: true }),
      };
    }
    if (row?.type === 'seg') {
      const { seg } = row;
      const leaf = !seg.children.length;
      return {
        key: `seg:${s.id}:${s.mtime}:${seg.tip}`,
        head: () => [
          c.bold(seg.active && leaf ? 'Active branch' : leaf ? 'Abandoned branch' : `Fork point · ${seg.children.length} branches`),
          kv('prompts', `${seg.prompts} on this stretch`),
          kv('from', dt(seg.start)),
          kv('to', dt(seg.end)),
          c.dim(seg.active && leaf ? 'enter resumes the session here' : 'enter opens this as a new session'),
        ],
        load: () => loadTranscript(s.file, { tip: seg.tip, from: seg.head }),
        markStart: Boolean(seg.head) && seg.head !== s.rootUuid,
      };
    }
    const hit = S.search?.hits.get(s.id);
    return { key: `sess:${s.id}:${s.mtime}:${hit ? hit.uuid : ''}`, head: (w) => sessionInfo(s, w), load: () => loadTranscript(s.file, hit ? { through: hit.uuid } : {}) };
  }

  function detailLines(v, w) {
    const spec = detailSpec(v);
    let lines = spec.head(w);
    let anchor = 0;
    if (spec.load) {
      const full = S.full || Boolean(S.search);
      let t = transcripts.get(spec.key);
      if (!t && sync) {
        t = spec.load();
        transcripts.set(spec.key, t);
      }
      if (!t) {
        clearTimeout(loadTimer);
        // Parsing a large session takes a moment; wait until the cursor rests on it.
        loadTimer = setTimeout(() => {
          try {
            if (transcripts.size > 24) transcripts.clear();
            transcripts.set(spec.key, spec.load());
          } catch (e) {
            transcripts.set(spec.key, { items: [{ role: 'note', text: `could not read: ${e.message}`, ts: 0 }] });
          }
          onChange();
        }, 90);
        lines = [...lines, '', c.dim('  loading…')];
      } else {
        const rk = `${spec.key}|${w}|${full}`;
        if (rendered.key !== rk) rendered = { key: rk, ...renderTranscript(t.items, w, full, spec.markStart) };
        anchor = spec.markStart ? lines.length + 1 + rendered.anchor : 0;
        lines = [...lines, c.dim('─'.repeat(w)), ...rendered.lines];
      }
    }
    let matchLines = [];
    if (S.search && spec.load) {
      lines = lines.map((l, i) => {
        const h = highlight(l, S.search.q);
        if (h) matchLines.push(i);
        return h || l;
      });
      if (matchLines.length) anchor = Math.max(0, matchLines[0] - 2);
    }
    const ready = !spec.load || transcripts.has(spec.key);
    if (S.anchored !== spec.key) {
      S.scroll = ready ? anchor : 0;
      if (ready) S.anchored = spec.key;
    }
    return { lines, matchLines };
  }

  // ---- frame --------------------------------------------------------------------------------

  function box(w, h, title, lines, focused, footer = '') {
    const edge = focused ? c.green : c.dim;
    const t = fit(title, w - 4, false);
    const f = fit(footer, w - 4, false);
    const out = [edge('╭─') + (focused ? c.bold(c.green(t)) : t) + edge(`${'─'.repeat(Math.max(0, w - 3 - width(t)))}╮`)];
    for (let i = 0; i < h - 2; i++) out.push(edge('│') + fit(lines[i] ?? '', w - 2) + edge('│'));
    out.push(edge(`╰${'─'.repeat(Math.max(0, w - 3 - width(f)))}`) + c.dim(f) + edge('─╯'));
    return out;
  }

  function listBox(name, w, h, title, rows, sel, focused) {
    const room = h - 2;
    let top = S.top[name];
    if (sel < top) top = sel;
    if (sel >= top + room) top = sel - room + 1;
    top = clamp(top, 0, Math.max(0, rows.length - room));
    S.top[name] = top;
    const lines = rows.slice(top, top + room).map((r, i) => {
      if (i + top !== sel) return r;
      return focused ? `\x1b[44;97;1m${fit(strip(r), w - 2)}\x1b[49;39;22m` : `\x1b[1m${fit(strip(r), w - 2)}\x1b[22m`;
    });
    return box(w, h, title, lines, focused, rows.length ? `${sel + 1} of ${rows.length}` : '');
  }

  function statusLine(v, w) {
    if (S.mode === 'input') {
      const text = `${S.input.label}${S.input.value}`;
      return { line: fit(` ${c.cyan(S.input.label)}${S.input.value}`, w), cursor: Math.min(w, width(text) + 2) };
    }
    if (S.mode === 'confirm') return { line: fit(` ${c.yellow(S.confirm.text)}`, w) };
    if (S.msg) return { line: fit(` ${c.yellow(clean(S.msg))}`, w) };
    let keys;
    if (S.mode === 'help') keys = ['any key: back'];
    else if (S.view === 'trash') keys = ['enter restore', 'd purge', 'X empty trash', 'space mark', 'esc back'];
    else if (S.marks.size) keys = [`${S.marks.size} marked`, 'd delete', 'a archive', 't tag', 'p pin', 'e export', 'esc clear'];
    else if (S.search) keys = [`search "${S.search.q}"${S.search.done ? '' : ' …'}`, 'n/N next match', 'enter resume', 'esc clear'];
    else if (S.focus === 'branches') keys = ['enter open branch', 'e export', 'J/K scroll', '? help', 'q quit'];
    else if (S.focus === 'projects') keys = ['enter sessions', 'c new session', '/ filter', 's search', '? help', 'q quit'];
    else keys = ['enter resume', 'f fork', 'c new', 'r rename', 't tag', 'd delete', '/ filter', 's search', '? help', 'q quit'];
    return { line: fit(` ${keys.join(c.dim(' · '))}`, w) };
  }

  function frame(W = 100, H = 30) {
    const v = view();
    if (W < 60 || H < 14) return { rows: Array.from({ length: H }, (_, i) => fit(i ? '' : 'lazycode needs at least 60×14.', W)) };
    const body = H - 1;
    const lw = clamp(Math.floor(W * 0.4), 34, 64);
    const rw = W - lw;
    const ph = clamp(v.projects.length + 2, 4, Math.max(4, Math.floor(body * 0.25)));
    const bh = clamp(v.rows.length + 2, 5, Math.max(5, Math.floor(body * 0.34)));
    const sh = body - ph - bh;
    const inner = lw - 2;

    const projRows = v.projects.map((p) => {
      const tail = `${p.live ? c.green('● ') : ''}${c.dim(String(p.count).padStart(3))}`;
      return `${fit(p.key === null ? c.bold(p.name) : p.name, inner - width(tail) - 1)} ${tail}`;
    });
    const left = listBox('projects', lw, ph, '[1] Projects', projRows, v.pi, S.focus === 'projects' && S.view !== 'trash');

    if (S.view === 'trash') {
      const rows = trash.map((t) => {
        const tail = c.dim(`${bytes(t.size)} ${rel(t.deletedAt).padStart(3)}`);
        return `${S.marks.has(t.trashId) ? c.cyan('✓') : ' '} ${fit(clean(t.title), inner - 3 - width(tail))} ${tail}`;
      });
      const total = trash.reduce((n, t) => n + t.size, 0);
      left.push(...listBox('sessions', lw, sh + bh, `Trash · ${plural(trash.length, 'session')} · ${bytes(total)}`, rows, S.trashSel, true));
    } else {
      const notes = [];
      if (S.filter) notes.push(`/${S.filter}`);
      if (S.sort !== 'recent') notes.push(`by ${S.sort}`);
      if (!S.showHidden) {
        const hid = [v.hidden.empty && `${v.hidden.empty} empty`, v.hidden.archived && `${v.hidden.archived} archived`].filter(Boolean);
        if (hid.length) notes.push(`${hid.join(', ')} hidden`);
      }
      const sessRows = v.sessions.map((s) => sessionRow(s, inner, S.projKey === null));
      left.push(...listBox('sessions', lw, sh, ['[2] Sessions', ...notes].join(' · '), sessRows, v.si, S.focus === 'sessions'));
      const brRows = v.rows.map((r) => branchRow(r, v.sess, inner));
      left.push(...listBox('branches', lw, bh, '[3] Branches', brRows, S.brSel, S.focus === 'branches'));
    }

    const d = detailLines(v, rw - 4);
    const room = body - 2;
    S.scroll = clamp(S.scroll, 0, Math.max(0, d.lines.length - room));
    lastDetail = { lines: d.lines, matches: d.matchLines, height: room };
    const shown = d.lines.slice(S.scroll, S.scroll + room).map((l) => ` ${l}`);
    const pct = d.lines.length > room ? `${Math.round(((S.scroll + room) / d.lines.length) * 100)}%` : '';
    const right = box(rw, body, S.mode === 'help' ? 'Keys' : 'Detail', shown, false, pct);

    const rows = left.map((l, i) => l + right[i]);
    const st = statusLine(v, W);
    rows.push(st.line);
    return { rows, cursor: st.cursor ? { x: st.cursor, y: H } : null };
  }

  // ---- actions ------------------------------------------------------------------------------

  const exec = (args, dir) => ({ type: 'exec', args, cwd: dir });
  const ask = (text, keys) => {
    S.mode = 'confirm';
    S.confirm = { text, keys };
  };
  const prompt = (label, value, onSubmit, extra = {}) => {
    S.mode = 'input';
    S.input = { label, value, onSubmit, ...extra };
  };
  const targets = (v) => (S.marks.size ? data.sessions.filter((s) => S.marks.has(s.id)) : v.sess ? [v.sess] : []);

  function resume(s) {
    if (s.cwdMissing) {
      if (!fs.existsSync(s.project)) return say(`Cannot resume: ${tilde(s.cwd)} no longer exists.`);
      return ask(`${tilde(s.cwd)} is gone. Open a copy in ${tilde(s.project)}? [y/N]`, {
        y: () => {
          const id = extractBranch(s, null, { cd, destCwd: s.project });
          refresh();
          S.sessId = id;
          return exec(['--resume', id], s.project);
        },
      });
    }
    if (s.live) {
      return ask(`Already running in pid ${s.live.pid}.  y: open a second copy   f: fork instead   N: cancel`, {
        y: () => exec(['--resume', s.id], s.cwd),
        f: () => exec(['--resume', s.id, '--fork-session'], s.cwd),
      });
    }
    return exec(['--resume', s.id], s.cwd);
  }

  function checkout(s, seg) {
    const leaf = !seg.children.length;
    if (seg.active && leaf) return resume(s);
    const dest = s.cwdMissing ? s.project : '';
    if (dest && !fs.existsSync(dest)) return say(`Cannot open: ${tilde(s.cwd)} no longer exists.`);
    return ask(`Open this ${leaf ? 'branch' : 'fork point'} as a new session? The original is not changed. [y/N]`, {
      y: () => {
        const id = extractBranch(s, seg.tip, { cd, destCwd: dest, title: `${s.title} (branch)` });
        refresh();
        S.projKey = null;
        S.sessId = id;
        S.focus = 'sessions';
        return exec(['--resume', id], dest || s.cwd);
      },
    });
  }

  function remove(v) {
    const all = targets(v);
    const ok = all.filter((s) => !s.live);
    const skipped = all.length - ok.length;
    if (!ok.length) return say(all.length ? 'A running session cannot be deleted. Close it first.' : 'Nothing selected.');
    const projects = new Set(ok.map((s) => s.project)).size;
    const what = ok.length === 1 ? `"${clean(ok[0].title).slice(0, 40)}"` : `${ok.length} sessions from ${plural(projects, 'project')}`;
    ask(`Move ${what} to trash?${skipped ? ` (${skipped} running, skipped)` : ''} [y/N]`, {
      y: () => {
        S.undo.push(trashSessions(ok, cd));
        S.marks.clear();
        refresh();
        say(`Moved ${plural(ok.length, 'session')} to trash. u undoes.`);
      },
    });
  }

  function tag(v) {
    const list = targets(v);
    if (!list.length) return;
    const known = [...new Set(Object.values(meta.sessions).flatMap((e) => e.tags || []))].sort();
    const current = list.length === 1 ? tagsOf(list[0].id) : [];
    prompt(
      `tags${list.length > 1 ? ` for ${list.length} sessions` : ''}${current.length ? ` [${current.join(' ')}]` : ''}: `,
      '',
      (value) => {
        const words = value.split(/[\s,]+/).filter(Boolean);
        const add = words.filter((x) => x[0] !== '-').map((x) => x.replace(/^#/, ''));
        const drop = new Set(words.filter((x) => x[0] === '-').map((x) => x.slice(1).replace(/^#/, '')));
        setMeta(list, (e) => {
          e.tags = [...new Set([...(e.tags || []), ...add])].filter((t) => t && !drop.has(t)).sort();
        });
      },
      {
        complete: (value) => {
          const m = /(^|\s)(-?)#?([^\s]*)$/.exec(value);
          const hit = m && m[3] && known.find((k) => k.startsWith(m[3]) && k !== m[3]);
          return hit ? value.slice(0, value.length - m[3].length) + hit : value;
        },
      },
    );
  }

  function doExport(v, full) {
    const dir = expandDir(config.exportDir, cwd);
    const row = S.focus === 'branches' ? v.rows[S.brSel] : null;
    const jobs = [];
    if (row?.type === 'seg') jobs.push([v.sess, { tip: row.seg.tip }]);
    else if (row?.type === 'agent') jobs.push([v.sess, { agent: row.agent }]);
    else for (const s of targets(v)) jobs.push([s, {}]);
    if (!jobs.length) return;
    let last = '';
    try {
      for (const [s, o] of jobs) last = exportMarkdown(s, { ...o, full, outDir: dir, tags: tagsOf(s.id) });
    } catch (e) {
      return say(`Export failed: ${e.message}`);
    }
    const where = jobs.length === 1 ? tilde(last) : `${jobs.length} files in ${tilde(dir)}`;
    say(`Exported ${where}${full ? '. Tool output can contain secrets; check before sharing.' : ''}`);
  }

  function copy(text) {
    for (const [cmd, args] of [['pbcopy', []], ['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]) {
      const r = spawnSync(cmd, args, { input: text });
      if (!r.error && r.status === 0) return true;
    }
    return false;
  }

  function startSearch(q) {
    const job = { q, hits: new Map(), done: false, i: 0 };
    const list = [...data.sessions];
    S.search = job;
    S.projKey = null;
    S.focus = 'sessions';
    S.anchored = '';
    const step = () => {
      if (S.search !== job) return;
      const started = Date.now();
      while (job.i < list.length && (sync || Date.now() - started < 25)) {
        const hit = searchSession(list[job.i], q);
        if (hit) job.hits.set(list[job.i].id, hit);
        job.i++;
      }
      job.done = job.i >= list.length;
      if (!job.done) setImmediate(step);
      else say(`${plural(job.hits.size, 'session')} mention "${q}".`);
      onChange();
    };
    step();
  }

  function jump(dir) {
    const m = lastDetail.matches;
    if (!m.length) return say('No matches in this transcript.');
    const mid = S.scroll + 2;
    const next = dir > 0 ? m.find((i) => i > mid) ?? m[0] : [...m].reverse().find((i) => i < mid) ?? m[m.length - 1];
    S.scroll = Math.max(0, next - 2);
    return say(`match ${m.indexOf(next) + 1} of ${m.length}`);
  }

  function move(v, delta, absolute) {
    S.msg = '';
    if (S.view === 'trash') {
      S.trashSel = clamp(absolute ?? S.trashSel + delta, 0, Math.max(0, trash.length - 1));
      return;
    }
    if (S.focus === 'projects') {
      const i = clamp(absolute ?? v.pi + delta, 0, v.projects.length - 1);
      S.projKey = v.projects[i].key;
      S.sessId = null;
      S.sessIdx = 0;
      S.brSel = 0;
      S.range = null;
    } else if (S.focus === 'sessions') {
      const i = clamp(absolute ?? v.si + delta, 0, Math.max(0, v.sessions.length - 1));
      S.sessIdx = i;
      S.sessId = v.sessions[i]?.id ?? null;
      S.brSel = 0;
      if (S.range) {
        S.marks = new Set(S.range.base);
        for (let k = Math.min(S.range.anchor, i); k <= Math.max(S.range.anchor, i); k++) S.marks.add(v.sessions[k].id);
      }
    } else S.brSel = clamp(absolute ?? S.brSel + delta, 0, Math.max(0, v.rows.length - 1));
  }

  function trashKey(k) {
    const picked = S.marks.size ? trash.filter((t) => S.marks.has(t.trashId)) : trash[S.trashSel] ? [trash[S.trashSel]] : [];
    const leave = () => {
      S.view = 'sessions';
      S.marks.clear();
    };
    if (k === 'esc' || k === 'T' || k === 'q') return leave();
    if (k === ' ' && trash[S.trashSel]) {
      const id = trash[S.trashSel].trashId;
      if (!S.marks.delete(id)) S.marks.add(id);
      S.trashSel = clamp(S.trashSel + 1, 0, trash.length - 1);
    } else if ((k === 'enter' || k === 'u') && picked.length) {
      const r = restoreTrash(picked.map((t) => t.trashId), cd);
      S.marks.clear();
      refresh();
      say(`Restored ${plural(r.restored, 'session')}${r.failed.length ? `, ${r.failed.length} could not be restored` : ''}.`);
    } else if (k === 'd' && picked.length) {
      ask(`Permanently delete ${plural(picked.length, 'session')} (${bytes(picked.reduce((n, t) => n + t.size, 0))})? This cannot be undone. [y/N]`, {
        y: () => {
          purgeTrash(picked.map((t) => t.trashId), cd);
          S.marks.clear();
          refresh();
        },
      });
    } else if (k === 'X' && trash.length) {
      ask(`Empty the trash: ${plural(trash.length, 'session')}, ${bytes(trash.reduce((n, t) => n + t.size, 0))}? This cannot be undone. [y/N]`, {
        y: () => {
          purgeTrash(trash.map((t) => t.trashId), cd);
          S.marks.clear();
          refresh();
        },
      });
    }
    return undefined;
  }

  function key(k) {
    if (S.mode === 'input') {
      const inp = S.input;
      if (k === 'esc') {
        S.mode = 'normal';
        if (inp.onCancel) inp.onCancel();
      } else if (k === 'enter') {
        S.mode = 'normal';
        return inp.onSubmit(inp.value.trim());
      } else {
        if (k === 'backspace') inp.value = [...inp.value].slice(0, -1).join('');
        else if (k === 'ctrl-u') inp.value = '';
        else if (k === 'tab' && inp.complete) inp.value = inp.complete(inp.value);
        else if ([...k].length === 1 && k >= ' ') inp.value += k;
        if (inp.onChange) inp.onChange(inp.value);
      }
      return undefined;
    }
    if (S.mode === 'confirm') {
      const fn = S.confirm.keys[k.toLowerCase()];
      S.mode = 'normal';
      S.confirm = null;
      try {
        return fn ? fn() : undefined;
      } catch (e) {
        return say(`Failed: ${e.message}`);
      }
    }
    if (S.mode === 'help') {
      if (k === 'J' || k === 'pgdn' || k === 'j' || k === 'down') S.scroll += 4;
      else if (k === 'K' || k === 'pgup' || k === 'k' || k === 'up') S.scroll -= 4;
      else {
        S.mode = 'normal';
        S.anchored = '';
      }
      return undefined;
    }
    const v = view();
    const page = Math.max(1, Math.floor(lastDetail.height / 2) || 8);
    S.msg = '';
    if (k === 'q' && S.view !== 'trash') return { type: 'quit' };
    if (k === 'ctrl-c') return { type: 'quit' };
    if (k === '?') {
      S.mode = 'help';
      S.anchored = '';
      return undefined;
    }
    if (k === 'j' || k === 'down') return move(v, 1);
    if (k === 'k' || k === 'up') return move(v, -1);
    if (k === 'g' || k === 'home') return move(v, 0, 0);
    if (k === 'G' || k === 'end') return move(v, 0, Number.MAX_SAFE_INTEGER);
    if (k === 'ctrl-d') return move(v, 10);
    if (k === 'ctrl-u') return move(v, -10);
    if (k === 'J' || k === 'pgdn') return void (S.scroll += page);
    if (k === 'K' || k === 'pgup') return void (S.scroll -= page);
    if (k === 'R') {
      refresh();
      return say('Rescanned.');
    }
    if (S.view === 'trash') return trashKey(k);

    const at = PANELS.indexOf(S.focus);
    if (k === 'tab' || k === 'l' || k === 'right') return void (S.focus = PANELS[(at + 1) % 3]);
    if (k === 'shift-tab' || k === 'h' || k === 'left') return void (S.focus = PANELS[(at + 2) % 3]);
    if (k === '1' || k === '2' || k === '3') return void (S.focus = PANELS[Number(k) - 1]);
    const s = v.sess;
    switch (k) {
      case 'enter': {
        if (S.focus === 'projects') return void (S.focus = 'sessions');
        if (!s) return undefined;
        const row = S.focus === 'branches' ? v.rows[S.brSel] : null;
        if (row?.type === 'seg') return checkout(s, row.seg);
        if (row?.type === 'link') {
          S.projKey = null;
          S.sessId = row.id;
          S.showHidden = true;
          S.focus = 'sessions';
          return undefined;
        }
        if (row) return undefined;
        return resume(s);
      }
      case 'f':
        if (!s) return undefined;
        if (s.cwdMissing) return say(`Cannot fork: ${tilde(s.cwd)} no longer exists. Press enter to open a copy.`);
        return exec(['--resume', s.id, '--fork-session'], s.cwd);
      case 'c': {
        const dir = S.projKey || s?.cwd;
        if (!dir || !fs.existsSync(dir)) return say('Pick a project whose directory exists first.');
        return exec([], dir);
      }
      case 'r':
        if (s) prompt('rename: ', s.named ? s.title : '', (value) => {
          if (!value) return;
          renameSession(s, value);
          refresh();
        });
        return undefined;
      case 't':
        return tag(v);
      case 'p': {
        const list = targets(v);
        const on = !list.every((x) => metaOf(x.id).pinned);
        setMeta(list, (e) => (e.pinned = on));
        return say(on ? 'Pinned.' : 'Unpinned.');
      }
      case 'a': {
        const list = targets(v);
        const on = !list.every((x) => metaOf(x.id).archived);
        setMeta(list, (e) => (e.archived = on));
        S.marks.clear();
        return say(`${on ? 'Archived' : 'Unarchived'} ${plural(list.length, 'session')}.${on && !S.showHidden ? ' H shows archived.' : ''}`);
      }
      case 'd':
        return remove(v);
      case 'u': {
        const ids = S.undo.pop();
        if (!ids) return say('Nothing to undo.');
        const r = restoreTrash(ids, cd);
        refresh();
        return say(`Restored ${plural(r.restored, 'session')}.`);
      }
      case 'T':
        S.view = 'trash';
        S.marks.clear();
        S.range = null;
        trash = listTrash(cd);
        return undefined;
      case 'e':
        return doExport(v, false);
      case 'E':
        return doExport(v, true);
      case 'y':
        if (s) say(copy(s.id) ? `Copied ${s.id}` : s.id);
        return undefined;
      case '/':
        prompt('/', S.filter, () => {}, {
          onChange: (value) => {
            S.filter = value;
            S.sessIdx = 0;
            S.sessId = null;
          },
          onCancel: () => (S.filter = ''),
        });
        S.focus = 'sessions';
        return undefined;
      case 's':
        prompt('search transcripts: ', S.search?.q || '', (value) => {
          if (value) startSearch(value);
          else S.search = null;
        });
        return undefined;
      case 'n':
        return void (S.search ? jump(1) : say('n steps through search matches. Press s to search, c for a new session.'));
      case 'N':
        return void (S.search ? jump(-1) : 0);
      case 'o':
        S.sort = SORTS[(SORTS.indexOf(S.sort) + 1) % SORTS.length];
        return say(`Sorted by ${S.sort}.`);
      case 'H':
        S.showHidden = !S.showHidden;
        return undefined;
      case 'z':
        S.full = !S.full;
        return undefined;
      case ' ':
        if (s && S.focus === 'sessions') {
          if (!S.marks.delete(s.id)) S.marks.add(s.id);
          S.range = null;
          move(v, 1);
        }
        return undefined;
      case 'v':
        if (s && S.focus === 'sessions') {
          S.range = S.range ? null : { anchor: v.si, base: new Set(S.marks) };
          if (S.range) S.marks.add(s.id);
        }
        return undefined;
      case '*':
        for (const x of v.sessions) S.marks.add(x.id);
        return undefined;
      case 'esc':
        if (S.marks.size || S.range) {
          S.marks.clear();
          S.range = null;
        } else if (S.search) {
          S.search = null;
          S.anchored = '';
        } else S.filter = '';
        return undefined;
      default:
        return undefined;
    }
  }

  return {
    S,
    frame,
    key,
    refresh,
    say,
    config,
    idle: () => S.mode === 'normal',
    setOnChange: (fn) => (onChange = fn),
  };
}

const NAMED = {
  '\r': 'enter',
  '\n': 'enter',
  '\t': 'tab',
  '\x7f': 'backspace',
  '\b': 'backspace',
  '\x1b': 'esc',
  '\x03': 'ctrl-c',
  '\x04': 'ctrl-d',
  '\x15': 'ctrl-u',
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1bOA': 'up',
  '\x1bOB': 'down',
  '\x1bOC': 'right',
  '\x1bOD': 'left',
  '\x1b[5~': 'pgup',
  '\x1b[6~': 'pgdn',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
  '\x1b[Z': 'shift-tab',
};

export function parseKeys(text) {
  const out = [];
  for (const tok of text.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|[\s\S]/gu) || []) {
    if (NAMED[tok]) out.push(NAMED[tok]);
    else if (tok.length > 1 && tok[0] === '\x1b') continue;
    else if (tok >= ' ') out.push(tok);
  }
  return out;
}

export function run(opts = {}) {
  const out = process.stdout;
  const inp = process.stdin;
  const app = createApp(opts);
  let on = false;
  const enter = () => {
    out.write('\x1b[?1049h\x1b[?7l\x1b[?25l');
    inp.setRawMode(true);
    inp.resume();
    on = true;
  };
  const leave = () => {
    if (!on) return;
    on = false;
    out.write('\x1b[?25h\x1b[?7h\x1b[?1049l');
    inp.setRawMode(false);
    inp.pause();
  };
  const draw = () => {
    if (!on) return;
    const f = app.frame(out.columns || 100, out.rows || 30);
    out.write(`\x1b[H${f.rows.join('\x1b[K\r\n')}\x1b[K${f.cursor ? `\x1b[${f.cursor.y};${f.cursor.x}H\x1b[?25h` : '\x1b[?25l'}`);
  };
  app.setOnChange(draw);
  const timer = setInterval(() => {
    if (!on || !app.idle()) return;
    app.refresh();
    draw();
  }, Math.max(2, Number(app.config.refreshSeconds) || 5) * 1000);
  const quit = () => {
    clearInterval(timer);
    leave();
    process.exit(0);
  };
  process.on('exit', leave);
  process.on('SIGTERM', quit);
  out.on('resize', draw);
  inp.on('data', (buf) => {
    for (const k of parseKeys(buf.toString('utf8'))) {
      let action;
      try {
        action = app.key(k);
      } catch (e) {
        app.say(`Error: ${e.message}`);
      }
      if (action?.type === 'quit') return quit();
      if (action?.type === 'exec') {
        leave();
        const r = spawnSync('claude', action.args, { cwd: action.cwd, stdio: 'inherit' });
        enter();
        app.refresh();
        if (r.error) app.say(r.error.code === 'ENOENT' ? 'The claude command was not found on your PATH.' : `Could not start claude: ${r.error.message}`);
      }
    }
    draw();
  });
  enter();
  draw();
}
