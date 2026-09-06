//! Converts Cursor interaction completions into Tool results.
use crate::{
    cursor::{protocol::proto::agent::v1 as pb, tools::codec as interaction},
    search::{FetchedPage, SearchHit},
    Error, Result,
};

use super::ToolCompletion;
use crate::cursor::tools::runtime::PendingInteraction;

pub(crate) fn from_interaction(
    pending: PendingInteraction,
    response: &pb::InteractionResponse,
) -> Result<ToolCompletion> {
    use pb::{interaction_response::Result as Response, tool_call::Tool};
    let call = &pending.call;
    let mut rendered = interaction::render_tool_call(call, false)?;
    let (output, is_error) = match (rendered.tool.as_mut(), response.result.as_ref()) {
        (
            Some(Tool::AskQuestionToolCall(tool)),
            Some(Response::AskQuestionInteractionResponse(value)),
        ) => {
            let result = value
                .result
                .clone()
                .ok_or_else(|| missing("ask question"))?;
            let output = ask_output(&result)?;
            tool.result = Some(result);
            output
        }
        (
            Some(Tool::CreatePlanToolCall(tool)),
            Some(Response::CreatePlanRequestResponse(value)),
        ) => {
            let result = value.result.clone().ok_or_else(|| missing("create plan"))?;
            let output = create_plan_output(&result)?;
            tool.result = Some(result);
            output
        }
        (
            Some(Tool::SwitchModeToolCall(tool)),
            Some(Response::SwitchModeRequestResponse(value)),
        ) => {
            let (result, output) = switch_mode_result(value)?;
            tool.result = Some(result);
            output
        }
        (Some(Tool::WebSearchToolCall(tool)), Some(Response::WebSearchRequestResponse(value))) => {
            match value
                .result
                .as_ref()
                .ok_or_else(|| missing("web search approval"))?
            {
                pb::web_search_request_response::Result::Rejected(rejected) => {
                    tool.result = Some(pb::WebSearchResult {
                        result: Some(pb::web_search_result::Result::Rejected(
                            pb::WebSearchRejected {
                                reason: rejected.reason.clone(),
                            },
                        )),
                    });
                    (rejected.reason.clone(), true)
                }
                pb::web_search_request_response::Result::Approved(_) => {
                    return Err(Error::Protocol(
                        "WebSearch approval reached terminal response decoding".into(),
                    ));
                }
            }
        }
        (Some(Tool::WebFetchToolCall(tool)), Some(Response::WebFetchRequestResponse(value))) => {
            match value
                .result
                .as_ref()
                .ok_or_else(|| missing("web fetch approval"))?
            {
                pb::web_fetch_request_response::Result::Rejected(rejected) => {
                    tool.result = Some(pb::WebFetchResult {
                        result: Some(pb::web_fetch_result::Result::Rejected(
                            pb::WebFetchRejected {
                                reason: rejected.reason.clone(),
                            },
                        )),
                    });
                    (rejected.reason.clone(), true)
                }
                pb::web_fetch_request_response::Result::Approved(_) => {
                    return Err(Error::Protocol(
                        "WebFetch approval is not a terminal tool result".into(),
                    ));
                }
            }
        }
        (
            Some(Tool::GenerateImageToolCall(tool)),
            Some(Response::GenerateImageRequestResponse(value)),
        ) => match value
            .result
            .as_ref()
            .ok_or_else(|| missing("generate image approval"))?
        {
            pb::generate_image_request_response::Result::Rejected(rejected) => {
                tool.result = Some(pb::GenerateImageResult {
                    result: Some(pb::generate_image_result::Result::Error(
                        pb::GenerateImageError {
                            error: rejected.reason.clone(),
                        },
                    )),
                });
                (rejected.reason.clone(), true)
            }
            pb::generate_image_request_response::Result::Approved(_) => {
                return Err(Error::Provider(
                    "GenerateImage requires a configured server-side image executor".into(),
                ));
            }
        },
        (Some(Tool::McpAuthToolCall(tool)), Some(Response::McpAuthRequestResponse(value))) => {
            let server_identifier = tool
                .args
                .as_ref()
                .map(|args| args.server_identifier.clone())
                .unwrap_or_default();
            let result = match value
                .result
                .as_ref()
                .ok_or_else(|| missing("MCP authentication"))?
            {
                pb::mcp_auth_request_response::Result::Approved(_) => {
                    pb::mcp_auth_result::Result::Success(pb::McpAuthSuccess {
                        server_identifier: server_identifier.clone(),
                    })
                }
                pb::mcp_auth_request_response::Result::Rejected(rejected) => {
                    pb::mcp_auth_result::Result::Rejected(pb::McpAuthRejected {
                        reason: rejected.reason.clone(),
                    })
                }
            };
            let (output, is_error) = match &result {
                pb::mcp_auth_result::Result::Success(_) => (
                    format!("Authenticated MCP server {server_identifier}"),
                    false,
                ),
                pb::mcp_auth_result::Result::Rejected(rejected) => (rejected.reason.clone(), true),
                pb::mcp_auth_result::Result::Error(error) => (error.error.clone(), true),
            };
            tool.result = Some(pb::McpAuthResult {
                result: Some(result),
            });
            (output, is_error)
        }
        _ => {
            return Err(Error::Protocol(format!(
                "unexpected InteractionResponse for tool {}",
                call.name
            )));
        }
    };
    ToolCompletion::from_rendered(call, pending.started_at_ms, output, is_error, rendered)
}

