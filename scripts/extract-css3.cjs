const fs = require('fs');
const f = process.argv[2] || 'C:/Users/admin/AppData/Local/CodeBuddyExtension/Data/8e47d7fa-39a9-4458-abfe-312041f07bf0/CodeBuddyIDE/8e47d7fa-39a9-4458-abfe-312041f07bf0/history/5b77a1a3387eaef7d14df313593b1ad2/57a01be6aa3c455cb919c34bd534d307/messages/0b827d4402fe4c9ea8de311109a33bee.json';
const raw = fs.readFileSync(f, 'utf8');
const data = JSON.parse(raw);
const msg = JSON.parse(data.message);
const calls = msg.content.filter(c => c.type === 'tool-call' && (c.toolName === 'write_to_file' || c.toolName === 'replace_in_file') && c.args.filePath && c.args.filePath.includes('50-platforms'));
console.log('Found calls:', calls.length);
for (const c of calls) {
  console.log('Tool:', c.toolName, 'Path:', c.args.filePath);
  const content = c.args.content || c.args.new_str || '';
  console.log('Length:', content.length);
  if (content.length > 500) {
    console.log('---CONTENT_START---');
    console.log(content);
    console.log('---CONTENT_END---');
  }
}
