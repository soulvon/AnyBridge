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

#[test]
fn restore_hub_asar_strips_in_place_preserving_third_party_preload_and_utils() {
    let dir = std::env::temp_dir().join("anybridge-test-hub-asar-coexist");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let asar = dir.join("app.asar");

    // 构造含多个 dist 文件的最小合法 asar：模拟先汉化，后安装 context-viewer，再点还原英文
    let preload_official = "console.log('preload base');";
    let utils_code = "// --- Antigravity Context Meter utils Injection Start ---\ninstallContextMeter(win);\n// --- Antigravity Context Meter utils Injection End ---";
    let manifest_json = r#"{"meterVersion":"0.8.10"}"#;
    let mut payload = Vec::new();
    let preload_off = payload.len();
    payload.extend_from_slice(preload_official.as_bytes());
    let utils_off = payload.len();
    payload.extend_from_slice(utils_code.as_bytes());
    let manifest_off = payload.len();
    payload.extend_from_slice(manifest_json.as_bytes());

    let header = serde_json::json!({
        "files": { "dist": { "files": {
            "preload.js": {
                "size": preload_official.len(),
                "offset": preload_off.to_string(),
                "integrity": { "algorithm": "SHA256", "hash": "p", "blockSize": 4194304, "blocks": ["p"] }
            },
            "utils.js": {
                "size": utils_code.len(),
                "offset": utils_off.to_string(),
                "integrity": { "algorithm": "SHA256", "hash": "u", "blockSize": 4194304, "blocks": ["u"] }
            },
            "meter-manifest.json": {
                "size": manifest_json.len(),
                "offset": manifest_off.to_string(),
                "integrity": { "algorithm": "SHA256", "hash": "m", "blockSize": 4194304, "blocks": ["m"] }
            }
        }}}
    });
    let header_json = serde_json::to_string(&header).unwrap();
    let padding = asar_padding_len(header_json.len());
    let mut initial_asar = Vec::new();
    initial_asar.extend_from_slice(&4u32.to_le_bytes());
    initial_asar.extend_from_slice(&((header_json.len() + 8 + padding) as u32).to_le_bytes());
    initial_asar.extend_from_slice(&((header_json.len() + 4 + padding) as u32).to_le_bytes());
    initial_asar.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    initial_asar.extend_from_slice(header_json.as_bytes());
    initial_asar.extend(std::iter::repeat(0u8).take(padding));
    initial_asar.extend_from_slice(&payload);
    fs::write(&asar, &initial_asar).unwrap();

    // 1. 先应用汉化（生成旧备份 app.asar.lang.bak）
    patch_hub_asar(&asar).expect("apply 汉化应成功");
    assert!(is_hub_localized(&asar));

    // 2. 模拟用户随后安装第三方补丁并追加代码到 preload.js 尾部（此时 lang.bak 是安装前的旧快照）
    let mut f = fs::File::open(&asar).unwrap();
    let (_, ps, hdr) = read_asar_header(&mut f).unwrap();
    let cur_preload = read_asar_node_text(&mut f, &hdr, ps, &["dist", "preload.js"]).unwrap();
    drop(f);
    let preload_with_third_party = format!(
        "{cur_preload}\n// --- Antigravity Context Meter preload Injection Start ---\nwindow.contextMeterAPI = {{}};\n// --- Antigravity Context Meter preload Injection End ---\n"
    );
    write_asar_preload(&asar, &preload_with_third_party).unwrap();
    // 把备份刻意篡改为不含第三方特征，验证还原不会走整包覆盖破坏第三方
    fs::write(dir.join("app.asar.lang.bak"), fake_asar("corrupt-overwrite")).unwrap();

    // 3. 还原英文：必须走原位剥离，保留第三方 preload 与 utils/meter-manifest
    restore_hub_asar(&asar).expect("原位还原应成功");
    assert!(!is_hub_localized(&asar), "AnyBridge 汉化标记必须被剥离");

    let mut f2 = fs::File::open(&asar).unwrap();
    let (_, ps2, hdr2) = read_asar_header(&mut f2).unwrap();
    let after_preload = read_asar_node_text(&mut f2, &hdr2, ps2, &["dist", "preload.js"]).unwrap();
    let after_utils = read_asar_node_text(&mut f2, &hdr2, ps2, &["dist", "utils.js"]).unwrap();
    assert!(after_preload.contains("preload base"), "原厂代码必须保留");
    assert!(after_preload.contains("window.contextMeterAPI"), "第三方 preload 补丁必须保留");
    assert!(after_utils.contains("installContextMeter"), "第三方 utils.js 必须保留");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn patch_hub_asar_preserves_clean_backup_when_upgrading_legacy_localization() {
    let dir = std::env::temp_dir().join(format!(
        "anybridge-test-hub-legacy-bak-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let asar = dir.join("app.asar");
    let bak = dir.join("app.asar.lang.bak");

    // 1. 老代补丁（含 __antigravityHansInjected 但无当前代 HUB_PATCH_FLAG）升级时，不得覆盖干净备份
    let legacy = fake_asar(
        "console.log('base');\n// Antigravity Chinese Localization Engine\nwindow.__antigravityHansInjected = true;",
    );
    fs::write(&asar, &legacy).unwrap();
    let sentinel = b"clean-factory-backup-sentinel";
    fs::write(&bak, sentinel).unwrap();

    patch_hub_asar(&asar).expect("有干净备份的老代补丁升级应成功");
    assert_eq!(
        fs::read(&bak).unwrap(),
        sentinel,
        "老代汉化升级不得把已补丁 app.asar 写回 app.asar.lang.bak"
    );
    assert!(is_hub_localized(&asar));

    // 2. 若仅带第二代旧标记且丢失了备份，必须报错拒绝，不得用已汉化产物当备份源
    let gen2 = fake_asar(
        "console.log('base');\n// Antigravity 2.0 Chinese Localization Engine\nconsole.log('gen2');",
    );
    fs::write(&asar, &gen2).unwrap();
    fs::remove_file(&bak).unwrap();
    let err = patch_hub_asar(&asar).unwrap_err();
    assert!(
        err.contains("备份"),
        "缺备份的旧代汉化升级必须报错拒绝，实际: {err}"
    );
    assert!(!bak.exists(), "不得把旧代已汉化 asar 写进 app.asar.lang.bak");

    let _ = fs::remove_dir_all(&dir);
}
