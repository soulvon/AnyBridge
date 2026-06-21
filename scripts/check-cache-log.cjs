const fs = require('fs'), path = require('path'), os = require('os');
const s = path.join(os.homedir(), 'AppData', 'Roaming', 'anybridge', 'stats.json');
const d = JSON.parse(fs.readFileSync(s, 'utf8'));

// 只显示今天
const today = '2026-06-20';
const todayData = d.days[today];
if (todayData) {
  console.log('=== 今日 stats ===');
  console.log('requests:', todayData.requests);
  console.log('inputTokens:', todayData.inputTokens);
  console.log('outputTokens:', todayData.outputTokens);
  console.log('cachedTokens:', todayData.cachedTokens);
  console.log('cacheCreationInputTokens:', todayData.cacheCreationInputTokens);
} else {
  console.log('今日无数据');
}

// 所有有 cachedTokens 的历史
console.log('\n=== 所有历史 cachedTokens ===');
for (const [day, data] of Object.entries(d.days)) {
  console.log(`${day}: cachedTokens=${data.cachedTokens || 0}, cacheCreationInputTokens=${data.cacheCreationInputTokens || 0}, requests=${data.requests}`);
}