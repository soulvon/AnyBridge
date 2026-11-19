use super::*;

/// 构造一个最小合法 asar：header 声明 dist/preload.js 位于 payload 偏移 0。
/// 字节布局与 patch_hub_asar 写回的完全一致（pickle 四段 + padding + payload）。
fn fake_asar(preload_code: &str) -> Vec<u8> {
    let header = serde_json::json!({
        "files": { "dist": { "files": { "preload.js": {
            "size": preload_code.len(),
            "offset": "0",
            "integrity": {
                "algorithm": "SHA256",
                "hash": "test",
                "blockSize": 4194304,
                "blocks": ["test"]
            }
        }}}}
    });
    let header_json = serde_json::to_string(&header).unwrap();
    let padding = asar_padding_len(header_json.len());
    let mut out = Vec::new();
    out.extend_from_slice(&4u32.to_le_bytes());
    out.extend_from_slice(&((header_json.len() + 8 + padding) as u32).to_le_bytes());
    out.extend_from_slice(&((header_json.len() + 4 + padding) as u32).to_le_bytes());
    out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    out.extend_from_slice(header_json.as_bytes());
    out.extend(std::iter::repeat(0u8).take(padding));
    out.extend_from_slice(preload_code.as_bytes());
    out
}

#[test]
fn hub_marker_and_payload_stay_in_sync() {
    // 状态判据、去重锚点、备份判定引用 payload 模块的同一常量；
    // payload 改了标记而判据没跟上，必须在这里红（历史事故：三处字面量失配）。
    let payload = crate::commands::antigravity_loc_payload::HUB_PAYLOAD_JS;
    assert!(payload.contains(&format!(
        "window.{} = true",
        crate::commands::antigravity_loc_payload::HUB_PATCH_FLAG
    )));
}

#[test]
fn hub_dict_override_gate() {
    // 覆盖块形态门：合法 JSON 赋值放行，缺分号/截断/形态不对一律拒绝
    assert!(is_safe_dict_override(
        "window.__ANYBRIDGE_HANS_DICT = {\"A\":\"甲\"};"
    ));
    assert!(!is_safe_dict_override(
        "window.__ANYBRIDGE_HANS_DICT = {\"A\":\"甲\"}"
    ));
    assert!(!is_safe_dict_override(
        "window.__ANYBRIDGE_HANS_DICT = {\"A\":\"甲\""
    ));
    assert!(!is_safe_dict_override("const dictionary = {};"));
    assert!(!is_safe_dict_override(""));
}

#[test]
fn hub_patch_idempotent_backup_and_roundtrip() {
    let dir = std::env::temp_dir().join("anybridge-test-hub-asar");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let asar = dir.join("app.asar");

    // 1. 首次汉化：状态判定为已汉化；重复 apply 幂等（文件不再增长）
    fs::write(&asar, fake_asar("console.log('official v1');")).unwrap();
    patch_hub_asar(&asar).expect("首次 apply 应成功");
    assert!(is_hub_localized(&asar), "打完补丁状态必须是已汉化");
    let len_after_first = fs::metadata(&asar).unwrap().len();
    patch_hub_asar(&asar).expect("重复 apply 应成功");
    assert_eq!(
        fs::metadata(&asar).unwrap().len(),
        len_after_first,
        "幂等：内容一致不得重写（旧实现锚点失配导致每次追加、asar 持续膨胀）"
    );

    // 2. 模拟官方升级：asar 变回新版原厂 → apply 必须把备份刷新为新版
    let upgraded = fake_asar("console.log('official v2');");
    fs::write(&asar, &upgraded).unwrap();
    patch_hub_asar(&asar).expect("升级后 apply 应成功");
    let bak = dir.join("app.asar.lang.bak");
    assert_eq!(
        fs::read(&bak).unwrap(),
        upgraded,
        "备份必须刷新为升级后的原厂内容（旧实现永不刷新，还原会把新版覆盖成旧版）"
    );

    // 3. round-trip：还原后 asar 逐字节等于升级后的原厂版
    restore_hub_asar(&asar).expect("还原应成功");
    assert_eq!(fs::read(&asar).unwrap(), upgraded, "还原必须精确回到原厂字节");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn hub_patch_without_backup_fails_loud() {
    let dir = std::env::temp_dir().join("anybridge-test-hub-asar-nobak");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let asar = dir.join("app.asar");
    fs::write(&asar, fake_asar("console.log('v');")).unwrap();
    patch_hub_asar(&asar).unwrap();
    fs::remove_file(asar.with_file_name("app.asar.lang.bak")).unwrap();
    let err = patch_hub_asar(&asar).unwrap_err();
    assert!(
        err.contains("备份"),
        "已汉化但缺备份必须报错而不是静默继续（旧实现 let _ = 吞掉备份失败）: {err}"
    );
    let _ = fs::remove_dir_all(&dir);
}
