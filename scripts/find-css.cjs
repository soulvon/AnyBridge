const fs = require('fs');
const f = 'C:/Users/admin/AppData/Local/CodeBuddyExtension/Data/8e47d7fa-39a9-4458-abfe-312041f07bf0/CodeBuddyIDE/8e47d7fa-39a9-4458-abfe-312041f07bf0/history/5b77a1a3387eaef7d14df313593b1ad2/40cffba3cb8a43d6826a500b75ff381f/messages/b90f579e588749f78da5b160e65cc685.json';
const data = JSON.parse(fs.readFileSync(f, 'utf8'));
const msg = JSON.parse(data.message);
const calls = msg.content.filter(c => c.type === 'tool-call' && (c.toolName === 'replace_in_file' || c.toolName === 'write_to_file') && c.args.filePath && c.args.filePath.includes('50-platforms'));
console.log('Found calls:', calls.length);
if (calls.length > 0) {
  console.log('Tool:', calls[0].toolName);
  console.log('Path:', calls[0].args.filePath);
  if (calls[0].args.content) {
    console.log('CONTENT_START');
    console.log(calls[0].args.content);
  }
  if (calls[0].args.new_str) {
    console.log('NEW_STR_START');
    console.log(calls[0].args.new_str);
  }
}