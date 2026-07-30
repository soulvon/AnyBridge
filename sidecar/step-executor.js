// sidecar/step-executor.js
// Parses deploy.md and executes deployment steps sequentially.
// Each step has a title, bash commands, and optional validation checks.

import { readFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { spawn } from 'child_process';

// ── Parse deploy.md into structured steps ──
// Returns: { strategies: { source: { prerequisites, envVars, steps }, docker: { ... } } }
function parseDeployMd(content) {
  const strategies = {};
  let currentStrategy = null;
  let currentSection = null; // 'prerequisites' | 'env' | 'steps' | 'notes' | 'uninstall'
  let currentStep = null;
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines = [];
  let currentPlatform = null; // for platform-specific steps

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect code blocks
    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = trimmed.slice(3).trim();
        codeLines = [];
      } else {
        inCodeBlock = false;
        if (currentStep && codeLines.length > 0) {
          if (!currentPlatform || currentPlatform === currentPlatformLabel()) {
            currentStep.commands = currentStep.commands || [];
            currentStep.commands.push({ lang: codeLang, lines: codeLines.join('\n') });
          }
          currentPlatform = null;
        }
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Any `##` heading closes the current step. `## Strategy: X` opens a new strategy;
    // anything else (Notes / Uninstall / ...) leaves strategy step scope so trailing
    // sections don't get absorbed into the next strategy.
    const h2Match = trimmed.match(/^##\s+(.+)/);
    if (h2Match) {
      if (currentStep && currentStrategy) {
        strategies[currentStrategy].steps.push(currentStep);
      }
      currentStep = null;
      currentPlatform = null;

      const stratMatch = h2Match[1].match(/^Strategy:\s*([A-Za-z0-9_-]+)/i);
      if (stratMatch) {
        currentStrategy = stratMatch[1].toLowerCase();
        strategies[currentStrategy] = { prerequisites: [], envVars: [], steps: [] };
        currentSection = null;
      } else {
        currentSection = 'other';
      }
      continue;
    }

    // ### Prerequisites / Environment Variables / Steps / Notes / Uninstall
    const sectionMatch = trimmed.match(/^###\s+(.+)/i);
    if (sectionMatch && currentStrategy) {
      const sectionName = sectionMatch[1].toLowerCase();
      if (sectionName.includes('prerequisite')) currentSection = 'prerequisites';
      else if (sectionName.includes('environment') || sectionName.includes('env')) currentSection = 'env';
      else if (sectionName.includes('step')) currentSection = 'steps';
      else currentSection = 'other';
      continue;
    }

    // #### 1. Clone Source (step title)
    const stepMatch = trimmed.match(/^####\s+\d+\.\s+(.+)/i);
    if (stepMatch && currentStrategy && currentSection === 'steps') {
      if (currentStep) strategies[currentStrategy].steps.push(currentStep);
      currentStep = { title: stepMatch[1].trim(), commands: [], validations: [] };
      currentPlatform = null;
      continue;
    }

    // **Windows:** / **macOS / Linux:** platform marker
    const platformMatch = trimmed.match(/^\*\*(.+?):\*\*/);
    if (platformMatch && currentStep) {
      const p = platformMatch[1].toLowerCase();
      if (p.includes('windows')) currentPlatform = 'win32';
      else if (p.includes('mac') || p.includes('linux')) currentPlatform = 'unix';
      continue;
    }

    // **验证**: ... (validation check)
    const validationMatch = trimmed.match(/^\*\*验证\*\*[:：]?\s*(.*)/);
    if (validationMatch && currentStep) {
      const check = validationMatch[1].trim();
      if (check) {
        // Try to extract file existence check: `path` 文件存在
        const fileMatch = check.match(/[`"]([^`"]+)[`"]\s*(?:文件|目录)?存在/);
        if (fileMatch) {
          currentStep.validations.push({ type: 'fileExists', path: fileMatch[1] });
        } else {
          currentStep.validations.push({ type: 'custom', description: check });
        }
      }
      continue;
    }

    // Prerequisites list items
    if (currentSection === 'prerequisites' && trimmed.startsWith('- ') && currentStrategy) {
      strategies[currentStrategy].prerequisites.push(trimmed.slice(2));
      continue;
    }

    // Environment variables list items
    if (currentSection === 'env' && trimmed.startsWith('- ') && currentStrategy) {
      const envMatch = trimmed.match(/^-\s+(\w+)=([^\s(]+)/);
      if (envMatch) {
        strategies[currentStrategy].envVars.push({ key: envMatch[1], value: envMatch[2] });
      } else {
        strategies[currentStrategy].envVars.push({ raw: trimmed.slice(2) });
      }
      continue;
    }
  }

  // Push last step
  if (currentStep && currentStrategy) {
    strategies[currentStrategy].steps.push(currentStep);
  }

  return { strategies };
}

function currentPlatformLabel() {
  return process.platform === 'win32' ? 'win32' : 'unix';
}

// ── Replace variables in text: {installPath}, {config.port}, etc. ──
function replaceVars(text, vars) {
  return text.replace(/\{(\w+(?:\.\w+)*)\}/g, (match, key) => {
    const parts = key.split('.');
    let val = vars;
    for (const p of parts) {
      val = val?.[p];
      if (val === undefined) return match;
    }
    return String(val);
  });
}

// ── Execute a multi-line shell command, tracking `cd` to update cwd ──
// On Windows, cmd.exe /c doesn't persist cwd across lines reliably,
// so we parse each line, track cd/pushd/popd, and run each command
// with the correct cwd.
function execCommand(cmdText, options = {}) {
  return new Promise(async (resolve) => {
    const isWindows = process.platform === 'win32';
    const lines = cmdText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
    
    let currentCwd = options.cwd || process.cwd();
    const env = { ...process.env, ...options.env };
    let combinedStdout = '';
    let combinedStderr = '';
    let lastExitCode = 0;
    const timeout = options.timeout || 600000; // 10 min default

    for (const line of lines) {
      // Track cd commands to update cwd
      const cdMatch = line.match(/^(?:cd|pushd)\s+(.+)/);
      if (cdMatch) {
        let target = cdMatch[1].trim().replace(/['"]/g, '');
        // Handle cd .. 
        if (target === '..') {
          currentCwd = join(currentCwd, '..');
        } else if (isAbsolute(target)) {
          currentCwd = target;
        } else {
          currentCwd = resolve(currentCwd, target);
        }
        continue;
      }
      
      // Skip popd on Windows (we handle cd manually)
      if (line === 'popd') continue;
      
      // Skip export statements on Windows — env vars are set via options.env
      if (isWindows && line.startsWith('set ')) {
        const setMatch = line.match(/^set\s+(\w+)=([^\s]+)/);
        if (setMatch) {
          env[setMatch[1]] = replaceVars(setMatch[2], options.vars || {});
        }
        continue;
      }
      if (!isWindows && line.startsWith('export ')) {
        const exportMatch = line.match(/^export\s+(\w+)=([^\s]+)/);
        if (exportMatch) {
          env[exportMatch[1]] = replaceVars(exportMatch[2], options.vars || {});
        }
        continue;
      }

      // Execute the line
      const shell = isWindows ? 'cmd.exe' : '/bin/sh';
      const shellArgs = isWindows ? ['/c', line] : ['-c', line];

      const result = await new Promise((res) => {
        const child = spawn(shell, shellArgs, {
          cwd: currentCwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          res({ stdout, stderr: stderr + '\n[TIMEOUT]', exitCode: -1 });
        }, timeout);

        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        child.on('close', (code) => {
          clearTimeout(timer);
          res({ stdout, stderr, exitCode: code ?? -1 });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          res({ stdout, stderr: err.message, exitCode: -1 });
        });
      });

      combinedStdout += result.stdout;
      combinedStderr += result.stderr;
      lastExitCode = result.exitCode;

      if (result.exitCode !== 0) {
        resolve({ stdout: combinedStdout, stderr: combinedStderr, exitCode: result.exitCode });
        return;
      }
    }

    resolve({ stdout: combinedStdout, stderr: combinedStderr, exitCode: lastExitCode });
  });
}

// ── Run validation checks ──
// deploy.md is authored with Windows-style paths; normalize separators so the same
// document validates correctly on macOS/Linux too.
function normalizePath(p) {
  return process.platform === 'win32' ? p : p.replace(/\\/g, '/');
}

async function runValidations(validations, vars) {
  const results = [];
  for (const v of validations) {
    if (v.type === 'fileExists') {
      const checkPath = normalizePath(replaceVars(v.path, vars));
      const fullPath = isAbsolute(checkPath) ? checkPath : resolve(vars.installPath || '.', checkPath);
      const exists = existsSync(fullPath);
      results.push({ type: 'fileExists', path: fullPath, passed: exists });
    } else {
      results.push({ type: 'custom', description: v.description, passed: true });
    }
  }
  return results;
}

// ── Execute a full deployment strategy ──
async function executeDeploy({ pluginId, strategy, deployMdContent, installPath, configValues, onProgress }) {
  const parsed = parseDeployMd(deployMdContent);
  const strat = parsed.strategies[strategy];
  if (!strat) {
    throw new Error(`Strategy "${strategy}" not found in deploy.md. Available: ${Object.keys(parsed.strategies).join(', ')}`);
  }

  const vars = {
    ...configValues,
    installPath,
    // Platform executable suffix, per design doc §4.2
    ext: process.platform === 'win32' ? '.exe' : '',
    config: { ...configValues },
    'config.port': configValues.port || 8000,
  };

  // Pre-step: handle existing install directory
  if (existsSync(installPath)) {
    const gitDir = join(installPath, '.git');
    if (existsSync(gitDir)) {
      onProgress?.({
        step: 0,
        title: 'Pre-check',
        status: 'done',
        message: '安装目录已存在 .git，跳过克隆步骤'
      });
      // Mark step 1 (Clone) as skipped by removing its commands
      const cloneStep = strat.steps.find(s => /clone/i.test(s.title));
      if (cloneStep) cloneStep.commands = [];
    } else {
      // Directory exists but no .git — check if empty
      const entries = await readdir(installPath);
      if (entries.length > 0) {
        onProgress?.({
          step: 0,
          title: 'Pre-check',
          status: 'running',
          message: '安装目录非空，清理中...'
        });
        await rm(installPath, { recursive: true, force: true });
        await mkdir(installPath, { recursive: true });
      }
    }
  } else {
    await mkdir(installPath, { recursive: true });
  }

  const results = [];
  let stepIndex = 0;

  for (const step of strat.steps) {
    stepIndex++;
    const stepTitle = step.title;

    // Check if this is a config-only step (no commands)
    if (!step.commands || step.commands.length === 0) {
      onProgress?.({
        step: stepIndex,
        title: stepTitle,
        status: 'skipped',
        message: '无 shell 命令，跳过（可能由 adapter 自动处理）'
      });
      results.push({ step: stepIndex, title: stepTitle, status: 'skipped' });
      continue;
    }

    onProgress?.({
      step: stepIndex,
      title: stepTitle,
      status: 'running',
      message: `执行: ${stepTitle}`
    });

    // Build env vars
    const stepEnv = {};
    for (const envVar of strat.envVars) {
      if (envVar.key) {
        stepEnv[envVar.key] = replaceVars(envVar.value, vars);
      }
    }

    let stepFailed = false;
    let stepOutput = '';

    for (const cmdBlock of step.commands) {
      const cmdText = replaceVars(cmdBlock.lines, vars);

      onProgress?.({
        step: stepIndex,
        title: stepTitle,
        status: 'running',
        message: `$ ${cmdText.split('\n')[0].slice(0, 80)}...`
      });

      const result = await execCommand(cmdText, {
        cwd: installPath,
        env: stepEnv,
        vars,
        timeout: 600000, // 10 min per command block
      });

      stepOutput += result.stdout + (result.stderr ? '\n[stderr]\n' + result.stderr : '');

      if (result.exitCode !== 0) {
        stepFailed = true;
        onProgress?.({
          step: stepIndex,
          title: stepTitle,
          status: 'error',
          message: `命令失败 (exit code ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
          output: stepOutput
        });
        results.push({
          step: stepIndex,
          title: stepTitle,
          status: 'failed',
          exitCode: result.exitCode,
          stderr: result.stderr,
          stdout: result.stdout
        });
        break;
      }
    }

    if (stepFailed) break;

    // Run validations
    const validations = await runValidations(step.validations, vars);
    const allPassed = validations.every(v => v.passed);

    if (!allPassed) {
      const failed = validations.find(v => !v.passed);
      onProgress?.({
        step: stepIndex,
        title: stepTitle,
        status: 'error',
        message: `验证失败: ${failed?.path || failed?.description || '未知'}`,
        validations
      });
      results.push({ step: stepIndex, title: stepTitle, status: 'failed', validations });
      break;
    }

    onProgress?.({
      step: stepIndex,
      title: stepTitle,
      status: 'done',
      message: `完成: ${stepTitle}`
    });
    results.push({ step: stepIndex, title: stepTitle, status: 'done', validations });
  }

  const allDone = results.every(r => r.status === 'done' || r.status === 'skipped');
  return { success: allDone, results };
}

export { parseDeployMd, executeDeploy, replaceVars, execCommand };
