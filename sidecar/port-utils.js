// port-utils.js — 跨平台回收被占用端口。
// Windows 无 lsof，旧代码只打印 lsof 提示后 exit(1)，导致 sidecar 一遇端口占用就退出。

import { execSync } from 'node:child_process';

// 仅回收本应用的代理进程：校验 PID 的进程名是否为 node 系，避免误杀
// 恰好占用 7450/7451 的其它无关程序（强杀用户进程会丢数据）。
const SAFE_NAMES = ['node', 'ide-byok-proxy'];

function isSafeToKill(pid) {
  try {
    if (process.platform === 'win32') {
      // CSV 输出首列是镜像名，如 "node.exe","1234",...
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
      const name = (out.match(/^"([^"]+)"/) || [])[1] || '';
      const base = name.toLowerCase().replace(/\.exe$/, '');
      return SAFE_NAMES.some(n => base === n || base.startsWith(n));
    }
    const out = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8' }).trim().toLowerCase();
    const base = out.split('/').pop();
    return SAFE_NAMES.some(n => base === n || base.startsWith(n));
  } catch {
    return false; // 查不到进程名 → 保守不杀
  }
}

// 杀掉监听指定端口的进程（跨平台）。返回是否真的杀到了进程。
// 只杀 LISTENING 该端口、且进程名为本应用代理（node 系）的 PID，跳过自身。
export function killPortHolder(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && parseInt(m[1], 10) === port) pids.add(m[2]);
      }
      let any = false;
      for (const pid of pids) {
        if (pid === String(process.pid)) continue;
        if (!isSafeToKill(pid)) {
          console.error(`⚠ [port] 端口 ${port} 被非本应用进程(PID ${pid})占用，跳过强杀`);
          continue;
        }
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); any = true; } catch {}
      }
      return any;
    } else {
      const out = execSync(`lsof -ti tcp:${port} -s tcp:LISTEN`, { encoding: 'utf8' });
      const pids = out.split(/\s+/).filter(Boolean).filter(p => p !== String(process.pid));
      let any = false;
      for (const pid of pids) {
        if (!isSafeToKill(pid)) {
          console.error(`⚠ [port] 端口 ${port} 被非本应用进程(PID ${pid})占用，跳过强杀`);
          continue;
        }
        try { execSync(`kill -9 ${pid}`, { stdio: 'ignore' }); any = true; } catch {}
      }
      return any;
    }
  } catch {
    return false;
  }
}

// 监听端口，遇 EADDRINUSE 时回收占用进程并重试。
// onListen: 监听成功回调；label: 日志用名称。
// 即使没杀到进程也重试一次：端口可能已被其它回收路径释放（同一 sidecar 内
// hybrid/inference 并发回收、或残留连接处于 TIME_WAIT 自然消退）。
export function listenWithReclaim(server, port, onListen, label = 'proxy') {
  let attempts = 0;
  let announced = false;
  const MAX_ATTEMPTS = 3;
  const announce = () => {
    if (announced) return;
    announced = true;
    onListen();
  };
  const start = () => server.listen(port, announce);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      attempts += 1;
      if (attempts <= MAX_ATTEMPTS) {
        console.error(`⚠ [${label}] Port ${port} in use — reclaim attempt ${attempts}/${MAX_ATTEMPTS}...`);
        killPortHolder(port); // 杀到与否都重试：端口可能已被别处释放
        setTimeout(start, 700);
        return;
      }
      console.error(`❌ [${label}] Port ${port} still in use after ${MAX_ATTEMPTS} attempts.`);
    } else {
      console.error(`[${label}] Server error:`, err);
    }
    process.exit(1);
  });

  start();
}
