import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exportMarkdown, extractBranch, verifyCheckout, listTrash, loadMeta, purgeTrash, renameSession, restoreTrash, saveMeta, trashSessions } from '../src/ops.js';
import { loadTranscript, munge, scan, searchSession } from '../src/store.js';
import { fit, highlight, strip, width, wrap } from '../src/term.js';
import { createApp, parseKeys } from '../src/tui.js';
import { buildDemoHome } from '../scripts/demo-home.js';
import { captureSession } from '../src/scrub.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

// A Claude home holding one session with a rewind fork, parallel tool calls and a compaction whose
// logical parent is absent, plus a second session forked from it.
function fixture() {
  const cd = fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaudecode-'));
  const cwd = path.join(cd, 'work', 'my.proj');
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(cd, 'projects', munge(cwd));
  fs.mkdirSync(dir, { recursive: true });
  let clock = Date.parse('2026-09-01T10:00:00Z');
  const base = (sessionId, uuid, parentUuid) => ({ uuid, parentUuid, sessionId, cwd, gitBranch: 'feat/x', version: '2.1.0', entrypoint: 'cli', isSidechain: false, timestamp: new Date((clock += 60000)).toISOString() });
  const user = (sid, uuid, parent, content, extra = {}) => ({ ...base(sid, uuid, parent), type: 'user', message: { role: 'user', content }, ...extra });
  const asst = (sid, uuid, parent, msgId, content) => ({ ...base(sid, uuid, parent), type: 'assistant', message: { id: msgId, role: 'assistant', model: 'claude-test', content, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } } });
  const result = (id) => [{ type: 'tool_result', tool_use_id: id, content: `output of ${id}` }];
  const a = [
    { type: 'ai-title', aiTitle: 'Webhook retries', sessionId: A },
    user(A, 'u1', null, 'add retry logic'),
    asst(A, 'a1', 'u1', 'm1', [{ type: 'text', text: 'Reading the dispatcher.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.py' } }]),
    asst(A, 'a2', 'a1', 'm1', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pytest' } }]),
    user(A, 'r1', 'a1', result('t1')),
    user(A, 'r2', 'a2', result('t2')),
    asst(A, 'a3', 'r2', 'm2', [{ type: 'text', text: 'Two options: redis or a queue.' }]),
    user(A, 'u2', 'a3', 'try redis'),
    asst(A, 'a4', 'u2', 'm3', [{ type: 'text', text: 'Redis it is.' }]),
    user(A, 'u3', 'a3', [{ type: 'text', text: 'use a queue' }]),
    asst(A, 'a5', 'u3', 'm4', [{ type: 'text', text: 'Queue with a Zebra backoff.' }]),
    { ...base(A, 'cb', null), type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'not-in-file' },
    user(A, 'cs', 'cb', 'summary of earlier work', { isCompactSummary: true }),
    user(A, 'u4', 'cs', 'continue'),
    asst(A, 'a6', 'u4', 'm5', [{ type: 'text', text: 'Continuing.' }]),
    { type: 'last-prompt', leafUuid: 'cs', sessionId: A },
  ];
  fs.writeFileSync(path.join(dir, `${A}.jsonl`), a.map((d) => JSON.stringify(d)).join('\n') + '\n');
  fs.mkdirSync(path.join(dir, A, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, A, 'subagents', 'agent-abc.jsonl'), JSON.stringify({ ...user(A, 's1', null, 'review the diff'), isSidechain: true }) + '\n');
  fs.writeFileSync(path.join(dir, A, 'subagents', 'agent-abc.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'review the diff' }));
  const b = a.slice(1, 3).map((d) => ({ ...d, sessionId: B }));
  b.push(user(B, 'bu', 'a1', 'a different direction'));
  fs.writeFileSync(path.join(dir, `${B}.jsonl`), b.map((d) => JSON.stringify(d)).join('\n') + '\n');
  return { cd, cwd, dir };
}

const get = (cd, id) => scan({ cd, useCache: false }).byId.get(id);

test('scan summarises a session and finds its real branches', () => {
  const { cd, cwd } = fixture();
  const s = get(cd, A);
  assert.equal(s.title, 'Webhook retries');
  assert.equal(s.cwd, cwd);
  assert.equal(s.gitBranch, 'feat/x');
  assert.equal(s.prompts, 4);
  assert.equal(s.turns, 5, 'records sharing a message id are one reply');
  assert.equal(s.tools, 2);
  assert.equal(s.compactions, 1);
  assert.equal(s.agents.length, 1);
  assert.equal(s.cwdMissing, false);
  // The parallel tool result r1 and the orphaned compaction must not count as branches.
  assert.equal(s.branches, 2);
  assert.equal(s.tree.first, 'add retry logic');
  const [redis, queue] = s.tree.children;
  assert.deepEqual([redis.first, redis.prompts, redis.active], ['try redis', 1, false]);
  assert.deepEqual([queue.first, queue.prompts, queue.active], ['use a queue', 2, true]);
});

test('scan links a forked session to its parent and groups projects', () => {
  const { cd, cwd } = fixture();
  const data = scan({ cd, useCache: false });
  assert.equal(data.byId.get(B).forkParent, A);
  assert.deepEqual(data.byId.get(A).forks, [B]);
  assert.deepEqual(data.projects.map((p) => [p.key, p.count]), [[cwd, 2]]);
});

test('the cache returns the same summaries', () => {
  const { cd } = fixture();
  const cold = scan({ cd });
  const warm = scan({ cd });
  assert.deepEqual(warm.byId.get(A).tree, cold.byId.get(A).tree);
  assert.ok(fs.existsSync(path.join(cd, 'lazyclaudecode', 'cache', 'index.json')));
});

test('transcripts follow one branch', () => {
  const { cd } = fixture();
  const s = get(cd, A);
  const said = (o) => loadTranscript(s.file, o).items.filter((i) => i.role === 'user').map((i) => i.text);
  assert.deepEqual(said({}), ['add retry logic', 'use a queue', 'continue']);
  assert.deepEqual(said({ tip: s.tree.children[0].tip }), ['add retry logic', 'try redis']);
  assert.deepEqual(said({ through: 'u2' }), ['add retry logic', 'try redis']);
  const items = loadTranscript(s.file, { results: true }).items;
  assert.equal(items.find((i) => i.role === 'tool' && i.name === 'Bash').output, 'output of t2');
  assert.ok(items.some((i) => i.role === 'fork'));
});

test('checking out an abandoned branch writes a new linear session', () => {
  const { cd } = fixture();
  const before = fs.readFileSync(get(cd, A).file, 'utf8');
  const s = get(cd, A);
  const id = extractBranch(s, s.tree.children[0].tip, { cd, title: 'redis branch' });
  const n = get(cd, id);
  assert.equal(n.title, 'redis branch');
  assert.equal(n.branches, 1);
  assert.equal(n.prompts, 2);
  assert.equal(n.forkParent, A);
  const raw = fs.readFileSync(n.file, 'utf8');
  assert.ok(raw.includes('"r1"'), 'the side tool result travels with the branch');
  assert.ok(!raw.includes('use a queue') && !raw.includes(`"sessionId":"${A}"`.replace(A, `${A}","type`)));
  assert.ok(raw.split('\n').filter(Boolean).every((l) => JSON.parse(l).sessionId === id));
  assert.equal(fs.readFileSync(s.file, 'utf8'), before, 'the source is untouched');
});

test('rename, trash, restore and purge', () => {
  const { cd, dir } = fixture();
  renameSession(get(cd, A), 'new name');
  assert.equal(get(cd, A).title, 'new name');
  const [trashId] = trashSessions([get(cd, A)], cd);
  assert.equal(get(cd, A), undefined);
  assert.ok(!fs.existsSync(path.join(dir, A)));
  assert.equal(listTrash(cd)[0].title, 'new name');
  assert.deepEqual(restoreTrash([trashId], cd), { restored: 1, failed: [] });
  assert.equal(get(cd, A).agents.length, 1, 'subagents come back with the session');
  const [again] = trashSessions([get(cd, A)], cd);
  purgeTrash([again], cd);
  assert.deepEqual(listTrash(cd), []);
  assert.throws(() => purgeTrash(['../../projects'], cd));
});

test('the sidecar drops entries that carry nothing', () => {
  const { cd } = fixture();
  saveMeta({ v: 1, sessions: { [A]: { tags: ['wip'], pinned: true }, [B]: { tags: [], archived: false } } }, cd);
  assert.deepEqual(loadMeta(cd).sessions, { [A]: { tags: ['wip'], pinned: true } });
});

test('search covers prompts and replies on every branch but not tool output', () => {
  const { cd } = fixture();
  const s = get(cd, A);
  assert.equal(searchSession(s, 'zebra').count, 1);
  assert.equal(searchSession(s, 'REDIS').count, 3);
  assert.equal(searchSession(s, 'output of'), null);
});

test('export writes readable markdown', () => {
  const { cd } = fixture();
  const s = get(cd, A);
  const out = path.join(cd, 'out');
  const plain = fs.readFileSync(exportMarkdown(s, { outDir: out, tags: ['wip'] }), 'utf8');
  assert.match(plain, /^# Webhook retries/);
  assert.match(plain, /\*\*Tags:\*\* wip/);
  assert.match(plain, /## You · .*\n\nuse a queue/);
  assert.match(plain, /- `Bash: pytest`/);
  assert.ok(!plain.includes('output of t2') && !plain.includes('try redis'));
  const full = fs.readFileSync(exportMarkdown(s, { outDir: out, full: true, tip: s.tree.children[0].tip }), 'utf8');
  assert.ok(full.includes('output of t2') && full.includes('try redis'));
});

test('text helpers keep to the requested width', () => {
  assert.equal(width(fit('\x1b[31mhello world\x1b[39m', 6)), 6);
  assert.equal(fit('hello world', 6), 'hello…', 'plain text is cut without adding escape codes');
  assert.equal(strip(fit('日本語テキスト', 5)), '日本…');
  assert.equal(strip(fit('日本語テキスト', 6)), '日本… ', 'a wide character that will not fit is padded over');
  assert.ok(wrap('a '.repeat(50) + 'x'.repeat(30), 12).every((l) => width(l) <= 12));
  assert.equal(wrap('one\x1b[2Jtwo', 20)[0], 'one[2Jtwo', 'escape bytes from transcripts are dropped');
  assert.equal(strip(highlight('say Hello', 'hello')), 'say Hello');
  assert.deepEqual(parseKeys('j\x1b[A\r\x1b[Z'), ['j', 'up', 'enter', 'shift-tab']);
});

test('the interface renders and acts on keys', () => {
  const { cd, cwd } = fixture();
  const app = createApp({ cd, sync: true, useCache: false, cwd: cd });
  app.S.sessId = A;
  const screen = () => {
    const rows = app.frame(110, 30).rows;
    assert.ok(rows.every((r) => width(r) === 110), 'every row fills the terminal exactly');
    return rows.map(strip).join('\n');
  };
  const press = (keys) => parseKeys(keys).map((k) => app.key(k)).filter(Boolean);
  assert.match(screen(), /Webhook retries\s+⑂2 ◇1/);
  assert.match(screen(), /"use a queue"/);

  assert.deepEqual(press('\r'), [{ type: 'exec', args: ['--resume', A], cwd }]);
  assert.deepEqual(press('f'), [{ type: 'exec', args: ['--resume', A, '--fork-session'], cwd }]);

  press('3j');
  assert.match(screen(), /Abandoned branch/);
  press('\r');
  assert.match(screen(), /Open this branch as a new session\?/);
  const [act] = press('y');
  assert.equal(act.type, 'exec');
  assert.equal(scan({ cd, useCache: false }).byId.get(act.args[1]).prompts, 2);

  press('2tzeta wip\r');
  assert.deepEqual(loadMeta(cd).sessions[app.S.sessId].tags, ['wip', 'zeta']);
  press('t-wip\r/#zeta\r');
  assert.match(screen(), /1 of 1/);
  press('\x1b');

  press('szebra\r');
  assert.match(screen(), /1 session mention/);
  press('\x1b\x1b');

  const id = app.S.sessId;
  press('a');
  assert.ok(!screen().includes('(archived)'));
  assert.match(screen(), /1 archived hidden/);
  press('H');
  assert.match(screen(), /\(archived\)/);

  app.S.sessId = id;
  press('dy');
  assert.equal(listTrash(cd).length, 1);
  press('u');
  assert.equal(listTrash(cd).length, 0);

  press('*e');
  assert.equal(fs.readdirSync(path.join(cd, 'claude-exports')).length, 3);
  press('?');
  assert.match(screen(), /check out an old branch/);
});

test('the demo home shows every feature the screenshots rely on', () => {
  const { cd, hero } = buildDemoHome(fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaudecode-demo-')), { livePids: [process.pid] });
  const data = scan({ cd, useCache: false });
  const s = data.byId.get(hero);
  assert.deepEqual([s.branches, s.agents.length, s.live?.status], [3, 2, 'idle']);
  assert.equal(data.sessions.filter((x) => x.forkParent).length, 1);
  assert.ok(data.sessions.some((x) => x.worktree === 'rate-limit' && x.project === s.project));
  assert.equal(listTrash(cd).length, 2);
  assert.ok(searchSession(s, 'backoff').count > 1);
});

// Every place a session can hold something private, each holding a marker that must not survive.
test('a capture keeps the structure and none of the content', () => {
  const { cd, dir } = fixture();
  const C = '33333333-3333-4333-8333-333333333333';
  const cwd = '/Users/SECRETUSER/acme-SECRETREPO/.claude/worktrees/SECRETTREE';
  const t = (i) => `2025-03-04T05:0${i}:07.000Z`;
  const base = { sessionId: C, cwd, gitBranch: 'SECRETBRANCH', version: '2.1.999', isSidechain: false, slug: 'SECRETSLUG' };
  const recs = [
    { type: 'ai-title', aiTitle: 'SECRETTITLE', sessionId: C },
    { type: 'custom-title', customTitle: 'SECRETCUSTOM', sessionId: C },
    { ...base, uuid: 'SECRETUUID1', parentUuid: null, timestamp: t(1), type: 'user', message: { role: 'user', content: '<system-reminder>SECRETREMINDER</system-reminder>\nSECRETPROMPT' } },
    { ...base, uuid: 'SECRETUUID2', parentUuid: 'SECRETUUID1', timestamp: t(2), type: 'assistant', message: { id: 'msg_SECRETMSG', role: 'assistant', model: 'claude-test', usage: { output_tokens: 7, service_tier: 'SECRETTIER' }, content: [
      { type: 'thinking', thinking: 'SECRETTHINK', signature: 'SECRETSIG' },
      { type: 'text', text: 'SECRETREPLY' },
      { type: 'tool_use', id: 'toolu_SECRETID', name: 'mcp__SECRETCORP__deploy', input: { command: 'SECRETCMD' } },
      { type: 'tool_use', id: 'toolu_SECRETTWO', name: 'Bash', input: { command: 'SECRETBASHCMD' } },
    ] } },
    { ...base, uuid: 'SECRETUUID3', parentUuid: 'SECRETUUID2', timestamp: t(3), type: 'user', toolUseResult: { stdout: 'SECRETTUR' }, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_SECRETID', content: 'SECRETOUTPUT' },
      { type: 'tool_result', tool_use_id: 'toolu_SECRETTWO', content: [{ type: 'text', text: 'SECRETOUTPUT2' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'SECRETIMAGE' } }] },
    ] } },
    { ...base, uuid: 'SECRETUUID4', parentUuid: 'SECRETUUID3', timestamp: t(4), type: 'user', message: { role: 'user', content: '<command-name>/review</command-name>\n<command-args>SECRETARGS</command-args>' } },
    { ...base, uuid: 'SECRETUUID5', parentUuid: 'SECRETUUID4', timestamp: t(5), type: 'user', message: { role: 'user', content: '<bash-input>SECRETBASH</bash-input>' } },
    { ...base, uuid: 'SECRETUUID6', parentUuid: 'SECRETUUID5', timestamp: t(6), type: 'user', message: { role: 'user', content: '<new-harness-tag>SECRETNEWTAG</new-harness-tag>' } },
    { ...base, uuid: 'SECRETUUID7', parentUuid: 'SECRETUUID6', timestamp: t(7), type: 'attachment', attachment: { type: 'file', filename: '/Users/SECRETUSER/notes.txt', content: 'SECRETATTACH' } },
    { ...base, uuid: 'SECRETUUID8', parentUuid: 'SECRETUUID7', timestamp: t(8), type: 'system', subtype: 'local_command', content: 'SECRETSYSTEM', newField: 'SECRETUNKNOWN', nested: { '/Users/SECRETUSER/file.ts': { backup: 'SECRETBACKUP' } } },
    { type: 'file-history-snapshot', messageId: 'SECRETUUID8', snapshot: { trackedFileBackups: { '/Users/SECRETUSER/a.ts': { backupFileName: 'SECRETFILE' } } } },
    { type: 'pr-link', prNumber: 12, prUrl: 'https://github.com/SECRETORG/x/pull/12', prRepository: 'SECRETORG/x', sessionId: C },
    { type: 'last-prompt', lastPrompt: 'SECRETLAST', leafUuid: 'SECRETUUID8', sessionId: C },
  ];
  fs.writeFileSync(path.join(dir, `${C}.jsonl`), recs.map((d) => JSON.stringify(d)).join('\n') + '\n');
  fs.mkdirSync(path.join(dir, C, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, C, 'subagents', 'agent-SECRETAGENT.jsonl'), JSON.stringify({ ...base, uuid: 's1', parentUuid: null, isSidechain: true, timestamp: t(9), type: 'user', message: { role: 'user', content: 'SECRETAGENTPROMPT' } }) + '\n');
  fs.writeFileSync(path.join(dir, C, 'subagents', 'agent-SECRETAGENT.meta.json'), JSON.stringify({ agentType: 'SECRETAGENTTYPE', description: 'SECRETDESC' }));

  const s = get(cd, C);
  const out = path.join(cd, 'capture');
  const r = captureSession(s, out);
  const files = fs.readdirSync(out, { recursive: true }).map((f) => path.join(out, f)).filter((f) => fs.statSync(f).isFile());
  const all = files.map((f) => `${f.slice(out.length)}\n${fs.readFileSync(f, 'utf8')}`).join('\n') + r.kept.join('\n');
  const leaks = [...new Set(all.match(/SECRET[A-Z0-9]*/g) || [])];
  assert.deepEqual(leaks, [], 'nothing marked SECRET survives');
  for (const gone of ['2025-03-04', '/Users/']) assert.ok(!all.includes(gone), `${gone} is replaced`);
  assert.equal(files.length, 3, 'the session, one subagent and its metadata');

  // The copy reads the same way the original does.
  const lines = fs.readFileSync(path.join(out, 'session.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const fake = lines.find((d) => d.type === 'user').sessionId;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaudecode-cap-'));
  const copyDir = path.join(home, 'projects', munge(lines.find((d) => d.cwd).cwd));
  fs.mkdirSync(copyDir, { recursive: true });
  fs.copyFileSync(path.join(out, 'session.jsonl'), path.join(copyDir, `${fake}.jsonl`));
  const copy = get(home, fake);
  for (const k of ['prompts', 'turns', 'tools', 'branches', 'version']) assert.equal(copy[k], s[k], k);
  assert.match(copy.cwd, /^\/home\/user\/project\/\.claude\/worktrees\/worktree-1$/, 'a worktree path still looks like one');
  assert.ok(r.kept.includes('new-harness-tag') && r.kept.includes('/review') && r.kept.includes('Bash'));
});

test('a checkout is read back and removed if it is not the branch asked for', () => {
  const { cd, dir } = fixture();
  const s = get(cd, A);
  const tip = s.tree.children[0].tip;
  const before = fs.readdirSync(dir).length;
  assert.throws(() => extractBranch(s, tip, { cd, check: () => ['it has 2 branches instead of one'] }), /it has 2 branches instead of one.*removed.*original session is unchanged/);
  assert.equal(fs.readdirSync(dir).length, before, 'nothing is left behind');

  // Each kind of damage is caught.
  const id = extractBranch(s, tip, { cd });
  const file = path.join(dir, `${id}.jsonl`);
  const good = fs.readFileSync(file, 'utf8');
  const expect = { id, prompts: ['add retry logic', 'try redis'], sourceUuids: new Set(['u1', 'a1', 'a2', 'r1', 'r2', 'a3', 'u2', 'a4', 'u3']) };
  assert.deepEqual(verifyCheckout(file, expect), []);
  const damage = (fn) => {
    fs.writeFileSync(file, good.trim().split('\n').map((l) => JSON.parse(l)).flatMap(fn).map((d) => JSON.stringify(d)).join('\n') + '\n');
    return verifyCheckout(file, expect).join(' | ');
  };
  assert.match(damage((d) => [{ ...d, sessionId: d.uuid === 'a4' ? B : d.sessionId }]), /another session/);
  assert.match(damage((d) => (d.uuid === 'a3' ? [] : [d])), /parent that was left behind/);
  assert.match(damage((d) => (d.uuid === 'u2' ? [d, { ...d, uuid: 'u2b', message: { role: 'user', content: 'a rival' } }] : [d])), /2 branches instead of one/);
  assert.match(damage((d) => (d.uuid === 'u2' ? [{ ...d, message: { role: 'user', content: 'something else' } }] : [d])), /prompts differ/);
});
