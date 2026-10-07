#!/usr/bin/env node
// Build a throwaway Claude Code home full of fictional sessions. The README screenshots come from
// it, and it is a safe place to try lazyclaudecode without touching real data:
//
//   node scripts/demo-home.js /tmp/lazyclaudecode-demo
//   HOME=/tmp/lazyclaudecode-demo CLAUDE_CONFIG_DIR=/tmp/lazyclaudecode-demo/.claude lazyclaudecode
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveMeta, trashSessions } from '../src/ops.js';
import { munge, scan, writeJson } from '../src/store.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MODEL = 'claude-sonnet-5-5';
const VERSION = '2.1.292';
const INPUT_KEY = { Bash: 'command', Read: 'file_path', Edit: 'file_path', Write: 'file_path', Grep: 'pattern', Glob: 'pattern' };

// Ids are derived from names so that two runs produce the same home.
const hex = (seed) => crypto.createHash('sha1').update(seed).digest('hex');
const uid = (seed) => {
  const h = hex(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const jsonl = (recs) => recs.map((d) => `${JSON.stringify(d)}\n`).join('');

// Records are appended the way Claude Code writes them: each one points at its parent, and going
// back to an earlier point before the next prompt leaves the old continuation behind as a branch.
function conversation(id, base, seed = []) {
  const recs = seed.map((d) => ({ ...d, sessionId: id }));
  let cursor = recs.length ? recs[recs.length - 1].uuid : null;
  let n = recs.length;
  const add = (type, extra) => {
    const uuid = uid(`${id}:${n++}`);
    recs.push({ uuid, parentUuid: cursor, sessionId: id, ...base, isSidechain: false, type, ...extra });
    cursor = uuid;
  };
  const api = {
    recs,
    you: (text) => add('user', { message: { role: 'user', content: text } }),
    claude: (text, tools = []) => {
      const uses = tools.map(([name, arg], i) => ({ type: 'tool_use', id: `toolu_${n}_${i}`, name, input: { [INPUT_KEY[name] || 'description']: arg } }));
      const usage = { input_tokens: 12, output_tokens: 240 + text.length * 2, cache_read_input_tokens: 21000 + n * 2300, cache_creation_input_tokens: 0 };
      add('assistant', { message: { id: `msg_${n}`, role: 'assistant', model: MODEL, content: [...(text ? [{ type: 'text', text }] : []), ...uses], usage } });
      if (uses.length) add('user', { message: { role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: 'ok' })) } });
    },
    mark: () => cursor,
    back: (mark) => {
      cursor = mark;
    },
    compact: () => {
      const before = cursor;
      cursor = null;
      add('system', { subtype: 'compact_boundary', logicalParentUuid: before });
      add('user', { isCompactSummary: true, message: { role: 'user', content: 'Summary of the conversation so far.' } });
    },
    // Each [prompt, reply, tools] is one exchange.
    talk: (turns) => {
      for (const [prompt, reply, tools] of turns) {
        api.you(prompt);
        api.claude(reply, tools);
      }
    },
  };
  return api;
}

