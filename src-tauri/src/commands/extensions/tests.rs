use super::*;
use super::archive_and_config::*;


#[test]
fn plugins_section_survives_config_rewrite() {
    let dir = std::env::temp_dir().join(format!(
        "anybridge-cpa-plugins-test-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();

    // 旧版本 config.yaml：含插件启用状态与配置
    let old = dir.join("old-config.yaml");
    fs::write(
        &old,
        "host: \"127.0.0.1\"\nplugins:\n  enabled: true\n  dir: \"plugins\"\n  configs:\n    oc2cpa:\n      enabled: true\n      dynamic_models: true\n      usage_log: true\nws-auth: true\n",
    )
    .unwrap();

    // 1. 提取：plugins 段完整取出
    let section = extract_plugins_section(&old).expect("应提取到 plugins 段");
    let yaml = serde_yaml::to_string(&section).unwrap();
    assert!(yaml.contains("oc2cpa"), "提取结果应含插件配置");
    assert!(yaml.contains("dynamic_models: true"), "提取结果应含插件参数");

    // 2. 重写：模板 + 保留的 plugins 段，密钥同时刷新
    let new_dir = dir.join("new-version");
    fs::create_dir_all(&new_dir).unwrap();
    write_cpa_config(&new_dir, "mgmt-key-123", "sk-api-456", Some(&old)).unwrap();
    let written = fs::read_to_string(new_dir.join("config.yaml")).unwrap();
    assert!(written.contains("oc2cpa"), "新配置必须保留插件配置段");
    assert!(written.contains("dynamic_models: true"), "新配置必须保留插件参数");
    assert!(written.contains("mgmt-key-123"), "新配置必须写入当前管理密钥");
    assert!(written.contains("sk-api-456"), "新配置必须写入当前 API 密钥");
    // 保留段必须是顶层 plugins 键，不能被嵌套进别的键
    assert!(
        written.lines().any(|l| l == "plugins:"),
        "plugins 必须是顶层键"
    );
    // 旧配置内容可被重新解析
    let reparsed: serde_yaml::Value = serde_yaml::from_str(&written).unwrap();
    let plugins = reparsed
        .as_mapping()
        .unwrap()
        .iter()
        .find(|(k, _)| k.as_str() == Some("plugins"))
        .map(|(_, v)| v.clone())
        .expect("重写后应能解析出 plugins 段");
    assert!(plugins.is_mapping());

    // 3. 无旧配置（全新安装）：回落默认段
    let bare_dir = dir.join("bare-version");
    fs::create_dir_all(&bare_dir).unwrap();
    write_cpa_config(&bare_dir, "k", "k", None).unwrap();
    let bare = fs::read_to_string(bare_dir.join("config.yaml")).unwrap();
    assert!(bare.contains("plugins:"), "全新安装也应有 plugins 段");
    assert!(bare.contains("dir: plugins"), "默认段 dir 为 plugins");
    assert!(!bare.contains("oc2cpa"), "全新安装不应残留旧插件配置");

    // 4. 旧配置损坏/不存在：不 panic，回落默认段
    let broken = dir.join("broken.yaml");
    fs::write(&broken, "plugins: [这不是mapping").unwrap();
    assert!(extract_plugins_section(&broken).is_none());
    assert!(extract_plugins_section(&dir.join("not-exist.yaml")).is_none());

    let _ = fs::remove_dir_all(&dir);
}
