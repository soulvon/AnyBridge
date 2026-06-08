// scripts/fix_vision_capability.cjs — 修复 provider 的 vision 配置
// 用法: node scripts/fix_vision_capability.cjs <provider-name> [model1,model2,...]

const fs = require('fs');
const path = require('path');
const os = require('os');

function configDir() {
  if (process.env.BYOK_CONFIG_DIR) return process.env.BYOK_CONFIG_DIR;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ide-byok');
  if (process.platform === 'linux') return path.join(os.homedir(), '.config', 'ide-byok');
  return path.join(os.homedir(), 'AppData', 'Roaming', 'ide-byok');
}

const providersPath = path.join(configDir(), 'providers.json');

// 读取命令行参数
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('用法: node scripts/fix_vision_capability.cjs <provider-name> [model1,model2,...]');
  console.log('');
  console.log('示例:');
  console.log('  node scripts/fix_vision_capability.cjs "君の公益"');
  console.log('  node scripts/fix_vision_capability.cjs "君の公益" claude-opus-4-6,claude-opus-4-7');
  console.log('');
  console.log('如果不指定模型，会为该 provider 的所有模型启用 vision');
  process.exit(0);
}

const providerName = args[0];
const modelsArg = args[1];
const specificModels = modelsArg ? modelsArg.split(',').map(m => m.trim()) : null;

console.log(`🔧 修复 "${providerName}" 的 vision 配置\n`);

// 读取配置
if (!fs.existsSync(providersPath)) {
  console.error(`❌ 配置文件不存在: ${providersPath}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
} catch (e) {
  console.error(`❌ 解析配置文件失败: ${e.message}`);
  process.exit(1);
}

// 查找 provider
const provider = config.providers.find(p => p.name === providerName);
if (!provider) {
  console.error(`❌ 未找到 provider: ${providerName}`);
  console.log('\n可用的 providers:');
  config.providers.forEach(p => console.log(`  - ${p.name}`));
  process.exit(1);
}

console.log(`✅ 找到 provider: ${provider.name} (${provider.id})`);
console.log(`   当前配置:`);
console.log(`   - capabilities.vision: ${provider.capabilities?.vision ?? 'undefined'}`);
console.log(`   - capabilities.tools: ${provider.capabilities?.tools ?? 'undefined'}`);

// 更新供应商级配置
provider.capabilities = provider.capabilities || {};
const oldVision = provider.capabilities.vision;
provider.capabilities.vision = true;

console.log(`\n📝 更新供应商级配置:`);
console.log(`   capabilities.vision: ${oldVision} → true`);

// 更新模型级配置
provider.modelCaps = provider.modelCaps || {};

if (specificModels) {
  console.log(`\n📝 更新指定模型的 vision 配置:`);
  for (const model of specificModels) {
    provider.modelCaps[model] = provider.modelCaps[model] || {};
    const oldModelVision = provider.modelCaps[model].vision;
    provider.modelCaps[model].vision = true;
    console.log(`   ${model}: ${oldModelVision ?? 'undefined'} → true`);
  }
} else {
  // 更新所有已配置的模型
  const models = Object.keys(provider.modelCaps);
  if (models.length > 0) {
    console.log(`\n📝 更新所有已配置模型的 vision:`);
    for (const model of models) {
      const oldModelVision = provider.modelCaps[model].vision;
      provider.modelCaps[model].vision = true;
      console.log(`   ${model}: ${oldModelVision ?? 'undefined'} → true`);
    }
  } else {
    console.log(`\n⚠️  该 provider 没有配置模型级 capabilities`);
    console.log(`   供应商级 vision: true 已足够`);
  }
  
  // 为 models 列表中的模型也添加配置
  if (provider.models && provider.models.length > 0) {
    console.log(`\n📝 为 models 列表中的模型添加 vision 配置:`);
    for (const model of provider.models) {
      if (!provider.modelCaps[model]) {
        provider.modelCaps[model] = { vision: true, tools: true };
        console.log(`   ${model}: 新增配置`);
      }
    }
  }
}

// 备份原配置
const backupPath = `${providersPath}.backup-${Date.now()}`;
fs.writeFileSync(backupPath, JSON.stringify(config, null, 2), 'utf8');
console.log(`\n💾 已备份原配置到: ${backupPath}`);

// 保存新配置
fs.writeFileSync(providersPath, JSON.stringify(config, null, 2), 'utf8');
console.log(`✅ 已保存新配置到: ${providersPath}`);

console.log(`\n⚠️  请重启 sidecar 服务使配置生效`);
console.log(`\n📋 验证步骤:`);
console.log(`   1. 重启 sidecar`);
console.log(`   2. 在 IDE 中发送包含图片的消息`);
console.log(`   3. 运行: node scripts/find_real_image_request.cjs`);
console.log(`   4. 检查模型是否正确识别图片内容`);
