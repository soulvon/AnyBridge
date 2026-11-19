use super::*;


    #[test]
    fn antigravity_extension_patch_binds_runtime_env_var() {
        let minified =
            "function fd(a){var c={...process.env};return c}\r\n$c.buildServerEnvironment=fd;";
        let once = patch_antigravity_extension_code(minified).unwrap();
        assert!(
            once.contains("/*ANYBRIDGE_CLOUD_CODE_URL*/"),
            "必须带幂等 marker"
        );
        assert!(
            once.contains("e.CLOUD_CODE_URL="),
            "注入块必须把端点写进 agy 启动环境"
        );
        assert!(
            once.contains(")(c)}"),
            "必须用运行时变量名回填 env 对象（不得硬编码 minify 名）"
        );
        assert!(
            once.contains("$c.buildServerEnvironment=fd;"),
            "锚点赋值必须原样保留"
        );
        // v1.0.20 事故：拼接时误用整个 head（已含 `return <env>}`），
        // 又追加一份 `return (...)`，生成两份 return 与多余花括号，
        // agy.exe 加载扩展失败 → Agent 面板永久卡加载。必须锁死这一点。
        assert!(
            !once.contains("return c}"),
            "补丁后不得残留原来的 return 语句"
        );
        assert_eq!(
            once.matches("return (").count(),
            1,
            "只允许一处 `return (...)`（注入表达式），杜绝双 return"
        );
        let twice = patch_antigravity_extension_code(&once).unwrap();
        assert_eq!(once, twice, "重复接入必须幂等");

        // 真正的语法校验：把补丁结果交给 Node 解析，防止再次输出损坏的 JS。
        assert_valid_js("extension_patch", &once);
    }


    #[test]
    fn antigravity_extension_patch_supports_legacy_return_shapes() {
        // 老版本 buildServerEnv 的 return 与导出形态各不相同，逐一锁死。
        // 关键：任何形态都只能生成一份 return，且结果必须是合法 JS。
        let cases = [
            (
                "current_lf",
                "function fd(a){var c={...process.env};return c}\n$c.buildServerEnvironment=fd;",
                "c",
            ),
            (
                "current_crlf_semicolon",
                "function fd(a){var env={...process.env};return env;}\r\n$c.buildServerEnvironment=fd;",
                "env",
            ),
            (
                "legacy_dollar_var",
                "function fd(a){let $e=Object.assign({},process.env);return $e;}\n$c.buildServerEnvironment=fd;",
                "$e",
            ),
            (
                "legacy_bracket_export",
                "function fd(a){var _env={...process.env};return _env }\n$c[\"buildServerEnvironment\"]=fd;",
                "_env",
            ),
            (
                "legacy_plain_export",
                "function fd(a){var opts={...process.env};return opts;}\nexports.buildServerEnvironment=fd;",
                "opts",
            ),
        ];
        for (label, code, var) in cases {
            let patched = patch_antigravity_extension_code(code)
                .unwrap_or_else(|e| panic!("{label} 注入失败: {e}"));
            assert!(
                patched.contains(ANTIGRAVITY_IDE_EXTENSION_MARKER),
                "{label} 缺 marker"
            );
            assert!(
                patched.contains(&format!(")({var})")),
                "{label} 未绑定正确的 env 变量 {var}"
            );
            assert_eq!(
                patched.matches("return (").count(),
                1,
                "{label} 只允许一处注入 return，杜绝双 return"
            );
            assert!(
                !patched.contains(&format!("return {var}}}")) && !patched.contains(&format!("return {var};")),
                "{label} 残留原 return 语句"
            );
            assert_valid_js(label, &patched);
            assert_eq!(
                patch_antigravity_extension_code(&patched).unwrap(),
                patched,
                "{label} 幂等"
            );
        }
    }


    #[test]
    fn antigravity_hub_patch_supports_legacy_parameter_shapes() {
        let injected = antigravity_hub_endpoint_injection();
        let cases = [
            (
                "current_lf",
                "const args=['--cloud_code_endpoint',\n            'https://daily-cloudcode-pa.googleapis.com',\n'--api_server_url'];",
            ),
            (
                "crlf_double_quote",
                "const args=[\"--cloud_code_endpoint\",\r\n  \"https://cloudcode-pa.googleapis.com\",\r\n\"--api_server_url\"];",
            ),
            (
                "legacy_different_domain",
                "const args=['--cloud_code_endpoint', 'https://old.example.googleapis.com', '--x'];",
            ),
            (
                "legacy_old_injection_selfheal",
                "const args=['--cloud_code_endpoint',\n  (() => { try { return require('electron').app.getPath('userData'); } catch(_) {} return 'https://daily-cloudcode-pa.googleapis.com'; })(),\n'--x'];",
            ),
        ];
        for (label, code) in cases {
            let patched = patch_hub_language_server_code(code)
                .unwrap_or_else(|e| panic!("{label} 白底注入失败: {e}"));
            assert!(patched.contains(ANTIGRAVITY_HUB_ENDPOINT_MARKER), "{label} 缺 marker");
            assert!(patched.contains("jetski.cloudCodeUrl"), "{label} 未读配置");
            assert!(patched.contains("--api_server_url") || patched.contains("--x"), "{label} 破坏了相邻参数");
            assert_eq!(
                patch_hub_language_server_code(&patched).unwrap(),
                patched,
                "{label} 幂等"
            );
            assert_valid_js(label, &patched);
            let _ = &injected;
        }
        assert!(patch_hub_language_server_code("const args=['--x'];").is_err());
    }


    #[test]
    fn antigravity_hub_patch_supports_ls_defaults_shape() {
        // 2.32.1 真机形态：端点常量抽到 dist/lsDefaults.js，
        // baseLsArgs() 只引用 exports.LS_CLOUD_CODE_ENDPOINT。
        let code = concat!(
            "\"use strict\";\n",
            "exports.LS_CLOUD_CODE_ENDPOINT = exports.LS_API_SERVER_URL = void 0;\n",
            "exports.baseLsArgs = baseLsArgs;\n",
            "exports.LS_API_SERVER_URL = 'https://generativelanguage.googleapis.com';\n",
            "exports.LS_CLOUD_CODE_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';\n",
            "function baseLsArgs(opts){return ['--cloud_code_endpoint', exports.LS_CLOUD_CODE_ENDPOINT];}\n",
        );
        let patched = patch_hub_language_server_code(code)
            .unwrap_or_else(|e| panic!("2.32.1 常量形态注入失败: {e}"));
        assert_valid_js("ls_defaults", &patched);
        assert!(patched.contains(ANTIGRAVITY_HUB_ENDPOINT_VERSION), "缺当前版本 marker");
        assert!(patched.contains("jetski.cloudCodeUrl"), "未读配置");
        assert!(
            patched.contains("'--cloud_code_endpoint', exports.LS_CLOUD_CODE_ENDPOINT"),
            "baseLsArgs 参数数组必须原样保留"
        );
        assert_eq!(
            patched.matches("https://daily-cloudcode-pa.googleapis.com").count(),
            1,
            "官方兜底 URL 只剩注入里的那一份"
        );
        assert_eq!(
            patch_hub_language_server_code(&patched).unwrap(),
            patched,
            "常量形态幂等"
        );
    }


    #[test]
    fn antigravity_hub_endpoint_node_prefers_ls_defaults() {
        let both = serde_json::json!({"files":{"dist":{"files":{
            "lsDefaults.js":{"size":1,"offset":"0"},
            "languageServer.js":{"size":1,"offset":"0"}
        }}}});
        assert_eq!(hub_endpoint_node_name(&both), Some("lsDefaults.js"));
        let legacy = serde_json::json!({"files":{"dist":{"files":{
            "languageServer.js":{"size":1,"offset":"0"}
        }}}});
        assert_eq!(hub_endpoint_node_name(&legacy), Some("languageServer.js"));
        let empty = serde_json::json!({"files":{"dist":{"files":{}}}});
        assert_eq!(hub_endpoint_node_name(&empty), None);
    }


    fn build_fake_hub_asar(files: &[(&str, &str)]) -> Vec<u8> {
        let mut entries = serde_json::Map::new();
        let mut payload = Vec::new();
        for (name, content) in files {
            let offset = payload.len();
            payload.extend_from_slice(content.as_bytes());
            entries.insert(
                (*name).to_string(),
                serde_json::json!({
                    "size": content.len(),
                    "offset": offset.to_string(),
                    "integrity": {
                        "algorithm": "SHA256",
                        "hash": "test",
                        "blockSize": 4194304,
                        "blocks": ["test"]
                    }
                }),
            );
        }
        let header = serde_json::json!({ "files": { "dist": { "files": entries } } });
        let header_json = serde_json::to_string(&header).unwrap();
        let padding = crate::commands::antigravity_localization::asar_padding_len(header_json.len());
        let mut out = Vec::new();
        out.extend_from_slice(&4u32.to_le_bytes());
        out.extend_from_slice(&((header_json.len() + 8 + padding) as u32).to_le_bytes());
        out.extend_from_slice(&((header_json.len() + 4 + padding) as u32).to_le_bytes());
        out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
        out.extend_from_slice(header_json.as_bytes());
        out.extend(std::iter::repeat(0u8).take(padding));
        out.extend_from_slice(&payload);
        out
    }


    fn extract_hub_asar_dist_file(asar_bytes: &[u8], name: &str) -> String {
        let json_size = u32::from_le_bytes(asar_bytes[12..16].try_into().unwrap()) as usize;
        let declared = u32::from_le_bytes(asar_bytes[4..8].try_into().unwrap()) as usize;
        let payload_start =
            crate::commands::antigravity_localization::asar_payload_start(declared);
        let header: Value =
            serde_json::from_slice(&asar_bytes[16..16 + json_size]).unwrap();
        let node = header
            .pointer(&format!("/files/dist/files/{name}"))
            .unwrap_or_else(|| panic!("missing dist/{name} in asar"));
        let offset: usize = node.get("offset").unwrap().as_str().unwrap().parse().unwrap();
        let size: usize = node.get("size").unwrap().as_u64().unwrap() as usize;
        std::str::from_utf8(&asar_bytes[payload_start + offset..payload_start + offset + size])
            .unwrap()
            .to_string()
    }


    fn assert_ls_defaults_runtime_switches(patched_ls_defaults: &str) {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("ab-lsdefaults-rt-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mod_path = dir.join("lsDefaults.cjs");
        let on_cfg = dir.join("settings-on.json");
        let off_cfg = dir.join("settings-off.json");
        let runner = dir.join("run.cjs");

        fs::write(&mod_path, patched_ls_defaults).unwrap();
        fs::write(&on_cfg, r#"{"jetski.cloudCodeUrl":"https://localhost:7452"}"#).unwrap();
        fs::write(&off_cfg, "{}").unwrap();
        // 默认候选路径的真机形状（2026-11-14 事故）：JSONC 注释+尾逗号。
        let appdata = dir.join("appdata").join("Antigravity").join("User");
        fs::create_dir_all(&appdata).unwrap();
        fs::write(
            appdata.join("settings.json"),
            "// client-managed\n{\n  \"jetski.cloudCodeUrl\": \"https://localhost:7452\",\n}\n",
        )
        .unwrap();
        let appdata_off = dir.join("appdata-off").join("Antigravity").join("User");
        fs::create_dir_all(&appdata_off).unwrap();
        fs::write(appdata_off.join("settings.json"), "{\n}\n").unwrap();
        fs::write(
            &runner,
            concat!(
                "const modPath = process.argv[2], onCfg = process.argv[3], offCfg = process.argv[4], jsoncApp = process.argv[5], emptyApp = process.argv[6];\n",
                "const opts = { ideVersion: '2.32.1', httpsServerPort: 1, csrfToken: 't', appDataDir: 'd' };\n",
                "const ep = (arr) => arr[arr.indexOf('--cloud_code_endpoint') + 1];\n",
                // 候选扫描会穿透 env 覆盖继续扫 APPDATA 与 os.homedir()——on/off 腿必须彻底隔离真机
                // settings.json（不仅 APPDATA/LOCALAPPDATA，USERPROFILE/HOME/XDG_* 也要隔离）
                "const setIsoEnv = (r) => { process.env.APPDATA = r; process.env.LOCALAPPDATA = r; process.env.USERPROFILE = r; process.env.HOME = r; process.env.XDG_CONFIG_HOME = r; process.env.XDG_DATA_HOME = r; };\n",
                "setIsoEnv(emptyApp);\n",
                "process.env.ANYBRIDGE_ANTIGRAVITY_SETTINGS = onCfg;\n",
                "delete require.cache[require.resolve(modPath)];\n",
                "const argsOn = require(modPath).baseLsArgs(opts);\n",
                "process.env.ANYBRIDGE_ANTIGRAVITY_SETTINGS = offCfg;\n",
                "delete require.cache[require.resolve(modPath)];\n",
                "const argsOff = require(modPath).baseLsArgs(opts);\n",
                // 默认候选路径：无覆盖 env，走 APPDATA 下的 JSONC 真机形状
                "delete process.env.ANYBRIDGE_ANTIGRAVITY_SETTINGS;\n",
                "setIsoEnv(jsoncApp);\n",
                "delete require.cache[require.resolve(modPath)];\n",
                "const argsJsonc = require(modPath).baseLsArgs(opts);\n",
                "setIsoEnv(emptyApp);\n",
                "delete require.cache[require.resolve(modPath)];\n",
                "const argsEmpty = require(modPath).baseLsArgs(opts);\n",
                "console.log(JSON.stringify({ on: ep(argsOn), off: ep(argsOff), jsonc: ep(argsJsonc), empty: ep(argsEmpty) }));\n",
            ),
        )
        .unwrap();

        // 全量并发/打包高负载下 spawn 偶发抖动，失败重试；node 起不来绝不能
        // 静默通过——静默通过等于把执行级校验降级成摆设（35ef9897 同源教训）。
        // 显式移除 NODE_OPTIONS：宿主 AI IDE 注入的 --require shim 在高负载下
        // 会加载失败让 node 直接退出，本脚本是纯 CJS，不需要任何宿主 shim。
        let mut last_fail: Option<String> = None;
        for _attempt in 0..3 {
            match isolated_node_cmd(&dir.join("appdata-off"))
                .arg(&runner)
                .arg(&mod_path)
                .arg(&on_cfg)
                .arg(&off_cfg)
                .arg(dir.join("appdata"))
                .arg(dir.join("appdata-off"))
                .output()
            {
                Err(e) => last_fail = Some(format!("node 无法启动: {e}")),
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                    if !out.status.success() {
                        last_fail = Some(format!("lsDefaults 运行时执行异常:\n{stderr}\n{stdout}"));
                        continue;
                    }
                    match serde_json::from_str::<Value>(stdout.trim()) {
                        Err(e) => last_fail = Some(format!("输出非 JSON ({stdout}): {e}")),
                        Ok(parsed) => {
                            if parsed["on"] != "https://localhost:7452" {
                                last_fail = Some(format!("接入时没读出本地网关: {stdout}"));
                            } else if parsed["off"] != "https://daily-cloudcode-pa.googleapis.com" {
                                last_fail = Some(format!("撤键后没回退官方端点: {stdout}"));
                            } else if parsed["jsonc"] != "https://localhost:7452" {
                                last_fail = Some(format!(
                                    "默认候选路径必须读出 JSONC settings（真机形状）: {stdout}"
                                ));
                            } else if parsed["empty"] != "https://daily-cloudcode-pa.googleapis.com" {
                                last_fail = Some(format!("默认候选路径无键时必须回官方: {stdout}"));
                            } else {
                                last_fail = None;
                                break;
                            }
                        }
                    }
                }
            }
        }
        if let Some(msg) = last_fail {
            panic!("lsDefaults 执行级校验失败（重试 3 次）: {msg}");
        }
        let _ = fs::remove_dir_all(&dir);
    }


    #[test]
    fn antigravity_hub_asar_patch_end_to_end_and_runtime_exec() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("ab-hub-e2e-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let asar = dir.join("app.asar");
        let ls_defaults = concat!(
            "\"use strict\";\n",
            "exports.LS_CLOUD_CODE_ENDPOINT = exports.LS_API_SERVER_URL = void 0;\n",
            "exports.baseLsArgs = baseLsArgs;\n",
            "exports.LS_API_SERVER_URL = 'https://generativelanguage.googleapis.com';\n",
            "exports.LS_CLOUD_CODE_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';\n",
            "function baseLsArgs(opts) {\n",
            "    return ['--override_ide_version', opts.ideVersion, '--cloud_code_endpoint', exports.LS_CLOUD_CODE_ENDPOINT];\n",
            "}\n",
        );
        let orig_bytes = build_fake_hub_asar(&[
            ("lsDefaults.js", ls_defaults),
            ("languageServer.js", "exports.start = () => {};"),
            ("preload.js", "// third-party preload intact"),
        ]);
        fs::write(&asar, &orig_bytes).unwrap();

        patch_antigravity_hub_asar(&asar).expect("2.32.1 模拟 asar 补丁必须成功");
        assert_eq!(
            fs::read(dir.join("app.asar.official.bak")).unwrap(),
            orig_bytes,
            "首次必须保存原始 official 备份"
        );
        assert!(
            crate::commands::antigravity_localization::hub_has_byok_patch(&asar),
            "汉化还原判据必须识别新节点的 BYOK 补丁"
        );

        let after_first = fs::read(&asar).unwrap();
        patch_antigravity_hub_asar(&asar).expect("重复调用必须幂等成功");
        assert_eq!(
            fs::read(&asar).unwrap(),
            after_first,
            "幂等：不得重复写盘"
        );
        assert_eq!(
            extract_hub_asar_dist_file(&after_first, "preload.js"),
            "// third-party preload intact",
            "不得破坏同包其它文件"
        );

        let patched_defaults = extract_hub_asar_dist_file(&after_first, "lsDefaults.js");
        assert_ls_defaults_runtime_switches(&patched_defaults);
        let _ = fs::remove_dir_all(&dir);
    }


    #[test]
    fn antigravity_hub_real_asar_copy_smoke() {
        let Ok(src) = std::env::var("ANYBRIDGE_TEST_REAL_HUB_ASAR") else {
            return;
        };
        let src_path = PathBuf::from(&src);
        assert!(src_path.exists(), "指定真实 asar 路径不存在: {src}");

        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("ab-real-hub-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let copy_asar = dir.join("app.asar");
        fs::copy(&src_path, &copy_asar).unwrap();
        let orig_len = fs::metadata(&copy_asar).unwrap().len();

        patch_antigravity_hub_asar(&copy_asar).expect("真实 2.32.1 asar 副本打补丁失败");
        assert!(
            crate::commands::antigravity_localization::hub_has_byok_patch(&copy_asar),
            "真实副本上 hub_has_byok_patch 必须返回 true"
        );
        let after_first = fs::read(&copy_asar).unwrap();
        assert!(after_first.len() as u64 > orig_len);

        patch_antigravity_hub_asar(&copy_asar).expect("真实副本幂等重跑失败");
        assert_eq!(fs::read(&copy_asar).unwrap(), after_first, "真实副本二次调用必须幂等");

        let patched_defaults = extract_hub_asar_dist_file(&after_first, "lsDefaults.js");
        assert_ls_defaults_runtime_switches(&patched_defaults);

        if let Ok(out_path) = std::env::var("ANYBRIDGE_TEST_REAL_OUT_ASAR") {
            let p = PathBuf::from(out_path);
            if let Some(parent) = p.parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::write(p, &after_first).unwrap();
        }
        let _ = fs::remove_dir_all(&dir);
    }


    #[test]
    fn antigravity_hub_patch_heals_double_patched_hybrid() {
        // 真机事故（2026-11-11）：旧版补丁器把 v2 箭头 IIFE 切进 v1 注入块中间，
        // 在内层 cands 构建器的 `})()` 处截断，留下 `,"utf8"))...` 悬空残尾，
        // 白底主进程 SyntaxError 拒绝启动。自愈必须吃掉整行残留——
        // 注入块内部的 `})()` 不许截断匹配，只能终止于残尾最后一个 `})()`。
        let broken = concat!(
            "const args=['--api_server_url','https://generativelanguage.googleapis.com',\n",
            "  '--cloud_code_endpoint',\n",
            r#"  (() => { try { const fs=require("fs"),cands=(function(){const p=require("path"),os=require("os"),h=os.homedir(),env=process.env,names=["Antigravity","antigravity"],roots=[],cands=[];const av=["--user-data-dir=/tmp/x"];for(let i=0;i<av.length;i++){const a=av[i];const m=/^--user-data-dir=(.+)$/.exec(a);if(m)cands.push(p.join(m[1],"User","settings.json"))}for(const r of roots){for(const n of names)cands.push(p.join(r,n,"User","settings.json"))}return cands})();for(const f of cands){if(!f)continue;try{if(!fs.existsSync(f))continue;const v=JSON.parse(fs.readFileSync(f,"utf8"))["jetski.cloudCodeUrl"];if(typeof v==="string"&&v.trim()&&/^https?:/i.test(v.trim()))return v.trim();}catch(_){}} } catch(_) {} return 'https://daily-cloudcode-pa.googleapis.com'; })()/*ANYBRIDGE_CLOUD_CODE_ENDPOINT_V2*//*ANYBRIDGE_CLOUD_CODE_ENDPOINT*/,"utf8"))["jetski.cloudCodeUrl"];if(typeof v==="string"&&v.trim()&&/^https?:/i.test(v.trim()))return v.trim();}catch(_){}} } catch(_) {} return process.env.CLOUD_CODE_URL || 'https://daily-cloudcode-pa.googleapis.com'; })()/*ANYBRIDGE_CLOUD_CODE_ENDPOINT*/,"#,
            "\n  '--enable_sidecars'];",
        );
        let healed = patch_hub_language_server_code(broken)
            .unwrap_or_else(|e| panic!("杂交残尸自愈失败: {e}"));
        assert_valid_js("hybrid_heal", &healed);
        assert!(
            healed.contains(ANTIGRAVITY_HUB_ENDPOINT_VERSION),
            "杂交残尸必须升级到当前版本注入"
        );
        assert_eq!(
            healed.matches("https://daily-cloudcode-pa.googleapis.com").count(),
            1,
            "官方兜底 URL 只能剩 V3 注入里的那一份，残尾必须被整体吃掉"
        );
        assert!(
            !healed.contains("process.env.CLOUD_CODE_URL"),
            "旧版兜底读取脏环境变量的尾巴必须消失"
        );
        assert!(
            healed.contains("--api_server_url") && healed.contains("--enable_sidecars"),
            "相邻参数必须完好"
        );
        assert_eq!(
            patch_hub_language_server_code(&healed).unwrap(),
            healed,
            "自愈后幂等"
        );
    }


    #[test]
    fn antigravity_install_paths_have_no_hardcoded_username() {
        // 路径发现必须跨平台且不硬编码某个用户名/盘符。
        // 只检查路径发现函数本身，源码其它位置（注释/测试断言）可能出现该字面量。
        let src = concat!(include_str!("../antigravity_patch.rs"), include_str!("../antigravity.rs"));
        let start = src.find("fn antigravity_install_app_dirs()").unwrap();
        let end = src.find("fn antigravity_ide_extension_candidates()").unwrap();
        let discovery = &src[start..end];
        assert!(
            !discovery.contains("Users\\") && !discovery.contains("Users/"),
            "路径发现不得硬编码用户名"
        );
        assert!(src.contains("dirs::home_dir"), "必须按当前用户主目录推导");
        assert!(src.contains("ANYBRIDGE_ANTIGRAVITY_IDE_APP_DIR"), "必须支持自定义安装路径覆盖");
        assert!(src.contains("XDG_DATA_HOME"), "Linux 必须支持 XDG 布局");
        assert!(
            src.contains("Library") && src.contains("Application Support"),
            "macOS 必须覆盖 Application Support 布局"
        );
        let injection = antigravity_ide_extension_injection();
        assert!(injection.contains("os.homedir"), "注入块必须按当前用户主目录推导");
        assert!(injection.contains("XDG_CONFIG_HOME"), "注入块必须支持 Linux XDG");
        assert!(injection.contains("APPDATA"), "注入块必须支持 Windows APPDATA");
        assert!(injection.contains("--user-data-dir"), "注入块必须支持便携版");
        assert_valid_js("ide_injection", &format!("const x={injection};"));
        assert_valid_js("hub_injection", &format!("const y={};", antigravity_hub_endpoint_injection()));
    }


    #[test]
    fn antigravity_extension_patch_rejects_unanchored_code() {
        assert!(
            patch_antigravity_extension_code("var a=1;").is_err(),
            "无锚点必须报错，接入流程据此中断防假接入"
        );
        let broken = "/*ANYBRIDGE_CLOUD_CODE_URL*/ var a=1;";
        assert!(
            patch_antigravity_extension_code(broken).is_err(),
            "marker 存在但锚点丢失同样必须报错"
        );
    }
