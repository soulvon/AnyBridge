use crate::{
    cursor::protocol::proto::agent::v1 as agent,
    model::{format_token_count, parse_token_count, ModelConfig},
    plugin::PluginModelDescriptor,
};

use super::proto::{
    AvailableModel, AvailableModelVendor, BooleanParameter, BooleanParameterValue, EnumParameter,
    EnumParameterValue, ModelParameterDefinition, ModelParameterType, ModelParameterValue,
    ModelPickerBadge, ModelVariant, TooltipData,
};

pub(super) const CLI_LOCAL_MODEL_API_KEY: &str = "cursor-byok-local";

const CONTEXTS: [(&str, &str); 5] = [
    ("200k", "200K"),
    ("356k", "356K"),
    ("500k", "500K"),
    ("800k", "800K"),
    ("1m", "1M"),
];
const EFFORTS: [(&str, &str); 5] = [
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("xhigh", "Extra High"),
    ("max", "Max"),
];
const DEFAULT_CONTEXT: &str = "200k";

fn context_options(context_window_tokens: Option<u64>) -> Vec<(String, String)> {
    let mut contexts = CONTEXTS
        .into_iter()
        .map(|(value, display_name)| (value.to_owned(), display_name.to_owned()))
        .collect::<Vec<_>>();
    if let Some(tokens) = context_window_tokens {
        let value = tokens.to_string();
        let duplicate = contexts
            .iter()
            .any(|(existing, _)| parse_token_count(existing) == Some(tokens));
        if !duplicate {
            contexts.push((value, format!("{} (Custom)", format_token_count(tokens))));
        }
    }
    contexts
}

pub(super) fn available_model(model: &ModelConfig) -> AvailableModel {
    let contexts = context_options(model.context_window_tokens);
    let tooltip = model_tooltip(model);
    let variants = model_variants(
        &model.model_hash,
        &model.display_name,
        &tooltip,
        &contexts,
        true,
    );
    let legacy_slugs = variants
        .iter()
        .filter_map(|variant| variant.legacy_slug.clone())
        .collect();
    AvailableModel {
        name: model.model_hash.clone(),
        default_on: true,
        supports_agent: Some(true),
        degradation_status: Some(0),
        tooltip_data: Some(tooltip.clone()),
        supports_thinking: Some(true),
        supports_images: Some(true),
        supports_max_mode: Some(true),
        client_display_name: Some(model.display_name.clone()),
        server_model_name: Some(model.model_hash.clone()),
        supports_non_max_mode: Some(true),
        tooltip_data_for_max_mode: Some(tooltip),
        is_recommended_for_background_composer: Some(false),
        supports_plan_mode: Some(true),
        inputbox_short_model_name: Some(model.display_name.clone()),
        supports_sandboxing: Some(true),
        supports_cmd_k: Some(false),
        parameter_definitions: model_parameters(&contexts, true),
        variants,
        legacy_slugs,
        named_model_section_index: Some(1),
        vendor_name: Some("cursor".into()),
        vendor: Some(AvailableModelVendor {
            id: 6,
            display_name: "Cursor".into(),
        }),
        model_picker_badges: match &model.group_name {
            Some(group) if !group.trim().is_empty() => vec![ModelPickerBadge {
                label: group.clone(),
                variant: 1,
                dismiss_on_selection: false,
            }],
            _ => Vec::new(),
        },
    }
}

/// 徽章回退标签:base_url 的主机名。入库时已校验为带主机的 HTTP(S) URL,
/// 解析失败仅是理论分支,此时原样返回 base_url。
#[allow(dead_code)]
fn provider_host(base_url: &str) -> String {
    reqwest::Url::parse(base_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_lowercase))
        .unwrap_or_else(|| base_url.trim().into())
}

