const fs = require('fs');
const path = require('path');

const configDir = process.env.BYOK_CONFIG_DIR || 
  path.join(process.env.APPDATA || '', 'anybridge');

// Check MITM log structure
const mitmDir = path.join(configDir, 'mitm-logs');
try {
  const files = fs.readdirSync(mitmDir).sort();
  if (files.length > 0) {
    const last = fs.readFileSync(path.join(mitmDir, files[files.length-1]), 'utf8');
    const lines = last.trim().split('\n');
    // Show raw first line to see structure
    console.log('=== MITM log raw first line ===');
    console.log(lines[0].substring(0, 500));
    console.log('\n=== MITM log raw last line ===');
    console.log(lines[lines.length-1].substring(0, 500));
  }
} catch (e) {
  console.log('MITM err:', e.message);
}

// Check for proxy log files
console.log('\n=== Looking for proxy logs ===');
try {
  const allFiles = fs.readdirSync(configDir);
  console.log('Config dir files:', allFiles.filter(f => f.includes('log') || f.includes('proxy')));
} catch (e) {
  console.log('Err:', e.message);
}

// Check sidecar log
const sidecarLog = path.join(configDir, 'sidecar.log');
try {
  const data = fs.readFileSync(sidecarLog, 'utf8');
  const lines = data.trim().split('\n');
  console.log('\n=== Sidecar log (last 20 lines) ===');
  lines.slice(-20).forEach(l => console.log(l.substring(0, 200)));
} catch (e) {
  console.log('Sidecar log err:', e.message);
}

// Check env vars
console.log('\n=== Env vars ===');
console.log('BYOK_MITM_LOG:', process.env.BYOK_MITM_LOG || '(not set)');
console.log('BYOK_MITM_FULL_LOG:', process.env.BYOK_MITM_FULL_LOG || '(not set)');
console.log('BYOK_CONFIG_DIR:', process.env.BYOK_CONFIG_DIR || '(not set)');
