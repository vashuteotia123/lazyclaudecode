// Terminal helpers: colours, width-aware truncation/wrapping, formatting.
import os from 'node:os';

const sgr = (on, off) => (s) => `\x1b[${on}m${s}\x1b[${off}m`;
export const c = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
};

const ANSI_ALL = /\x1b\[[0-9;]*m/g;
const ANSI_AT = /\x1b\[[0-9;]*m/y;

export const strip = (s) => s.replace(ANSI_ALL, '');

// Transcript text is untrusted: drop control characters so it cannot drive the terminal.
export const clean = (s) => String(s).replace(/[\t\n\r]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');

function cpWidth(cp) {
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function width(s) {
  let w = 0;
  for (const ch of strip(s)) w += cpWidth(ch.codePointAt(0));
  return w;
}

// Truncate (with an ellipsis) or pad `s` to exactly `w` columns, keeping colour codes intact.
export function fit(s, w, pad = true) {
  if (w <= 0) return '';
  const vw = width(s);
  if (vw <= w) return pad ? s + ' '.repeat(w - vw) : s;
  let out = '';
  let col = 0;
  let i = 0;
  let styled = false;
  while (i < s.length) {
    if (s.charCodeAt(i) === 27) {
      ANSI_AT.lastIndex = i;
      const m = ANSI_AT.exec(s);
      if (m) {
        out += m[0];
        i += m[0].length;
        styled = true;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    const cw = cpWidth(cp);
    if (col + cw > w - 1) break;
    out += String.fromCodePoint(cp);
    col += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  // Close whatever style the cut-off text opened; plain text stays free of escape codes.
  out += styled ? '…\x1b[22;39m' : '…';
  col += 1;
  return pad ? out + ' '.repeat(w - col) : out;
}

function cut(s, w) {
  let col = 0;
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i);
    const cw = cpWidth(cp);
    if (col + cw > w) break;
    col += cw;
    i += cp > 0xffff ? 2 : 1;
  }
  return [s.slice(0, i), s.slice(i)];
}

// Word-wrap plain text to `w` columns. Blank-line runs are collapsed.
export function wrap(text, w) {
  const out = [];
  if (w < 1) return out;
  for (const raw of String(text).split('\n')) {
    const line = clean(raw.replace(/\t/g, '  ')).trimEnd();
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    let cur = '';
    let cw = 0;
    for (const word of line.split(/( +)/)) {
      if (!word) continue;
      const ww = width(word);
      if (cw + ww <= w) {
        cur += word;
        cw += ww;
        continue;
      }
      if (cur.trim()) out.push(cur.trimEnd());
      cur = '';
      cw = 0;
      if (/^ +$/.test(word)) continue;
      let rest = word;
      while (width(rest) > w) {
        const [head, tail] = cut(rest, w);
        out.push(head);
        rest = tail;
      }
      cur = rest;
      cw = width(rest);
    }
    if (cur.trim()) out.push(cur.trimEnd());
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

// Mark every case-insensitive occurrence of `q` in a rendered line. Returns null when there is none.
export function highlight(line, q) {
  const plain = strip(line);
  const low = plain.toLowerCase();
  const needle = q.toLowerCase();
  let at = low.indexOf(needle);
  if (!needle || at < 0) return null;
  let out = '';
  let pos = 0;
  while (at >= 0) {
    out += `${plain.slice(pos, at)}\x1b[43;30m${plain.slice(at, at + needle.length)}\x1b[49;39m`;
    pos = at + needle.length;
    at = low.indexOf(needle, pos);
  }
  return out + plain.slice(pos);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');

export function dt(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export const ymd = (ms) => {
  const d = new Date(ms || Date.now());
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

export function rel(ms, now = Date.now()) {
  if (!ms) return '-';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 60) return `${Math.floor(s / (86400 * 7))}w`;
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${p2(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

export function num(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function bytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export function tilde(p) {
  const home = os.homedir();
  return p && p.startsWith(home) ? `~${p.slice(home.length)}` : p || '';
}
