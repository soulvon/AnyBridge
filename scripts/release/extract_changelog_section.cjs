#!/usr/bin/env node

const fs = require('fs');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function requiredArg(args, key) {
  const value = args[key];
  if (!value) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

function normalizeVersion(value) {
  return String(value || '')
    .trim()
    .replace(/^refs\/tags\//, '')
    .replace(/^v/i, '')
    .toLowerCase();
}

function parseHeadingVersion(line) {
  const match = line.match(/^##\s+\[?v?([0-9]+(?:\.[0-9]+)+(?:[-+][^\]\s]+)?)\]?/i);
  return match ? normalizeVersion(match[1]) : null;
}

function extractSection(changelog, version) {
  const target = normalizeVersion(version);
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => parseHeadingVersion(line) === target);
  if (start === -1) {
    throw new Error(`CHANGELOG section not found for version ${version}`);
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  return lines.slice(start + 1, end).join('\n').trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = requiredArg(args, 'version');
  const changelogPath = args.changelog || 'CHANGELOG.md';
  const outputPath = args.output || 'release-notes.md';

  if (!fs.existsSync(changelogPath)) {
    throw new Error(`CHANGELOG file not found: ${changelogPath}`);
  }

  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const section = extractSection(changelog, version);
  if (!section) {
    throw new Error(`CHANGELOG section for version ${version} is empty`);
  }

  fs.writeFileSync(outputPath, `${section}\n`);
  console.log(`Release notes for ${version} written to ${outputPath}`);
}

try {
  main();
} catch (error) {
  console.error(`[extract_changelog_section] ${error.message}`);
  process.exit(1);
}
