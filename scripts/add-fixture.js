#!/usr/bin/env node
// Add one of your own sessions to the test corpus, scrubbed:
//
//   node scripts/add-fixture.js <session id or prefix>
//
// Check the printed tree against what you remember doing in that session before committing: the
// snapshot records what lazycode sees today, and a wrong one would make the tests defend a bug.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { captureSession, treeLines } from '../src/scrub.js';
import { scan } from '../src/store.js';
import { FIXTURES, loadFixture, writeExpected } from './fixtures.js';

const prefix = process.argv[2];
const found = scan().sessions.filter((s) => prefix && s.id.startsWith(prefix));
if (found.length !== 1) {
  console.error(found.length ? `"${prefix}" matches ${found.length} sessions.` : 'usage: node scripts/add-fixture.js <session id or prefix>');
  process.exit(1);
}
const s = found[0];
let name = s.version || 'unknown';
for (let n = 2; fs.existsSync(path.join(FIXTURES, name)); n++) name = `${s.version}-${n}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaudecode-add-'));
const r = captureSession(s, tmp);
const dest = path.join(FIXTURES, name);
for (const f of fs.readdirSync(tmp, { recursive: true })) {
  const from = path.join(tmp, f);
  if (!fs.statSync(from).isFile()) continue;
  const to = path.join(dest, f.endsWith('.jsonl') ? `${f}.gz` : f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, f.endsWith('.jsonl') ? zlib.gzipSync(fs.readFileSync(from), { level: 9 }) : fs.readFileSync(from));
}
fs.rmSync(tmp, { recursive: true, force: true });
writeExpected(name, loadFixture(name).session);
console.log(`Added test/fixtures/${name}

Words kept as written: ${r.kept.join(', ')}

Branches:
${treeLines(r.tree).map((l) => `  ${l}`).join('\n')}

Check the tree against what you did in that session, then commit test/fixtures/${name}.`);
