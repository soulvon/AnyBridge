import { execSync } from 'node:child_process';
import fs from 'node:fs';
const LOG = 'E:\\project\\AnyBridge\\_codex_mon.log';
function pids() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Codex.exe" /NH /FO CSV', { encoding: 'utf8', windowsHide: true });
    return [...out.matchAll(/"Codex\.exe","(\d+)"/g)].map(m => +m[1]).sort((a, b) => a - b);
  } catch { return []; }
}
function ts() { return new Date().toISOString().slice(11, 23); }
let prev = null;
let beat = 0;
fs.writeFileSync(LOG, `${ts()} MONITOR_START\n`);
setInterval(() => {
  const ids = pids();
  const key = ids.join(',');
  if (prev === null || key !== prev) {
    let tag = 'CHANGE';
    if (prev === null) tag = 'INIT';
    else {
      const prevArr = prev ? prev.split(',').map(Number) : [];
      const overlap = ids.filter(x => prevArr.includes(x)).length;
      if (prevArr.length === 0 && ids.length > 0) tag = 'STARTED';
      else if (ids.length === 0) tag = 'EXITED';
      else if (overlap === 0) tag = 'RESTARTED(all-pids-changed)';
      else tag = `PARTIAL(overlap=${overlap})`;
    }
    fs.appendFileSync(LOG, `${ts()} ${tag} count=${ids.length} pids=[${key}]\n`);
    prev = key;
  }
  if (++beat % 20 === 0) fs.appendFileSync(LOG, `${ts()} heartbeat count=${ids.length}\n`);
}, 1000);