fn model_parameters(
    contexts: &[(String, String)],
    thinking: bool,
) -> Vec<ModelParameterDefinition> {
    let mut parameters = vec![ModelParameterDefinition {
        id: "context".into(),
        name: "Context".into(),
        markdown_tooltip: Some("Context size used to trigger conversation compaction.".into()),
        parameter_type: Some(ModelParameterType {
            boolean_parameter: None,
            enum_parameter: Some(EnumParameter {
                values: contexts
                    .iter()
                    .map(|(value, display_name)| EnumParameterValue {
                        value: value.clone(),
                        display_name: Some(display_name.clone()),
                    })
                    .collect(),
            }),
        }),
        is_cycleable_by_hotkey: Some(false),
    }];
    if thinking {
        parameters.push(ModelParameterDefinition {
            id: "reasoning".into(),
            name: "Effort".into(),
            markdown_tooltip: Some("Effort the model uses to generate its response.".into()),
            parameter_type: Some(ModelParameterType {
                boolean_parameter: None,
                enum_parameter: Some(EnumParameter {
                    values: EFFORTS
                        .into_iter()
                        .map(|(value, display_name)| EnumParameterValue {
                            value: value.into(),
                            display_name: Some(display_name.into()),
                        })
                        .collect(),
                }),
            }),
            is_cycleable_by_hotkey: Some(true),
        });
    }
    parameters.push(ModelParameterDefinition {
        id: "fast".into(),
        name: "Fast".into(),
        markdown_tooltip: Some("Significantly faster but consumes more usage".into()),
        parameter_type: Some(ModelParameterType {
            boolean_parameter: Some(BooleanParameter {
                values: vec![
                    BooleanParameterValue {
                        value: "false".into(),
                        display_name: None,
                        increases_model_cost: None,
                    },
                    BooleanParameterValue {
                        value: "true".into(),
                        display_name: Some("Fast".into()),
                        increases_model_cost: Some(true),
                    },
                ],
            }),
            enum_parameter: None,
        }),
        is_cycleable_by_hotkey: Some(false),
    });
    parameters
}

fn model_variants(
    name: &str,
    display_name: &str,
    tooltip: &TooltipData,
    contexts: &[(String, String)],
    thinking: bool,
) -> Vec<ModelVariant> {
    // 非思考模型没有 Effort 轴,变体网格只剩 Context × Fast。
    let efforts: &[Option<(&str, &str)>] = if thinking {
        &[
            Some(EFFORTS[0]),
            Some(EFFORTS[1]),
            Some(EFFORTS[2]),
            Some(EFFORTS[3]),
            Some(EFFORTS[4]),
        ]
    } else {
        &[None]
    };
    let mut variants = Vec::with_capacity(contexts.len() * efforts.len() * 2);
    for (context, context_name) in contexts {
        for effort in efforts {
            for fast in [false, true] {
                variants.push(model_variant(
                    name,
                    display_name,
                    tooltip,
                    context,
                    context_name,
                    *effort,
                    fast,
                ));
            }
        }
    }
    variants
}

fn model_variant(
    name: &str,
    display_name: &str,
    tooltip: &TooltipData,
    context: &str,
    context_name: &str,
    effort: Option<(&str, &str)>,
    fast: bool,
) -> ModelVariant {
    let mut suffix = Vec::with_capacity(3);
    if context != DEFAULT_CONTEXT {
        suffix.push(context_name);
    }
    if let Some((_, effort_name)) = effort {
        suffix.push(effort_name);
    }
    if fast {
        suffix.push("Fast");
    }
    let suffix = suffix.join(" ");
    let display_name = if suffix.is_empty() {
        display_name.to_owned()
    } else {
        format!(
            "{display_name} <span style=\"color: var(--cursor-text-tertiary);\">{suffix}</span>"
        )
    };
    let is_default =
        context == DEFAULT_CONTEXT && !fast && effort.is_none_or(|(effort, _)| effort == "high");
    let mut parameter_values = vec![ModelParameterValue {
        id: "context".into(),
        value: context.into(),
    }];
    if let Some((effort, _)) = effort {
        parameter_values.push(ModelParameterValue {
            id: "reasoning".into(),
            value: effort.into(),
        });
    }
    parameter_values.push(ModelParameterValue {
        id: "fast".into(),
        value: fast.to_string(),
    });
    ModelVariant {
        parameter_values,
        display_name: display_name.clone(),
        is_max_mode: false,
        is_default_max_config: is_default.then_some(true),
        is_default_non_max_config: is_default.then_some(true),
        tooltip_data: Some(tooltip.clone()),
        display_name_outside_picker: Some(display_name),
        variant_string_representation: Some(match effort {
            Some((effort, _)) => {
                format!("{name}[context={context},reasoning={effort},fast={fast}]")
            }
            None => format!("{name}[context={context},fast={fast}]"),
        }),
        legacy_slug: Some(format!(
            "{name}-{context}{}{}",
            effort
                .map(|(effort, _)| format!("-{effort}"))
                .unwrap_or_default(),
            if fast { "-fast" } else { "" }
        )),
    }
}

