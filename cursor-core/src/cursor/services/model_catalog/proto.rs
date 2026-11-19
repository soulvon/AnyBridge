use prost::Message;

use crate::cursor::protocol::proto::agent::v1 as agent;

#[derive(Clone, PartialEq, Message)]
pub(super) struct AvailableModelsAddition {
    #[prost(string, repeated, tag = "1")]
    pub(super) model_names: Vec<String>,
    #[prost(message, repeated, tag = "2")]
    pub(super) models: Vec<AvailableModel>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct AvailableModel {
    #[prost(string, tag = "1")]
    pub(super) name: String,
    #[prost(bool, tag = "2")]
    pub(super) default_on: bool,
    #[prost(bool, optional, tag = "5")]
    pub(super) supports_agent: Option<bool>,
    #[prost(int32, optional, tag = "6")]
    pub(super) degradation_status: Option<i32>,
    #[prost(message, optional, tag = "8")]
    pub(super) tooltip_data: Option<TooltipData>,
    #[prost(bool, optional, tag = "9")]
    pub(super) supports_thinking: Option<bool>,
    #[prost(bool, optional, tag = "10")]
    pub(super) supports_images: Option<bool>,
    #[prost(bool, optional, tag = "14")]
    pub(super) supports_max_mode: Option<bool>,
    #[prost(string, optional, tag = "17")]
    pub(super) client_display_name: Option<String>,
    #[prost(string, optional, tag = "18")]
    pub(super) server_model_name: Option<String>,
    #[prost(bool, optional, tag = "19")]
    pub(super) supports_non_max_mode: Option<bool>,
    #[prost(message, optional, tag = "20")]
    pub(super) tooltip_data_for_max_mode: Option<TooltipData>,
    #[prost(bool, optional, tag = "21")]
    pub(super) is_recommended_for_background_composer: Option<bool>,
    #[prost(bool, optional, tag = "22")]
    pub(super) supports_plan_mode: Option<bool>,
    #[prost(string, optional, tag = "24")]
    pub(super) inputbox_short_model_name: Option<String>,
    #[prost(bool, optional, tag = "25")]
    pub(super) supports_sandboxing: Option<bool>,
    #[prost(bool, optional, tag = "26")]
    pub(super) supports_cmd_k: Option<bool>,
    #[prost(message, repeated, tag = "29")]
    pub(super) parameter_definitions: Vec<ModelParameterDefinition>,
    #[prost(message, repeated, tag = "30")]
    pub(super) variants: Vec<ModelVariant>,
    #[prost(string, repeated, tag = "36")]
    pub(super) legacy_slugs: Vec<String>,
    #[prost(int32, optional, tag = "38")]
    pub(super) named_model_section_index: Option<i32>,
    #[prost(string, optional, tag = "41")]
    pub(super) vendor_name: Option<String>,
    #[prost(message, optional, tag = "42")]
    pub(super) vendor: Option<AvailableModelVendor>,
    #[prost(message, repeated, tag = "48")]
    pub(super) model_picker_badges: Vec<ModelPickerBadge>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct TooltipData {
    #[prost(string, optional, tag = "7")]
    pub(super) markdown_content: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ModelParameterDefinition {
    #[prost(string, tag = "1")]
    pub(super) id: String,
    #[prost(string, tag = "2")]
    pub(super) name: String,
    #[prost(string, optional, tag = "3")]
    pub(super) markdown_tooltip: Option<String>,
    #[prost(message, optional, tag = "4")]
    pub(super) parameter_type: Option<ModelParameterType>,
    #[prost(bool, optional, tag = "5")]
    pub(super) is_cycleable_by_hotkey: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ModelParameterType {
    #[prost(message, optional, tag = "1")]
    pub(super) boolean_parameter: Option<BooleanParameter>,
    #[prost(message, optional, tag = "2")]
    pub(super) enum_parameter: Option<EnumParameter>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct BooleanParameter {
    #[prost(message, repeated, tag = "1")]
    pub(super) values: Vec<BooleanParameterValue>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct BooleanParameterValue {
    #[prost(string, tag = "1")]
    pub(super) value: String,
    #[prost(string, optional, tag = "2")]
    pub(super) display_name: Option<String>,
    #[prost(bool, optional, tag = "3")]
    pub(super) increases_model_cost: Option<bool>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct EnumParameter {
    #[prost(message, repeated, tag = "1")]
    pub(super) values: Vec<EnumParameterValue>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct EnumParameterValue {
    #[prost(string, tag = "1")]
    pub(super) value: String,
    #[prost(string, optional, tag = "2")]
    pub(super) display_name: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ModelVariant {
    #[prost(message, repeated, tag = "1")]
    pub(super) parameter_values: Vec<ModelParameterValue>,
    #[prost(string, tag = "2")]
    pub(super) display_name: String,
    #[prost(bool, tag = "3")]
    pub(super) is_max_mode: bool,
    #[prost(bool, optional, tag = "4")]
    pub(super) is_default_max_config: Option<bool>,
    #[prost(bool, optional, tag = "5")]
    pub(super) is_default_non_max_config: Option<bool>,
    #[prost(message, optional, tag = "6")]
    pub(super) tooltip_data: Option<TooltipData>,
    #[prost(string, optional, tag = "8")]
    pub(super) display_name_outside_picker: Option<String>,
    #[prost(string, optional, tag = "9")]
    pub(super) variant_string_representation: Option<String>,
    #[prost(string, optional, tag = "11")]
    pub(super) legacy_slug: Option<String>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ModelParameterValue {
    #[prost(string, tag = "1")]
    pub(super) id: String,
    #[prost(string, tag = "2")]
    pub(super) value: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct ModelPickerBadge {
    #[prost(string, tag = "1")]
    pub(super) label: String,
    #[prost(int32, tag = "2")]
    pub(super) variant: i32,
    #[prost(bool, tag = "3")]
    pub(super) dismiss_on_selection: bool,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct AvailableModelVendor {
    #[prost(int32, tag = "1")]
    pub(super) id: i32,
    #[prost(string, tag = "2")]
    pub(super) display_name: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct UsableModelsAddition {
    #[prost(message, repeated, tag = "1")]
    pub(super) models: Vec<agent::ModelDetails>,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct DefaultModelResponse {
    #[prost(string, tag = "1")]
    pub(super) model: String,
    #[prost(string, tag = "2")]
    pub(super) thinking_model: String,
    #[prost(bool, tag = "3")]
    pub(super) max_mode: bool,
    #[prost(string, tag = "4")]
    pub(super) next_default_set_date: String,
}

#[derive(Clone, PartialEq, Message)]
pub(super) struct DefaultModelNudgeDataResponse {
    #[prost(string, tag = "1")]
    pub(super) nudge_date: String,
    #[prost(bool, tag = "2")]
    pub(super) should_default_switch_on_new_chat: bool,
    #[prost(string, repeated, tag = "3")]
    pub(super) models_with_no_default_switch: Vec<String>,
    #[prost(string, tag = "4")]
    pub(super) conversion_model_override: String,
}
