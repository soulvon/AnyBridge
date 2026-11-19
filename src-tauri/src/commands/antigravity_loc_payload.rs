// antigravity_loc_payload.rs — 反重力高性能深度汉化注入脚本与词典

/// payload 首行锚点：get_hub_payload 组装、去重截断、is_hub_localized 判据
/// 全部引用本常量。禁止在别处重写字面量——历史上三处字面量各自为政，
/// 导致状态恒"未汉化"且每次 apply 重复追加 payload（asar 持续膨胀）。
pub const HUB_PATCH_HEADER: &str = "// Antigravity (独立桌面端) 汉化引擎";

/// preload 运行时置位标记（payload 内 `window.<FLAG> = true`）。
/// is_hub_localized 与备份判定引用同一常量。
pub const HUB_PATCH_FLAG: &str = "__antigravityZhPatchInstalled";

/// 热更新词典挂载点：AnyBridge 在补丁块前注入
/// `window.<HUB_DICT_GLOBAL> = {..};`，引擎启动时合并进内置 phrases。
pub const HUB_DICT_GLOBAL: &str = "__ANYBRIDGE_HANS_DICT";

pub const HUB_PAYLOAD_JS: &str = concat!(
    "\n",
    include_str!("../../resources/antigravity-hub/phrases.js"),
    include_str!("../../resources/antigravity-hub/runtime.js"),
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_payload_flag_and_dict_merge_stay_in_sync() {
        // 判据/去重/备份全部引用这两个常量：只改 payload 不改判据，必须在这里红
        // （历史事故：三处字面量失配 → 状态恒"未汉化"、每次 apply 重复追加 payload）
        assert!(
            HUB_PAYLOAD_JS.contains(&format!("window.{HUB_PATCH_FLAG} = true")),
            "运行时置位标记必须存在，is_hub_localized 靠它判定"
        );
        assert!(
            HUB_PAYLOAD_JS.contains(&format!("window.{HUB_DICT_GLOBAL}")),
            "热更新合并段必须消费覆盖块，否则热更新是死码"
        );
        // 首行锚点由 get_hub_payload 组装时前置在补丁块最前，保证去重截断有稳定起点
        assert!(HUB_PATCH_HEADER.starts_with("// "), "锚点必须是注释行");
    }
}

