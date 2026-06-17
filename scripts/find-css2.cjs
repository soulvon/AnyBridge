const fs = require('fs');
const f = 'C:/Users/admin/AppData/Local/CodeBuddyExtension/Data/8e47d7fa-39a9-4458-abfe-312041f07bf0/CodeBuddyIDE/8e47d7fa-39a9-4458-abfe-312041f07bf0/history/5b77a1a3387eaef7d14df313593b1ad2/40cffba3cb8a43d6826a500b75ff381f/messages/b90f579e588749f78da5b160e65cc685.json';
const data = JSON.parse(fs.readFileSync(f, 'utf8'));
const msgStr = data.message;
const idx = msgStr.indexOf('50-platforms.css');
console.log('50-platforms index:', idx);
console.log('Context around:', msgStr.substring(Math.max(0, idx-200), idx+300));