fn model_tooltip(model: &ModelConfig) -> TooltipData {
    TooltipData {
        markdown_content: Some(model.tooltip_data.clone()),
    }
}

pub(super) fn available_plugin_model(model: &PluginModelDescriptor) -> AvailableModel {
    let tooltip = TooltipData {
        markdown_content: model.description.clone(),
    };
    // Effort 与上下文档位由宿主统一提供,与内置模型一致;插件不再声明这两项。
    let contexts = context_options(None);
    let variants = model_variants(&model.id, &model.display_name, &tooltip, &contexts, true);
    let legacy_slugs = variants
        .iter()
        .filter_map(|variant| variant.legacy_slug.clone())
        .collect();
    AvailableModel {
        name: model.id.clone(),
        default_on: true,
        supports_agent: Some(true),
        degradation_status: Some(0),
        tooltip_data: Some(tooltip.clone()),
        supports_thinking: Some(true),
        supports_images: Some(model.images),
        supports_max_mode: Some(false),
        client_display_name: Some(model.display_name.clone()),
        server_model_name: Some(model.id.clone()),
        supports_non_max_mode: Some(true),
        tooltip_data_for_max_mode: Some(tooltip.clone()),
        is_recommended_for_background_composer: Some(false),
        supports_plan_mode: Some(true),
        inputbox_short_model_name: Some(model.display_name.clone()),
        supports_sandboxing: Some(true),
        supports_cmd_k: Some(false),
        parameter_definitions: model_parameters(&contexts, true),
        variants,
        legacy_slugs,
        named_model_section_index: Some(1),
        vendor_name: Some(model.provider_type.clone()),
        vendor: Some(AvailableModelVendor {
            id: 6,
            display_name: model.provider_type.clone(),
        }),
        model_picker_badges: vec![ModelPickerBadge {
            label: model.plugin_name.clone(),
            variant: 1,
            dismiss_on_selection: false,
        }],
    }
}

fn cli_local_model_credentials() -> agent::model_details::Credentials {
    agent::model_details::Credentials::ApiKeyCredentials(agent::ApiKeyCredentials {
        api_key: CLI_LOCAL_MODEL_API_KEY.into(),
        base_url: None,
    })
}

pub(super) fn usable_plugin_model(model: &PluginModelDescriptor) -> agent::ModelDetails {
    agent::ModelDetails {
        model_id: model.id.clone(),
        display_model_id: model.id.clone(),
        display_name: model.display_name.clone(),
        display_name_short: model.display_name.clone(),
        thinking_details: Some(agent::ThinkingDetails::default()),
        credentials: Some(cli_local_model_credentials()),
        ..Default::default()
    }
}

pub(super) fn usable_model(model: &ModelConfig) -> agent::ModelDetails {
    agent::ModelDetails {
        model_id: model.model_hash.clone(),
        display_model_id: model.model_hash.clone(),
        display_name: model.display_name.clone(),
        display_name_short: model.display_name.clone(),
        thinking_details: Some(agent::ThinkingDetails::default()),
        credentials: Some(cli_local_model_credentials()),
        ..Default::default()
    }
}
