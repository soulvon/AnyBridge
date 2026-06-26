const { execSync } = require('child_process');
const msg = process.argv[2] || '你是那个模型';
console.log(`Testing: codex exec "${msg}"`);
try {
  const out = execSync(`codex exec "${msg}"`, {
    timeout: 30000,
    encoding: 'utf8',
    env: { ...process.env }
  });
  console.log('=== STDOUT ===');
  console.log(out);
  console.log('=== SUCCESS ===');
} catch (e) {
  console.log('=== STDOUT ===');
  console.log(e.stdout || '(none)');
  console.log('=== STDERR ===');
  console.log(e.stderr || '(none)');
  console.log('=== Exit code:', e.status, 'Signal:', e.signal, '===');
}
