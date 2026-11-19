use super::*;


    #[test]
    fn antigravity_restore_clears_inherited_endpoint() {
        // v1.1.0 事故：用户停止接入后只撤了黑底 settings 的键，白底仍指向
        // 本地网关；IDE 主进程继承的 CLOUD_CODE_URL 又没被清掉，agy.exe
        // 一直打死端点 → userInfo/loadCodeAssist 全失败 → 面板回退
        // 「Continue with Google」→ 切号插件失效。
        let ide = antigravity_ide_extension_injection();
        let hub = antigravity_hub_endpoint_injection();
        assert!(
            ide.contains("delete e.CLOUD_CODE_URL"),
            "黑底注入块必须先清除父进程继承的脏值，否则还原不生效"
        );
        assert!(
            !hub.contains("process.env.CLOUD_CODE_URL"),
            "白底 fallback 不得把继承的脏环境变量当端点"
        );
        assert!(
            hub.contains("https://daily-cloudcode-pa.googleapis.com"),
            "白底找不到配置时必须回退官方端点"
        );
        // 两端候选必须隔离：黑底绝不能读到白底残留的 URL。
        assert!(
            ide.contains("\"Antigravity IDE\"") && !ide.contains("\"Antigravity\","),
            "黑底注入块只应扫描 IDE 系列目录名"
        );
        assert!(
            hub.contains("\"Antigravity\"") && !hub.contains("\"Antigravity IDE\""),
            "白底注入块只应扫描 Hub 系列目录名"
        );

        // 真执行：模拟 settings 无托管键、env 带接入时残留的本地网关地址。
        let tmp = std::env::temp_dir().join(format!(
            "anybridge-ag-restore-{}-{}.js",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let tmp_home = std::env::temp_dir().join(format!(
            "anybridge-ag-restore-home-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&tmp_home).unwrap();
        let script = format!(
            "const fs=require('fs'),os=require('os'),path=require('path');\
             const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ag-restore-'));\
             fs.writeFileSync(path.join(dir,'settings.json'),'{{}}');\
             process.env.APPDATA=dir;process.env.LOCALAPPDATA=dir;\
             process.env.USERPROFILE=dir;process.env.HOME=dir;\
             process.env.XDG_CONFIG_HOME=dir;process.env.XDG_DATA_HOME=dir;\
             delete process.env.ANYBRIDGE_ANTIGRAVITY_SETTINGS;\
             const e={{CLOUD_CODE_URL:'https://localhost:7452'}};\
             const out=({ide})(e);\
             console.log(JSON.stringify({{left:out.CLOUD_CODE_URL||null,hub:{hub}}}));\
             fs.rmSync(dir,{{recursive:true,force:true}});"
        );
        let mut last_fail: Option<String> = None;
        for _attempt in 0..3 {
            if let Err(e) = fs::write(&tmp, &script) {
                last_fail = Some(format!("测试脚本落盘失败（临时文件 {}）: {e}", tmp.display()));
                continue;
            }
            match isolated_node_cmd(&tmp_home)
                .arg(&tmp)
                .output()
            {
                Err(e) => last_fail = Some(format!("node 无法启动: {e}")),
                Ok(out) if !out.status.success() => {
                    last_fail = Some(format!(
                        "还原注入块执行异常: {}",
                        String::from_utf8_lossy(&out.stderr)
                    ));
                }
                Ok(out) => {
                    let text = String::from_utf8_lossy(&out.stdout).to_string();
                    if !text.contains("\"left\":null") {
                        last_fail = Some(format!("还原后 CLOUD_CODE_URL 必须被清除，实际: {text}"));
                    } else if text.contains("7452") {
                        last_fail = Some(format!("两端都不得再返回本地死端点，实际: {text}"));
                    } else {
                        last_fail = None;
                        break;
                    }
                }
            }
        }
        if let Some(msg) = last_fail {
            panic!("还原对称执行级校验失败（重试 3 次）: {msg}");
        }
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_dir_all(&tmp_home);
    }


    #[test]
    fn antigravity_injection_actually_works_at_runtime() {
        // v1.1.5 事故：`names={names}` 未被替换，运行时就抛错并被 catch 吞掉，
        // 注入静默失效（LS 直连官方、BYOK 模型不下发），而 node --check 语法
        // 校验因 `{names}` 是合法 shorthand 属性而放行。
        //
        // 因此必须**真执行**：造一个含端点的 settings.json，调用注入块，
        // 断言 CLOUD_CODE_URL 被正确设置。
        let ide = antigravity_ide_extension_injection();
        let hub = antigravity_hub_endpoint_injection();
        for (label, js) in [("ide", &ide), ("hub", &hub)] {
            assert!(!js.contains("__AB_"), "{label} 不得残留未替换的占位符");
            assert!(!js.contains("{names}"), "{label} 不得残留未替换的 names 占位符");
            assert!(
                js.contains("[\"Antigravity") || js.contains("[\"Antigravity IDE\""),
                "{label} 必须展开成真实数组字面量"
            );
        }

        // 注入块与测试脚本分文件存放，避免 Rust format! 与 JS 花括号互相干扰
        // （正是这类转义事故导致了 v1.1.5 的 {names} 静默失效）。
        let stamp = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );
        let dir = std::env::temp_dir();
        let ide_file = dir.join(format!("anybridge-inj-ide-{stamp}.cjs"));
        let hub_file = dir.join(format!("anybridge-inj-hub-{stamp}.cjs"));
        let script_file = dir.join(format!("anybridge-inj-run-{stamp}.cjs"));

        // 纯静态脚本：从两个文件读注入块源码，eval 后执行，避免任何转义。
        let script = r#"
const fs = require('fs'), os = require('os'), path = require('path');
const ideSrc = fs.readFileSync(process.argv[2], 'utf8');
const hubSrc = fs.readFileSync(process.argv[3], 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-inj-'));
function mk(name, url) {
  const d = path.join(root, name, 'User');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ 'jetski.cloudCodeUrl': url }));
}
mk('Antigravity IDE', 'https://localhost:7452');
mk('Antigravity', 'https://localhost:9999');
process.env.APPDATA = root;
process.env.LOCALAPPDATA = root;
process.env.USERPROFILE = root;
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = root;
process.env.XDG_DATA_HOME = root;
delete process.env.ANYBRIDGE_ANTIGRAVITY_SETTINGS;
const ide = eval(ideSrc)({});
const hub = eval(hubSrc);
console.log(JSON.stringify({ ide: ide.CLOUD_CODE_URL || null, hub: hub }));
fs.rmSync(root, { recursive: true, force: true });
"#;

        let wrote = fs::write(&ide_file, &ide).is_ok()
            && fs::write(&hub_file, &hub).is_ok()
            && fs::write(&script_file, script).is_ok();
        assert!(wrote, "测试脚本必须能落盘");

        // 全量并发 + 打包高负载场景下偶发（spawn/IO 抖动），失败重试两次。
        // 关键：node 起不来绝不能静默通过——静默通过等于把执行级校验降级成摆设。
        let mut last_fail: Option<String> = None;
        for _attempt in 0..3 {
            // 显式隔离 NODE_OPTIONS 与 USERPROFILE/HOME：防止宿主 shim 或真实 ~/AppData 污染
            match isolated_node_cmd(&dir)
                .arg(&script_file)
                .arg(&ide_file)
                .arg(&hub_file)
                .output()
            {
                Err(e) => {
                    last_fail = Some(format!("node 无法启动: {e}"));
                    continue;
                }
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                    if !out.status.success() {
                        last_fail = Some(format!("注入块执行异常:\n{stderr}\n{stdout}"));
                        continue;
                    }
                    if !stdout.contains(r#""ide":"https://localhost:7452""#)
                        || !stdout.contains(r#""hub":"https://localhost:9999""#)
                    {
                        last_fail = Some(format!(
                            "注入块没读到端点（按端隔离失效？）stdout={stdout}"
                        ));
                        continue;
                    }
                    last_fail = None;
                    break;
                }
            }
        }
        if let Some(msg) = last_fail {
            panic!("执行级注入校验失败（重试 3 次）: {msg}");
        }
        for f in [&ide_file, &hub_file, &script_file] {
            let _ = fs::remove_file(f);
        }
    }


    #[test]
    fn antigravity_injection_reads_jsonc_settings_default_path() {
        // 2026-11-14 真机事故回归锁：settings.json 是 JSONC（注释 + 尾逗号
        // 合法），真机 argv 里 --user-data-dir 带引号。此前所有运行时测试
        // 都走 ANYBRIDGE_ANTIGRAVITY_SETTINGS 覆盖 + 严格 JSON fixture，
        // 默认候选路径从未在真实文件形状上验证——测试全绿、真机 LS 仍直连
        // 官方。本测试逼两条默认路径在真机形状下自证，杜绝回归。
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("ab-jsonc-{}-{nanos}", std::process::id()));
        // 腿 A：APPDATA 默认候选 → JSONC 文件（注释 + 尾逗号）→ 7452
        let appdata = root.join("appdata").join("Antigravity").join("User");
        fs::create_dir_all(&appdata).unwrap();
        fs::write(
            appdata.join("settings.json"),
            "// client-managed settings\n{\n  \"jetski.cloudCodeUrl\": \"https://localhost:7452\",\n}\n",
        )
        .unwrap();
        // 腿 B：带引号的 --user-data-dir argv 候选 → 另一份 JSONC → 9527（优先级更高）
        let udd = root.join("udd");
        let udd_user = udd.join("User");
        fs::create_dir_all(&udd_user).unwrap();
        fs::write(
            udd_user.join("settings.json"),
            "{\n  \"jetski.cloudCodeUrl\": \"https://localhost:9527\",\n}\n",
        )
        .unwrap();

        let hub = antigravity_hub_endpoint_injection();
        assert!(
            !hub.contains("__AB_"),
            "注入不得残留未替换占位符（__AB_READ__ 必须被渲染）"
        );
        let hub_file = root.join("hub.cjs");
        let script = root.join("run.cjs");
        fs::write(&hub_file, &hub).unwrap();
        fs::write(
            &script,
            r#"
const fs = require('fs');
const hubSrc = fs.readFileSync(process.argv[2], 'utf8');
const appdata = process.argv[3];
const udd = process.argv[4];
const mode = process.argv[5];
if (mode === 'argv') {
  // 真机形状：引号包在 argv 元素内部（Electron 主进程 argv 实测如此）
  process.argv.push('--user-data-dir="' + udd + '"');
}
process.env.APPDATA = appdata;
process.env.LOCALAPPDATA = appdata;
process.env.USERPROFILE = appdata;
process.env.HOME = appdata;
process.env.XDG_CONFIG_HOME = appdata;
process.env.XDG_DATA_HOME = appdata;
delete process.env.ANYBRIDGE_ANTIGRAVITY_SETTINGS;
console.log(JSON.stringify({ hub: eval(hubSrc) }));
"#,
        )
        .unwrap();

        let run = |mode: &str| -> String {
            let mut last_fail: Option<String> = None;
            for _attempt in 0..3 {
                match isolated_node_cmd(&root.join("appdata"))
                    .arg(&script)
                    .arg(&hub_file)
                    .arg(root.join("appdata"))
                    .arg(&udd)
                    .arg(mode)
                    .output()
                {
                    Err(e) => last_fail = Some(format!("node 无法启动: {e}")),
                    Ok(out) if !out.status.success() => {
                        last_fail = Some(format!(
                            "执行异常: {}",
                            String::from_utf8_lossy(&out.stderr)
                        ));
                    }
                    Ok(out) => {
                        return String::from_utf8_lossy(&out.stdout).to_string();
                    }
                }
            }
            panic!("JSONC 候选路径校验失败（重试 3 次）: {}", last_fail.unwrap());
        };

        let leg_a = run("default");
        assert!(
            leg_a.contains(r#""hub":"https://localhost:7452""#),
            "默认候选路径必须读出 JSONC settings 里的 7452，实际: {leg_a}"
        );
        let leg_b = run("argv");
        assert!(
            leg_b.contains(r#""hub":"https://localhost:9527""#),
            "带引号的 --user-data-dir argv 候选必须剥离引号并优先命中 9527，实际: {leg_b}"
        );
        let _ = fs::remove_dir_all(&root);
    }


    #[test]
    fn antigravity_settings_write_preserves_kite_keys_and_format() {
        // 与 Antigravity Kite 共存：它用 VS Code 配置 API 并发写
        // antigravityKite.*。AnyBridge 必须只动自己那一行，否则整体
        // JSON 重写会静默丢掉 Kite 刚写的设置（lost update）。
        let kite = r#"{
  // Kite 的用户设置（注释必须保留）
  "antigravityKite.cdpPort": 9333,
  "antigravityKite.autoConfirmDeclaration": true,
  "antigravityKite.statusBar.style": "full",
  "antigravityKite.switch.syncGeminiFiles": true,
  "jetski.cloudCodeUrl": "https://old.example.com",
  "antigravityKite.locale": "zh-CN"
}
"#;

        // 接入：只替换 URL，其它行逐字节不动
        let applied = upsert_settings_endpoint_text(kite, Some("https://localhost:7452")).unwrap();
        for key in [
            "antigravityKite.cdpPort",
            "antigravityKite.autoConfirmDeclaration",
            "antigravityKite.statusBar.style",
            "antigravityKite.switch.syncGeminiFiles",
            "antigravityKite.locale",
            "// Kite 的用户设置（注释必须保留）",
        ] {
            assert!(applied.contains(key), "接入后 Kite 的 {key} 必须保留");
        }
        assert!(applied.contains("https://localhost:7452"));
        assert!(!applied.contains("https://old.example.com"));
        assert_eq!(applied.matches("\"jetski.cloudCodeUrl\"").count(), 1);

        // 还原：删掉自己那一行，Kite 的键与注释仍完整
        let restored = upsert_settings_endpoint_text(&applied, None).unwrap();
        for key in [
            "antigravityKite.cdpPort",
            "antigravityKite.autoConfirmDeclaration",
            "antigravityKite.statusBar.style",
            "antigravityKite.switch.syncGeminiFiles",
            "antigravityKite.locale",
            "// Kite 的用户设置（注释必须保留）",
        ] {
            assert!(restored.contains(key), "还原后 Kite 的 {key} 必须保留");
        }
        assert!(!restored.contains("jetski.cloudCodeUrl"));
        assert!(crate::commands::ide_config::parse_object(&restored).is_ok(), "还原后仍是合法 JSONC");

        // 键不存在时插入，同样不破坏其它键与注释
        let without = upsert_settings_endpoint_text(kite, None).unwrap();
        let inserted = upsert_settings_endpoint_text(&without, Some("https://localhost:7452")).unwrap();
        assert!(inserted.contains("antigravityKite.cdpPort"));
        assert!(inserted.contains("// Kite 的用户设置"));
        assert!(crate::commands::ide_config::parse_object(&inserted).is_ok(), "插入后仍是合法 JSONC");
        assert_eq!(
            upsert_settings_endpoint_text(&inserted, Some("https://localhost:7452")).unwrap(),
            inserted,
            "重复接入必须幂等"
        );

        // CRLF 文件不能被改成 LF
        let crlf = kite.replace('\n', "\r\n");
        let crlf_out = upsert_settings_endpoint_text(&crlf, Some("https://localhost:7452")).unwrap();
        assert!(!crlf_out.contains("\n\n") && crlf_out.contains("\r\n"));

        // 空对象 / 只有注释的极简文件（白底 Hub 首次接入时的常见形态）：
        // 插入后必须是合法 JSONC，且能被 parse_object 读回。
        for bare in ["{}", "{}\n", "{\n}\n", "{\n  // 还没有任何设置\n}\n"] {
            let out = upsert_settings_endpoint_text(bare, Some("https://localhost:7452"))
                .unwrap_or_else(|e| panic!("{bare:?} 插入失败: {e}"));
            assert!(
                crate::commands::ide_config::parse_object(&out).is_ok(),
                "{bare:?} 插入后必须是合法 JSONC，实际: {out:?}"
            );
            let parsed = crate::commands::ide_config::parse_object(&out).unwrap();
            assert_eq!(
                parsed.get("jetski.cloudCodeUrl").and_then(|v| v.as_str()),
                Some("https://localhost:7452"),
                "{bare:?} 插入后应能读回端点"
            );
            // 还原后必须回到不含该键且仍合法的状态
            let restored = upsert_settings_endpoint_text(&out, None).unwrap();
            assert!(crate::commands::ide_config::parse_object(&restored).is_ok(), "{bare:?} 还原后应仍合法");
            let rp = crate::commands::ide_config::parse_object(&restored).unwrap();
            assert!(rp.get("jetski.cloudCodeUrl").is_none());
        }
    }


    #[test]
    fn antigravity_cdp_port_follows_kite_config() {
        // Kite 可把 cdpPort 改成非 9333；AnyBridge 必须把「Kite 配置值」
        // 与 9222/DevToolsActivePort 一起纳入候选，不能写死单端口。
        let cands = crate::commands::antigravity_cdp::cdp_port_candidates_for_test(Some(9444), Some(9555));
        assert!(cands.contains(&9444), "必须跟随 Kite 配置的端口");
        assert!(cands.contains(&9555), "必须跟随 DevToolsActivePort");
        assert!(cands.contains(&9333), "需保留默认 9333");
        assert!(cands.contains(&9222), "需保留 Kite 的 9222 兜底");
        assert_eq!(
            cands.iter().copied().collect::<std::collections::HashSet<_>>().len(),
            cands.len(),
            "候选端口必须去重"
        );
    }


    #[test]
    fn antigravity_legacy_injection_strips_in_place_without_backup() {
        // 真机场景：客户端升级后 js.anybridge-bak 已不存在，但 extension.js
        // 里还留着上一版（v2，含 {names} 坏代码）的注入。必须能就地剥离再重打。
        let original = "function fd(a){var c={...process.env};return c}\r\n$c.buildServerEnvironment=fd;";
        let v2_bad = r#"function fd(a){var c={...process.env};return ((function(e){try{const fs=require("fs"),names={names};for(const n of names){}}catch(_){}return e}/*ANYBRIDGE_CLOUD_CODE_URL_V2*//*ANYBRIDGE_CLOUD_CODE_URL*/))(c)}
$c.buildServerEnvironment=fd;"#;
        let stripped = strip_antigravity_extension_injection(v2_bad).expect("必须能剥离 v2 注入");
        assert!(stripped.contains("return c}"), "剥离后应还原成原始 return c}}");
        assert!(!stripped.contains("ANYBRIDGE"), "剥离后不得残留 marker");
        assert_valid_js("stripped", &stripped);

        // 剥离后重打，必须产出当前版本
        let repatched = patch_antigravity_extension_code(&stripped).expect("剥离后应能重打");
        assert!(repatched.contains(ANTIGRAVITY_IDE_EXTENSION_VERSION));
        assert!(!repatched.contains("{names}"), "重打后不得再有坏占位符");
        assert_valid_js("repatched", &repatched);

        // 与直接对原文重打的结果语义一致（剥离只影响注入，不动其它字节）
        let direct = patch_antigravity_extension_code(original).unwrap();
        let norm = |s: &str| s.replace("\r\n", "\n");
        assert_eq!(
            norm(&repatched),
            norm(&direct),
            "剥离后重打应与直接重打结果一致（忽略换行风格）"
        );
    }


    #[test]
    fn antigravity_legacy_injection_is_upgraded_not_skipped() {
        // 幂等判据若只认旧 marker，已接入用户升级后旧注入永远得不到修复。
        let ide = antigravity_ide_extension_injection();
        let hub = antigravity_hub_endpoint_injection();
        assert!(ide.contains(ANTIGRAVITY_IDE_EXTENSION_VERSION), "黑底注入块必须带 v2 标记");
        assert!(hub.contains(ANTIGRAVITY_HUB_ENDPOINT_VERSION), "白底注入块必须带 v2 标记");
        assert!(
            !ide.contains("process.env.CLOUD_CODE_URL") && !hub.contains("process.env.CLOUD_CODE_URL"),
            "新版注入不得再读脏环境变量"
        );
        // 旧版 languageServer.js（含旧 marker 但缺 v2）必须被重新变换，而不是直接返回。
        let legacy = format!(
            "const args=['--cloud_code_endpoint',\n  (() => {{ return 'x'; }})(){},\n'--x'];",
            ANTIGRAVITY_HUB_ENDPOINT_MARKER
        );
        let upgraded = patch_hub_language_server_code(&legacy).unwrap();
        assert!(
            upgraded.contains(ANTIGRAVITY_HUB_ENDPOINT_VERSION),
            "旧注入必须升级成 v2"
        );
        assert_valid_js("legacy_upgrade", &upgraded);
        assert_eq!(
            patch_hub_language_server_code(&upgraded).unwrap(),
            upgraded,
            "升级后幂等"
        );
    }


    #[test]
    fn antigravity_endpoint_keeper_only_restores_managed_clients() {
        // 真机事故：白底客户端启动自更新覆盖 app.asar，端点补丁丢失后
        // 界面仍显示「已接入」，LS 却直连官方。判据必须只认本地网关地址，
        // 且用户已停止接入（官方端点/无配置）时绝不擅自改安装目录。
        assert!(is_anybridge_managed_endpoint(Some("https://localhost:7452")));
        assert!(is_anybridge_managed_endpoint(Some("https://127.0.0.1:7452")));
        assert!(!is_anybridge_managed_endpoint(Some(
            "https://daily-cloudcode-pa.googleapis.com"
        )));
        assert!(!is_anybridge_managed_endpoint(None));
    }


    /// Antigravity：用户自己设过 cloudCodeUrl → 切回时写回原值。
    #[test]
    fn antigravity_official_writes_back_user_url() {
        with_field_restore(true, || {
            let (path, stash) = named_tmp_config("antigravity-fr", "settings.json");
            fs::write(&path, r#"{"jetski.cloudCodeUrl": "https://corp.proxy"}"#).unwrap();

            // 预置账本（临时目录，隔离）：original=corp，applied=本地网关
            let plans = vec![crate::commands::agent_stash::FieldPlan {
                path: vec!["jetski.cloudCodeUrl".into()],
                current: crate::commands::agent_stash::Stashed::Str("https://corp.proxy".into()),
                new: crate::commands::agent_stash::Stashed::Str(
                    "https://localhost:8443".into(),
                ),
            }];
            crate::commands::agent_stash::record_apply(
                &stash,
                &antigravity_stash_key(),
                &plans,
            )
            .unwrap();
            fs::write(&path, r#"{"jetski.cloudCodeUrl": "https://localhost:8443"}"#).unwrap();

            Platform::Antigravity
                .apply_antigravity_official_with_stash(&path, &stash)
                .unwrap();

            let val: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(
                val["jetski.cloudCodeUrl"].as_str(),
                Some("https://corp.proxy"),
                "用户原 URL 必须写回"
            );
            let _ = fs::remove_dir_all(path.parent().unwrap());
        });
    }


    /// Antigravity：跨端清理只清除 AnyBridge 本地托管端点，不动用户自建 URL 与扩展其它设置，且测试下不触发宿主机真实目录/进程。
    #[test]
    fn antigravity_clear_stale_managed_endpoints_only_touches_managed_dirs() {
        let dir = temp_managed_dir("ag-clear-stale-isolated");
        let hub_dir = dir.join("hub");
        let ide_dir = dir.join("ide");
        let custom_dir = dir.join("custom");
        fs::create_dir_all(&hub_dir).unwrap();
        fs::create_dir_all(&ide_dir).unwrap();
        fs::create_dir_all(&custom_dir).unwrap();

        let ports = crate::commands::config::configured_proxy_ports();
        let managed_url = format!("https://localhost:{}", ports.antigravity_https_port);

        // hub: 由 AnyBridge 接管 → 应仅移除 jetski.cloudCodeUrl，保留 Kite 等扩展配置
        let hub_settings = hub_dir.join("settings.json");
        fs::write(
            &hub_settings,
            format!(
                "{{\n  \"jetski.cloudCodeUrl\": \"{managed_url}\",\n  \"antigravityKite.refreshInterval\": 60\n}}\n"
            ),
        )
        .unwrap();

        // ide: 用户自己的企业代理 → 不得误删
        let ide_settings = ide_dir.join("settings.json");
        fs::write(
            &ide_settings,
            "{\n  \"jetski.cloudCodeUrl\": \"https://corp.proxy.example\",\n  \"editor.fontSize\": 14\n}\n",
        )
        .unwrap();

        // custom: 另一端托管遗留
        let custom_settings = custom_dir.join("settings.json");
        fs::write(
            &custom_settings,
            format!("{{\n  \"jetski.cloudCodeUrl\": \"{managed_url}\"\n}}\n"),
        )
        .unwrap();

        clear_antigravity_stale_managed_endpoints_in_dirs(&[
            hub_dir.clone(),
            ide_dir.clone(),
            custom_dir.clone(),
        ]);

        let hub_val =
            crate::commands::ide_config::parse_object(&fs::read_to_string(&hub_settings).unwrap())
                .unwrap();
        assert!(hub_val.get("jetski.cloudCodeUrl").is_none(), "本地托管端点必须移除");
        assert_eq!(hub_val["antigravityKite.refreshInterval"], 60, "Kite 键必须保留");

        let ide_val =
            crate::commands::ide_config::parse_object(&fs::read_to_string(&ide_settings).unwrap())
                .unwrap();
        assert_eq!(
            ide_val["jetski.cloudCodeUrl"].as_str(),
            Some("https://corp.proxy.example"),
            "用户自定义代理端点不得误删"
        );
        assert_eq!(ide_val["editor.fontSize"], 14);

        let custom_val = crate::commands::ide_config::parse_object(
            &fs::read_to_string(&custom_settings).unwrap(),
        )
        .unwrap();
        assert!(custom_val.get("jetski.cloudCodeUrl").is_none());

        // 测试态下调用 apply_antigravity*_with_stash 也必须完全隔离，只操作传入的 path/stash
        let isolated_stash = dir.join("stash");
        let isolated_settings = dir.join("isolated-hub").join("settings.json");
        let isolated_ide_settings = dir.join("isolated-ide").join("settings.json");
        fs::create_dir_all(isolated_settings.parent().unwrap()).unwrap();
        fs::create_dir_all(isolated_ide_settings.parent().unwrap()).unwrap();

        Platform::Antigravity
            .apply_antigravity_with_stash(&isolated_settings, &isolated_stash)
            .unwrap();
        Platform::AntigravityIde
            .apply_antigravity_ide_with_stash(&isolated_ide_settings, &isolated_stash)
            .unwrap();

        let hub_applied = crate::commands::ide_config::parse_object(
            &fs::read_to_string(&isolated_settings).unwrap(),
        )
        .unwrap();
        let ide_applied = crate::commands::ide_config::parse_object(
            &fs::read_to_string(&isolated_ide_settings).unwrap(),
        )
        .unwrap();
        assert_eq!(hub_applied["jetski.cloudCodeUrl"].as_str(), Some(managed_url.as_str()));
        assert_eq!(ide_applied["jetski.cloudCodeUrl"].as_str(), Some(managed_url.as_str()));

        Platform::Antigravity
            .apply_antigravity_official_with_stash(&isolated_settings, &isolated_stash)
            .unwrap();
        Platform::AntigravityIde
            .apply_antigravity_ide_official_with_stash(&isolated_ide_settings, &isolated_stash)
            .unwrap();

        let hub_restored = crate::commands::ide_config::parse_object(
            &fs::read_to_string(&isolated_settings).unwrap(),
        )
        .unwrap();
        let ide_restored = crate::commands::ide_config::parse_object(
            &fs::read_to_string(&isolated_ide_settings).unwrap(),
        )
        .unwrap();
        assert!(hub_restored.get("jetski.cloudCodeUrl").is_none());
        assert!(ide_restored.get("jetski.cloudCodeUrl").is_none());
        let _ = fs::remove_dir_all(&dir);
    }