export function buildDemoHome(home, { now = Date.now(), livePids = [] } = {}) {
  const cd = path.join(home, '.claude');
  const code = path.join(home, 'code');
  const meta = { v: 1, sessions: {} };
  const built = new Map();

  function session(name, { cwd, title, named = false, git = 'main', ago, span, cost = 0, pr, tags, pinned, archived, live, forkOf, agents = [] }, script) {
    const id = uid(name);
    fs.mkdirSync(cwd, { recursive: true });
    const base = { cwd, gitBranch: git, version: VERSION, entrypoint: 'cli' };
    const conv = conversation(id, base, forkOf ? built.get(forkOf.name).recs.slice(0, forkOf.records) : []);
    script(conv);
    const fresh = conv.recs.filter((d) => !d.timestamp);
    const end = now - ago;
    fresh.forEach((d, i) => {
      d.timestamp = new Date(end - span + (fresh.length > 1 ? (span * i) / (fresh.length - 1) : span)).toISOString();
    });
    const extra = named ? [{ type: 'custom-title', customTitle: title, sessionId: id }, { type: 'agent-name', agentName: title, sessionId: id }] : [{ type: 'ai-title', aiTitle: title, sessionId: id }];
    if (cost) extra.push({ type: 'cost-state', totalCostUSD: cost, sessionId: id });
    if (pr) extra.push({ type: 'pr-link', prNumber: pr, prUrl: `https://git.example.com/acme/${path.basename(cwd)}/pull/${pr}`, prRepository: `acme/${path.basename(cwd)}`, sessionId: id });
    const dir = path.join(cd, 'projects', munge(cwd));
    const file = path.join(dir, `${id}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, jsonl([...conv.recs, ...extra]));
    agents.forEach(([type, description, reply], i) => {
      const aid = hex(`${name}:agent:${i}`).slice(0, 17);
      const sub = path.join(dir, id, 'subagents');
      const side = conversation(id, base);
      side.you(description);
      side.claude(reply, [['Grep', 'dispatch\\(']]);
      side.recs.forEach((d, k) => {
        d.isSidechain = true;
        d.timestamp = new Date(end - span / 2 + k * MIN).toISOString();
      });
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, `agent-${aid}.jsonl`), jsonl(side.recs));
      fs.writeFileSync(path.join(sub, `agent-${aid}.meta.json`), JSON.stringify({ agentType: type, description }));
      fs.utimesSync(path.join(sub, `agent-${aid}.jsonl`), new Date(end - span / 2 + (i + 3) * MIN), new Date(end - span / 2 + (i + 3) * MIN));
    });
    if (tags || pinned || archived) meta.sessions[id] = { ...(tags && { tags }), ...(pinned && { pinned }), ...(archived && { archived }) };
    if (live && livePids.length) {
      const pid = livePids.shift();
      writeJson(path.join(cd, 'sessions', `${pid}.json`), { pid, sessionId: id, status: live, statusUpdatedAt: end });
    }
    built.set(name, conv);
    // A fork is told from its parent by file age, so no two files may share a creation time.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    return id;
  }

  const atlas = path.join(code, 'atlas-api');
  const store = path.join(code, 'storefront');
  const dots = path.join(code, 'dotfiles');
  const notes = path.join(code, 'ml-notebooks');

  const hero = session(
    'webhook-retries',
    {
      cwd: atlas,
      title: 'Webhook retries',
      git: 'feat/webhook-retries',
      ago: 3 * MIN,
      span: 2 * HOUR + 40 * MIN,
      cost: 4.18,
      pr: 212,
      tags: ['wip', 'infra'],
      live: 'idle',
      agents: [
        ['Explore', 'Find every caller of dispatch()', 'dispatch() is called from three places: the event bus, the admin replay endpoint and the nightly reconcile job.'],
        ['general-purpose', 'Review the retry job for race conditions', 'One race: two workers can claim the same job between the select and the update. Claim it with a single UPDATE … RETURNING instead.'],
      ],
    },
    (c) => {
      c.you('Webhook deliveries to slow endpoints are dropped after a single attempt. Add retries with exponential backoff to the dispatcher.');
      c.claude("I'll read the dispatcher and how deliveries are recorded before changing anything.", [
        ['Read', 'src/webhooks/dispatcher.ts'],
        ['Grep', 'recordDelivery'],
        ['Agent', 'Find every caller of dispatch()'],
      ]);
      c.claude('The dispatcher fires once and marks the delivery failed on any non-2xx response. There are two ways to add retries:\n\n1. In-process timers. Simple, but pending retries are lost on every deploy.\n2. The durable jobs table. Each attempt becomes a job with a run-at time.\n\nWhich do you prefer?');
      const options = c.mark();

      c.you('Keep it simple, use in-process timers');
      c.claude('Added a retry loop around the request with setTimeout and a cap of five attempts.', [
        ['Edit', 'src/webhooks/dispatcher.ts'],
        ['Bash', 'npm test -- webhooks'],
      ]);
      c.you('What happens to pending retries when we deploy?');
      c.claude('They are lost. The timers live in memory, so a restart drops every delivery that was waiting for its next attempt.');

      c.back(options);
      c.you('Use the jobs table. Retries have to survive a deploy.');
      c.claude('Moving the retry into a job so the schedule lives in the database.', [
        ['Write', 'src/webhooks/retry-job.ts'],
        ['Edit', 'src/webhooks/dispatcher.ts'],
        ['Agent', 'Review the retry job for race conditions'],
        ['Bash', 'npm test -- webhooks'],
      ]);
      c.claude('Retries now go through the jobs table. The backoff is 30s, 2m, 10m, 1h and 6h with 20% jitter, and after the fifth failure the delivery is marked dead. A worker claims a job with a single UPDATE … RETURNING, so two workers cannot send the same attempt.');
      const working = c.mark();

      c.you('Make the backoff schedule configurable per endpoint');
      c.claude('Added a retry_schedule column to endpoints and a migration for it. Every endpoint now needs a schedule or falls back to the default.', [
        ['Write', 'migrations/0042_endpoint_retry_schedule.sql'],
        ['Edit', 'src/webhooks/retry-job.ts'],
      ]);

      c.back(working);
      c.you('Leave the schedule fixed for now. Add a metric for dead deliveries and open a PR.');
      c.claude('Adding a counter and wiring it into the dead-letter path.', [
        ['Edit', 'src/metrics.ts'],
        ['Edit', 'src/webhooks/retry-job.ts'],
        ['Bash', 'npm test'],
        ['Bash', 'gh pr create --fill'],
      ]);
      c.claude('Opened #212. It adds webhook_deliveries_dead_total, labelled by endpoint, and the tests cover the full backoff schedule with a fake clock.');
    },
  );

  session('rate-limiter', { cwd: path.join(atlas, '.claude', 'worktrees', 'rate-limit'), title: 'Rate limiter design', git: 'feat/rate-limit', ago: 9 * MIN, span: 50 * MIN, cost: 1.36, tags: ['wip'], live: 'busy' }, (c) =>
    c.talk([
      ['Design a per-API-key rate limiter for the public API. We run four instances behind a load balancer.', 'With four instances the counters have to be shared, so I would keep them in Redis and use a sliding window per key.', [['Read', 'src/middleware/auth.ts'], ['Grep', 'redis']]],
      ['What should clients see when they hit the limit?', 'A 429 with a Retry-After header. Well-behaved clients then retry with backoff instead of hammering the endpoint.', [['Write', 'src/middleware/rate-limit.ts']]],
      ['Write the middleware and a load test', '', [['Edit', 'src/middleware/rate-limit.ts'], ['Write', 'test/load/rate-limit.js'], ['Bash', 'npm run test:load']]],
    ]),
  );

  session('pagination-test', { cwd: atlas, title: 'Fix flaky pagination test', ago: 5 * HOUR, span: 25 * MIN, cost: 0.42, tags: ['bug'] }, (c) =>
    c.talk([
      ['test/orders/list.test.ts fails about one run in ten on CI. Find out why.', 'The test sorts by created_at, and two fixtures share a timestamp, so their order depends on the query plan.', [['Read', 'test/orders/list.test.ts'], ['Bash', 'npm test -- orders --repeat 30']]],
      ['Fix the query, not the test', 'Added id as a tiebreaker to the ORDER BY. Thirty runs in a row now pass.', [['Edit', 'src/orders/repository.ts'], ['Bash', 'npm test -- orders --repeat 30']]],
    ]),
  );

  session('postgres-16', { cwd: atlas, title: 'Migrate to Postgres 16', git: 'chore/pg16', ago: 2 * DAY, span: 3 * HOUR, cost: 6.02, tags: ['infra'] }, (c) => {
    c.talk([
      ['Plan the upgrade from Postgres 13 to 16. We can afford ten minutes of downtime.', 'Ten minutes rules out a dump and restore at our size. pg_upgrade in link mode fits; I will check extensions first.', [['Bash', 'psql -c "select extname, extversion from pg_extension"'], ['Read', 'docker-compose.yml']]],
      ['Do it on staging first', 'Staging is on 16. The upgrade itself took 40 seconds; rebuilding statistics took another four minutes.', [['Bash', './scripts/pg-upgrade.sh staging']]],
    ]);
    c.compact();
    c.talk([['Write the runbook for production', 'The runbook is in docs/runbooks/pg16.md, with a rollback step after each stage.', [['Write', 'docs/runbooks/pg16.md']]]]);
  });

  session('postgres-16-pgbouncer', { cwd: atlas, title: 'Migrate to Postgres 16 (with pgbouncer)', named: true, git: 'chore/pg16', ago: 1 * DAY + 20 * HOUR, span: 45 * MIN, cost: 0.95, forkOf: { name: 'postgres-16', records: 6 } }, (c) =>
    c.talk([['Before production: should we put pgbouncer in front while we are at it?', 'It is a separate change with its own risks. I would ship the upgrade first and add pgbouncer a week later.', [['Read', 'infra/terraform/db.tf']]]]),
  );

  session('checkout-redesign', { cwd: store, title: 'Checkout page redesign', git: 'feat/checkout-v2', ago: 1 * DAY + 2 * HOUR, span: 4 * HOUR, cost: 3.3, tags: ['design'] }, (c) => {
    c.talk([['Rebuild the checkout page as a single column. The current three-step wizard loses people on mobile.', 'I will keep the existing form state and change only the layout, so the payment code stays untouched.', [['Read', 'src/pages/checkout.tsx'], ['Read', 'src/components/StepWizard.tsx']]]]);
    const layout = c.mark();
    c.talk([['Put the order summary at the top', 'The summary is at the top, but on small screens it pushes the first field below the fold.', [['Edit', 'src/pages/checkout.tsx']]]]);
    c.back(layout);
    c.talk([
      ['Collapse the order summary behind a total, and expand it on tap', 'The summary is now a one-line total that expands. The first field is visible without scrolling on a 360px screen.', [['Edit', 'src/pages/checkout.tsx'], ['Write', 'src/components/OrderSummary.tsx']]],
      ['Retry the payment API call when it times out', 'Added three attempts with exponential backoff and an idempotency key, so a retry can never charge twice.', [['Edit', 'src/api/payments.ts'], ['Bash', 'npm test -- payments']]],
    ]);
  });

  session('dark-mode', { cwd: store, title: 'Add dark mode toggle', git: 'feat/dark-mode', ago: 6 * DAY, span: 90 * MIN, cost: 1.1, pinned: true, tags: ['design'] }, (c) =>
    c.talk([
      ['Add a dark mode toggle to the header. Follow the system setting by default.', 'The colours are already CSS variables, so this is a second set of values and a small toggle.', [['Read', 'src/styles/tokens.css'], ['Edit', 'src/styles/tokens.css'], ['Write', 'src/components/ThemeToggle.tsx']]],
      ['Remember the choice between visits', 'The choice is saved to localStorage and applied before first paint, so there is no flash of the wrong theme.', [['Edit', 'src/components/ThemeToggle.tsx'], ['Edit', 'index.html']]],
    ]),
  );

  session('cart-rounding', { cwd: store, title: 'Cart total rounding bug', ago: 4 * DAY, span: 35 * MIN, cost: 0.51, tags: ['bug'] }, (c) =>
    c.talk([
      ['A cart with three items at 19.99 and a 15% discount shows 50.98 but charges 50.97.', 'The page rounds each line and then sums; the server sums and then rounds. I will make the page do what the server does.', [['Grep', 'toFixed'], ['Read', 'src/cart/totals.ts']]],
      ['Use integer cents everywhere', 'Totals are computed in integer cents and formatted only for display. Added the failing cart as a test.', [['Edit', 'src/cart/totals.ts'], ['Write', 'src/cart/totals.test.ts'], ['Bash', 'npm test -- cart']]],
    ]),
  );

  session('zsh-startup', { cwd: dots, title: 'zsh startup is slow', ago: 12 * DAY, span: 20 * MIN, cost: 0.2, tags: ['perf'] }, (c) =>
    c.talk([
      ['A new terminal tab takes almost two seconds to show a prompt. Profile my zsh startup.', 'nvm accounts for 1.4 of the 1.8 seconds. Loading it lazily on first use brings startup down to 0.3s.', [['Bash', 'zsh -i -c "zprof" | head -20'], ['Read', '.zshrc']]],
      ['Do that', 'Done. node, npm and npx are now small functions that load nvm the first time one of them runs.', [['Edit', '.zshrc']]],
    ]),
  );

  session('loss-curves', { cwd: notes, title: 'Plot training loss curves', ago: 20 * DAY, span: 40 * MIN, cost: 0.33 }, (c) =>
    c.talk([['Read the runs in logs/ and plot training and validation loss for each one on a shared axis.', 'Six runs plotted. Run 4 diverges after epoch 12, which matches the learning-rate change in its config.', [['Glob', 'logs/*/metrics.jsonl'], ['Write', 'plots/loss.py'], ['Bash', 'python plots/loss.py']]]]),
  );

  session('old-spike', { cwd: notes, title: 'Spike: try a cosine schedule', ago: 27 * DAY, span: 15 * MIN, archived: true }, (c) =>
    c.talk([['Swap the step schedule for cosine annealing in train.py', 'Swapped. Validation loss is within noise of the step schedule after 20 epochs.', [['Edit', 'train.py'], ['Bash', 'python train.py --epochs 20']]]]),
  );

  session('empty', { cwd: dots, title: '', ago: 8 * DAY, span: 0 }, (c) => c.you('hello'));

  const doomed = [
    session('semver-regex', { cwd: dots, title: 'Scratch: regex for semver', ago: 9 * DAY, span: 10 * MIN }, (c) => c.talk([['Write a regex that matches a semver string with an optional pre-release tag', 'Here it is, with named groups for major, minor, patch and pre-release.']])),
    session('bun-runner', { cwd: store, title: 'Try the bun test runner', ago: 15 * DAY, span: 30 * MIN }, (c) => c.talk([['Can we run the test suite under bun instead of jest?', 'Most of it runs. Fourteen tests rely on jest.mock hoisting and would need rewriting.', [['Bash', 'bun test']]]])),
  ];

  saveMeta(meta, cd);
  const { byId } = scan({ cd, useCache: false });
  const trashed = trashSessions(doomed.map((id) => byId.get(id)), cd);
  [2 * HOUR, 3 * DAY].forEach((age, i) => {
    const file = path.join(cd, 'lazyclaudecode', 'trash', trashed[i], 'manifest.json');
    writeJson(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), deletedAt: now - age });
  });
  return { cd, hero };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const home = process.argv[2];
  if (!home) {
    console.error('usage: node scripts/demo-home.js <empty directory>');
    process.exit(1);
  }
  if (fs.existsSync(home) && fs.readdirSync(home).length) {
    console.error(`${home} is not empty; pick a new directory.`);
    process.exit(1);
  }
  const { cd } = buildDemoHome(path.resolve(home));
  console.log(`Demo home ready. Try it with:\n\n  HOME=${path.resolve(home)} CLAUDE_CONFIG_DIR=${cd} lazyclaudecode`);
}
