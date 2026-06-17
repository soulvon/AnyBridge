const fs = require('fs');
const path = require('path');

const dir = 'C:/Users/admin/AppData/Local/CodeBuddyExtension/Data/8e47d7fa-39a9-4458-abfe-312041f07bf0/CodeBuddyIDE/8e47d7fa-39a9-4458-abfe-312041f07bf0/history/5b77a1a3387eaef7d14df313593b1ad2/40cffba3cb8a43d6826a500b75ff381f/messages';

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort((a, b) => {
  const sa = fs.statSync(path.join(dir, a));
  const sb = fs.statSync(path.join(dir, b));
  return sb.mtime - sa.mtime; // newest first
});

let found = [];

for (const file of files) {
  const fp = path.join(dir, file);
  const raw = fs.readFileSync(fp, 'utf8');
  if (!raw.includes('50-platforms.css')) continue;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    continue;
  }

  let msg;
  try {
    msg = typeof data.message === 'string' ? JSON.parse(data.message) : data.message;
  } catch (e) {
    continue;
  }

  if (!msg || !msg.content || !Array.isArray(msg.content)) continue;

  for (const item of msg.content) {
    if (item.type !== 'tool-call') continue;
    if (item.toolName !== 'write_to_file' && item.toolName !== 'replace_in_file') continue;
    const args = item.args || {};
    if (!args.filePath || !args.filePath.includes('50-platforms.css')) continue;

    const content = args.content || args.new_str || '';
    if (content.length > 100) {
      found.push({
        file,
        tool: item.toolName,
        content,
        length: content.length
      });
    }
  }
}

// sort by content length descending
found.sort((a, b) => b.length - a.length);

console.log('Found', found.length, 'entries for 50-platforms.css');
if (found.length > 0) {
  console.log('Largest entry:', found[0].file, found[0].tool, found[0].length, 'chars');
  console.log('---CSS_START---');
  console.log(found[0].content);
  console.log('---CSS_END---');
} else {
  console.log('No entries found with usable content.');
}
