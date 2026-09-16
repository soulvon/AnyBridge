import { spawn } from 'node:child_process';

// Linux AppImage 打包时禁止 linuxdeploy 盲目 strip 打破 Node.js pkg payload
process.env.NO_STRIP = 'true';

const args = process.argv.slice(2);
const isWindows = process.platform === 'win32';
const cmd = isWindows ? 'npx.cmd' : 'npx';

const child = spawn(cmd, ['tauri', 'build', ...args], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
