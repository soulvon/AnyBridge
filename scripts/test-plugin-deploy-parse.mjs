// Sanity check for the plugin deploy.md parser + variable substitution.
// Run: node scripts/test-plugin-deploy-parse.mjs
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseDeployMd, replaceVars } from '../sidecar/step-executor.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const mdPath = join(repoRoot, 'src-tauri', 'resources', 'plugins', 'grok2api', 'deploy.md');
const md = await readFile(mdPath, 'utf-8');
const parsed = parseDeployMd(md);

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

console.log('策略:', Object.keys(parsed.strategies).join(', '));
check('解析出 source 与 docker 两个策略', 'source' in parsed.strategies && 'docker' in parsed.strategies);

for (const [name, s] of Object.entries(parsed.strategies)) {
  console.log(`\n--- ${name} --- prereq=${s.prerequisites.length} env=${s.envVars.length} steps=${s.steps.length}`);
  s.steps.forEach((st, i) => {
    const v = st.validations
      .map((x) => (x.type === 'fileExists' ? `fileExists(${x.path})` : 'custom'))
      .join(', ');
    console.log(`  ${i + 1}. ${st.title} | cmds=${st.commands.length} | validations=[${v}]`);
  });
}

const src = parsed.strategies.source;
const buildBackend = src.steps.find((s) => /build backend/i.test(s.title));
check(
  'Build Backend 步骤的产物验证是 fileExists（不是恒真的 custom）',
  !!buildBackend && buildBackend.validations.some((v) => v.type === 'fileExists')
);
check('Build Backend 只保留当前平台的命令块', !!buildBackend && buildBackend.commands.length === 1);
check('source 策略保留全部 5 个步骤', src.steps.length === 5);
check(
  'Start & Verify 归属 source 而非 docker',
  src.steps.some((s) => /start & verify/i.test(s.title)) &&
    !parsed.strategies.docker.steps.some((s) => /start & verify/i.test(s.title))
);
check('docker 策略只有自己的 2 个步骤', parsed.strategies.docker.steps.length === 2);

const vars = {
  installPath: 'C:\\install',
  ext: process.platform === 'win32' ? '.exe' : '',
  config: { port: 8000 },
  port: 8000,
};
const expanded = replaceVars('{installPath}\\grok2api{ext} port={config.port}', vars);
console.log('\n变量替换 =>', expanded);
check('{ext} 被替换', !expanded.includes('{ext}'));
check('{config.port} 被替换为 8000', expanded.includes('port=8000'));
check('{installPath} 被替换', !expanded.includes('{installPath}'));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
