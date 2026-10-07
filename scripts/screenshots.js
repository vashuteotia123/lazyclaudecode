#!/usr/bin/env node
// Regenerate docs/screenshots from the fictional home in demo-home.js, so the pictures never show
// a real session, path or user name. Frames are drawn by the app itself and photographed in
// headless Chrome or Chromium (set CHROME to its path if it is not found):
//
//   npm run screenshots
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDemoHome } from './demo-home.js';

const COLS = 128;
const ROWS = 36;
const SHOTS = [
  ['overview', ''],
  ['branches', '3j'],
  ['search', 'sbackoff\r'],
  ['marks', 'jj  '],
  ['trash', 'T'],
];

const FG = { 30: '#0d1117', 31: '#ff7b72', 32: '#3fb950', 33: '#d29922', 34: '#58a6ff', 35: '#bc8cff', 36: '#39c5cf', 97: '#ffffff' };
const BG = { 43: '#d29922', 44: '#1f4f8f' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// One terminal row to HTML. Symbols outside the monospace font are boxed to one cell so that a
// fallback font cannot push the borders out of line.
function rowHtml(row) {
  const st = { bold: false, dim: false, fg: '', bg: '' };
  let html = '';
  for (const part of row.split(/(\x1b\[[0-9;]*m)/)) {
    if (!part) continue;
    if (part[0] === '\x1b') {
      for (const n of part.slice(2, -1).split(';').map(Number)) {
        if (n === 1) st.bold = true;
        else if (n === 2) st.dim = true;
        else if (n === 22) st.bold = st.dim = false;
        else if (n === 39) st.fg = '';
        else if (n === 49) st.bg = '';
        else if (FG[n]) st.fg = FG[n];
        else if (BG[n]) st.bg = BG[n];
      }
      continue;
    }
    const css = [st.fg && `color:${st.fg}`, st.bg && `background:${st.bg}`, st.bold && 'font-weight:bold', st.dim && 'opacity:.55'].filter(Boolean).join(';');
    const text = [...part].map((ch) => (ch.codePointAt(0) < 0x2000 || (ch >= '─' && ch <= '╿') ? esc(ch) : `<i>${ch}</i>`)).join('');
    html += css ? `<span style="${css}">${text}</span>` : text;
  }
  return `<div>${html}</div>`;
}

const page = (rows) => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#0d1117}
#win{display:inline-block}
#bar{height:34px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:8px;padding:0 14px;font:12px -apple-system,system-ui,sans-serif;color:#8b949e}
#bar b{width:12px;height:12px;border-radius:50%;background:#30363d}
#bar span{flex:1;text-align:center;margin-right:68px}
#term{padding:12px 14px;color:#c9d1d9;font:14px/17px Menlo,'DejaVu Sans Mono',Consolas,monospace;white-space:pre}
#term div{height:17px}
i{display:inline-block;width:1ch;text-align:center;font-style:normal}
</style><div id="win"><div id="bar"><b></b><b></b><b></b><span>lazycode</span></div><div id="term">${rows.map(rowHtml).join('')}</div></div>
<script>const r=document.getElementById('win').getBoundingClientRect();document.title=Math.ceil(r.width)+'x'+Math.ceil(r.height)</script>`;

function findChrome() {
  const known = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);
  return known.find((c) => !spawnSync(c, ['--version']).error);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lazycode-shots-'));
const home = path.join(tmp, 'home');
// The app must see the fictional home before it loads, so paths print as ~/code/….
process.env.HOME = process.env.USERPROFILE = home;
const { cd, hero } = buildDemoHome(home, { livePids: [process.pid, process.ppid] });
process.env.CLAUDE_CONFIG_DIR = cd;
const { createApp, parseKeys } = await import('../src/tui.js');

const chrome = findChrome();
if (!chrome) {
  console.error('Chrome or Chromium was not found. Set CHROME to its path.');
  process.exit(1);
}
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });
const headless = (args) => spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${path.join(tmp, 'chrome')}`, ...args], { encoding: 'utf8' });

let size = '';
for (const [name, keys] of SHOTS) {
  const app = createApp({ cd, sync: true, useCache: false });
  app.S.sessId = hero;
  for (const k of parseKeys(keys)) app.key(k);
  const html = path.join(tmp, `${name}.html`);
  fs.writeFileSync(html, page(app.frame(COLS, ROWS).rows));
  const url = pathToFileURL(html).href;
  // Every frame has the same dimensions; ask the page once how large the window has to be.
  size ||= /<title>(\d+)x(\d+)<\/title>/.exec(headless(['--dump-dom', url]).stdout)?.slice(1).join(',');
  if (!size) throw new Error('could not measure the page');
  const png = path.join(outDir, `${name}.png`);
  const r = headless([`--window-size=${size}`, '--force-device-scale-factor=2', `--screenshot=${png}`, url]);
  if (!fs.existsSync(png)) throw new Error(`no screenshot written: ${r.stderr}`);
  console.log(`${name}.png`);
}
fs.rmSync(tmp, { recursive: true, force: true });
