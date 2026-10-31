// The newest Claude Code version whose sessions are in the test corpus (test/fixtures). Raise it
// when adding a fixture from a newer version; a test keeps the two, and the README, in step.
export const TESTED_UP_TO = '2.1.314';

// Compare two dotted versions numerically: negative when a is older than b.
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
