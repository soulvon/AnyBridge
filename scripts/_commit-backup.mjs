import { execSync } from 'node:child_process';

function sh(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: opts.stdio || 'inherit',
    windowsHide: true,
  });
}

sh('git add ui/assets/scripts/20-runtime.js');
const msg = [
  'chore: backup before UI regression restore',
  '',
  'Checkpoint is-danger button state toggle restore before full',
  'stats/logs/nav/path-click recovery work.',
].join('\n');

// Write message to temp file to avoid shell quoting issues
import { writeFileSync, unlinkSync } from 'node:fs';
writeFileSync('scripts/_commit-msg.tmp', msg, 'utf8');
try {
  sh('git commit -F scripts/_commit-msg.tmp');
} finally {
  try { unlinkSync('scripts/_commit-msg.tmp'); } catch {}
}
console.log(execSync('git log -1 --oneline', { encoding: 'utf8' }));
console.log(execSync('git status --short', { encoding: 'utf8' }));
