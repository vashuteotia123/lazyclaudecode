// Captured sessions under test/fixtures, shared by the tests and by add-fixture.js.
//
//   test/fixtures/<Claude Code version>/session.jsonl.gz
//                                      subagents/agent-<id>.jsonl.gz, agent-<id>.meta.json
//                                      expected.json   what lazycode made of it when captured
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { munge, scan } from '../src/store.js';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

export const listFixtures = () => (fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((n) => fs.existsSync(path.join(FIXTURES, n, 'session.jsonl.gz'))).sort() : []);

const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');

// Lay a fixture out as a Claude Code home in a temporary folder and return the session in it.
export function loadFixture(name) {
  const src = path.join(FIXTURES, name);
  const text = gunzip(path.join(src, 'session.jsonl.gz'));
  const recs = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const id = recs.find((d) => d.uuid && d.sessionId).sessionId;
  const cwd = recs.find((d) => d.cwd).cwd;
  const cd = fs.mkdtempSync(path.join(os.tmpdir(), `lazyclaudecode-fx-`));
  const dir = path.join(cd, 'projects', munge(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), text);
  const subSrc = path.join(src, 'subagents');
  if (fs.existsSync(subSrc)) {
    const sub = path.join(dir, id, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    for (const f of fs.readdirSync(subSrc)) {
      if (f.endsWith('.jsonl.gz')) fs.writeFileSync(path.join(sub, f.slice(0, -3)), gunzip(path.join(subSrc, f)));
      else fs.copyFileSync(path.join(subSrc, f), path.join(sub, f));
    }
  }
  return { cd, session: scan({ cd, useCache: false }).byId.get(id) };
}

const shape = (seg) => (!seg ? null : { prompts: seg.prompts, active: seg.active, first: seg.first, ...(seg.virtual && { virtual: true }), ...(seg.children.length && { children: seg.children.map(shape) }) });

// What the snapshot records: the counts the detail pane shows and the shape of the branch tree.
export const snapshot = (s) => ({
  claudeCode: s.version,
  prompts: s.prompts,
  replies: s.turns,
  toolCalls: s.tools,
  compactions: s.compactions,
  branches: s.branches,
  subagents: s.agents.length,
  tree: shape(s.tree),
});

export const expectedFile = (name) => path.join(FIXTURES, name, 'expected.json');
export const writeExpected = (name, s) => fs.writeFileSync(expectedFile(name), `${JSON.stringify(snapshot(s), null, 2)}\n`);