pub(crate) fn complete_web_search(
    pending: PendingInteraction,
    outcome: std::result::Result<Vec<SearchHit>, String>,
) -> Result<ToolCompletion> {
    let call = &pending.call;
    let mut rendered = interaction::render_tool_call(call, false)?;
    let Some(pb::tool_call::Tool::WebSearchToolCall(tool)) = rendered.tool.as_mut() else {
        return Err(Error::Protocol(format!(
            "tool {} is not WebSearch",
            call.name
        )));
    };
    let (output, is_error) = match outcome {
        Ok(hits) => {
            let output = hits
                .iter()
                .enumerate()
                .map(|(index, hit)| {
                    format!(
                        "{}. {}\nURL: {}\n{}",
                        index + 1,
                        hit.title,
                        hit.url,
                        hit.chunk
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            tool.result = Some(pb::WebSearchResult {
                result: Some(pb::web_search_result::Result::Success(
                    pb::WebSearchSuccess {
                        references: hits
                            .into_iter()
                            .map(|hit| pb::WebSearchReference {
                                title: hit.title,
                                url: hit.url,
                                chunk: hit.chunk,
                            })
                            .collect(),
                    },
                )),
            });
            (output, false)
        }
        Err(error) => {
            tool.result = Some(pb::WebSearchResult {
                result: Some(pb::web_search_result::Result::Error(pb::WebSearchError {
                    error: error.clone(),
                })),
            });
            (error, true)
        }
    };
    ToolCompletion::from_rendered(call, pending.started_at_ms, output, is_error, rendered)
}

pub(crate) fn complete_web_fetch(
    pending: PendingInteraction,
    outcome: std::result::Result<FetchedPage, String>,
) -> Result<ToolCompletion> {
    let call = &pending.call;
    let requested_url = call
        .arguments
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let mut rendered = interaction::render_tool_call(call, false)?;
    let Some(pb::tool_call::Tool::WebFetchToolCall(tool)) = rendered.tool.as_mut() else {
        return Err(Error::Protocol(format!(
            "tool {} is not WebFetch",
            call.name
        )));
    };
    let (output, is_error) = match outcome {
        Ok(page) => {
            let output = match page.cache.as_ref() {
                Some(cache) => format!(
                    "<system_reminder>Web content has been downloaded to: {}. If the content is omitted and you need it, use Shell to download it to a temporary directory, then use an appropriate tool to read it in pages.</system_reminder>\n{}",
                    cache.url, page.markdown
                ),
                None => page.markdown.clone(),
            };
            let output_location = page.cache.map(|cache| pb::OutputLocation {
                file_path: cache.file_path,
                size_bytes: cache.size_bytes,
                line_count: cache.line_count,
            });
            tool.result = Some(pb::WebFetchResult {
                result: Some(pb::web_fetch_result::Result::Success(pb::WebFetchSuccess {
                    url: page.url,
                    markdown: page.markdown,
                    output_location,
                })),
            });
            (output, false)
        }
        Err(error) => {
            tool.result = Some(pb::WebFetchResult {
                result: Some(pb::web_fetch_result::Result::Error(pb::WebFetchError {
                    url: requested_url.into(),
                    error: error.clone(),
                })),
            });
            (error, true)
        }
    };
    ToolCompletion::from_rendered(call, pending.started_at_ms, output, is_error, rendered)
}

fn ask_output(value: &pb::AskQuestionResult) -> Result<(String, bool)> {
    use pb::ask_question_result::Result as R;
    match value
        .result
        .as_ref()
        .ok_or_else(|| missing("ask question"))?
    {
        R::Success(value) => Ok((
            value
                .answers
                .iter()
                .map(|answer| {
                    let value = if answer.freeform_text.is_empty() {
                        answer.selected_option_ids.join(", ")
                    } else {
                        answer.freeform_text.clone()
                    };
                    format!("{}: {value}", answer.question_id)
                })
                .collect::<Vec<_>>()
                .join("\n"),
            false,
        )),
        R::Error(value) => Ok((value.error_message.clone(), true)),
        R::Rejected(value) => Ok((value.reason.clone(), true)),
        R::Async(_) => Ok(("question is running asynchronously".into(), false)),
    }
}

fn create_plan_output(value: &pb::CreatePlanResult) -> Result<(String, bool)> {
    use pb::create_plan_result::Result as R;
    match value
        .result
        .as_ref()
        .ok_or_else(|| missing("create plan"))?
    {
        R::Success(_) => Ok((format!("plan created: {}", value.plan_uri), false)),
        R::Error(value) => Ok((value.error.clone(), true)),
    }
}

fn switch_mode_result(
    value: &pb::SwitchModeRequestResponse,
) -> Result<(pb::SwitchModeResult, (String, bool))> {
    use pb::{switch_mode_request_response::Result as Input, switch_mode_result::Result as Output};
    match value
        .result
        .as_ref()
        .ok_or_else(|| missing("switch mode"))?
    {
        Input::Approved(_) => Ok((
            pb::SwitchModeResult {
                result: Some(Output::Success(pb::SwitchModeSuccess::default())),
            },
            ("mode switched".into(), false),
        )),
        Input::Rejected(value) => Ok((
            pb::SwitchModeResult {
                result: Some(Output::Rejected(pb::SwitchModeRejected {
                    reason: value.reason.clone(),
                })),
            },
            (value.reason.clone(), true),
        )),
    }
}

fn missing(name: &str) -> Error {
    Error::Protocol(format!("{name} returned no result"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{complete_web_fetch, PendingInteraction};
    use crate::{
        cursor::protocol::proto::agent::v1 as pb,
        model::ToolCall,
        search::{FetchedPage, WebCacheEntry},
    };

    #[test]
    fn web_fetch_result_leads_with_cache_reminder_and_bounds_cursor_payload() {
        let markdown = "x".repeat(40 * 1024);
        let location = "http://127.0.0.1:4312/web-cache/550e8400-e29b-41d4-a716-446655440000.txt";
        let completion = complete_web_fetch(
            pending_fetch(),
            Ok(FetchedPage {
                url: "https://example.com/final".into(),
                markdown: markdown.clone(),
                cache: Some(WebCacheEntry {
                    url: location.into(),
                    file_path: "C:/Users/test/.cursor-byok-v3/cache/web/page.txt".into(),
                    size_bytes: markdown.len() as i64,
                    line_count: 1,
                }),
            }),
        )
        .unwrap();

        assert!(completion.result().content.starts_with(&format!(
            "<system_reminder>Web content has been downloaded to: {location}."
        )));
        assert!(completion.result().content.contains("[truncated: WebFetch"));
        let Some(pb::tool_call::Tool::WebFetchToolCall(tool)) =
            completion.tool_call().tool.as_ref()
        else {
            panic!("expected WebFetchToolCall")
        };
        let Some(pb::web_fetch_result::Result::Success(success)) = tool
            .result
            .as_ref()
            .and_then(|result| result.result.as_ref())
        else {
            panic!("expected WebFetchSuccess")
        };
        assert!(success.markdown.len() <= 32 * 1024);
        assert!(success.markdown.contains("[truncated: WebFetch"));
        assert_eq!(
            success
                .output_location
                .as_ref()
                .map(|location| location.file_path.as_str()),
            Some("C:/Users/test/.cursor-byok-v3/cache/web/page.txt")
        );
    }

    fn pending_fetch() -> PendingInteraction {
        PendingInteraction {
            call: ToolCall {
                index: 0,
                call_id: "fetch-call".into(),
                model_call_id: "model-call".into(),
                name: "WebFetch".into(),
                arguments_text: r#"{"url":"https://example.com"}"#.into(),
                arguments: json!({"url": "https://example.com"}),
                argument_error: None,
            },
            started_at_ms: 1,
        }
    }
}
