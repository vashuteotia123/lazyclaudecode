// Real sessions from each Claude Code version, scrubbed (see scripts/add-fixture.js). Each one is
// checked against the snapshot taken when it was captured, and against rules any session must keep.
// After a deliberate change in what lazycode sees, refresh the snapshots and review the diff:
//
//   UPDATE_SNAPSHOTS=1 npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildDemoHome } from '../scripts/demo-home.js';
import { expectedFile, listFixtures, loadFixture, snapshot, writeExpected } from '../scripts/fixtures.js';
import { extractBranch } from '../src/ops.js';
import { buildTree, loadTranscript, readRecords, scan } from '../src/store.js';

const segments = (seg) => (!seg ? [] : [seg, ...seg.children.flatMap(segments)]);
const prompts = (file, tip) => loadTranscript(file, { tip }).items.filter((i) => i.role === 'user').map((i) => i.text);

for (const name of listFixtures()) {
  test(`Claude Code ${name}: matches its snapshot`, () => {
    const { session } = loadFixture(name);
    assert.ok(session, 'the session is found');
    if (process.env.UPDATE_SNAPSHOTS) writeExpected(name, session);
    assert.deepEqual(snapshot(session), JSON.parse(fs.readFileSync(expectedFile(name), 'utf8')));
  });

  test(`Claude Code ${name}: keeps the branch rules`, () => {
    const { cd, session } = loadFixture(name);
    keepsBranchRules(cd, session);
  });
}

// The same rules on the fictional demo home, so they run even where no fixtures are present.
test('demo sessions keep the branch rules', () => {
  const { cd } = buildDemoHome(fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaudecode-rules-')));
  const sessions = scan({ cd, useCache: false }).sessions;
  assert.ok(sessions.some((s) => s.branches > 2), 'the demo has a session with nested branches');
  for (const s of sessions) keepsBranchRules(cd, s);
});

function keepsBranchRules(cd, s) {
  const all = segments(s.tree);
  const leaves = all.filter((seg) => !seg.children.length);
  const tree = buildTree(readRecords(s.file));

  // Every prompt sits on exactly one branch.
  const promptNodes = [...tree.nodes.values()].filter((n) => n.prompt).length;
  assert.equal(all.reduce((n, seg) => n + seg.prompts, 0), promptNodes, 'prompts across branches add up to the prompts in the file');

  // A branch only exists where a prompt was edited or rewound, never for parallel tool calls.
  for (const seg of all) if (seg !== s.tree) assert.ok(seg.prompts > 0, `branch at ${seg.head} starts with a prompt`);

  // The session is on exactly one branch, the one holding the last message written.
  assert.equal(leaves.filter((seg) => seg.active).length, 1, 'one active branch');

  // Checking out any branch gives a session with that branch's prompts and no other branch.
  for (const leaf of leaves) {
    const id = extractBranch(s, leaf.tip, { cd });
    const copy = scan({ cd, useCache: false }).byId.get(id);
    assert.equal(copy.branches, 1, `checkout of ${leaf.tip} is linear`);
    assert.deepEqual(prompts(copy.file), prompts(s.file, leaf.tip), `checkout of ${leaf.tip} keeps its prompts in order`);
  }
}
