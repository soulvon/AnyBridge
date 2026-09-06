//! Includes generated Cursor protobuf types.
pub mod agent {
    #[allow(clippy::large_enum_variant)]
    pub mod v1 {
        include!(concat!(env!("OUT_DIR"), "/agent.v1.rs"));
    }
}

pub mod aiserver {
    pub mod v1 {
        #[derive(Clone, PartialEq, ::prost::Message)]
        pub struct BidiRequestId {
            #[prost(string, tag = "1")]
            pub request_id: String,
        }

        #[derive(Clone, PartialEq, ::prost::Message)]
        pub struct BidiAppendRequest {
            #[prost(string, tag = "1")]
            pub data: String,
            #[prost(message, optional, tag = "2")]
            pub request_id: Option<BidiRequestId>,
            #[prost(int64, tag = "3")]
            pub append_seqno: i64,
            #[prost(bytes = "vec", tag = "4")]
            pub data_binary: Vec<u8>,
        }

        /// Commit message generation request. Only the fields the local
        /// generator consumes are decoded; credentials and heavyweight context
        /// fields are intentionally left to prost's unknown-field skipping.
        #[derive(Clone, PartialEq, ::prost::Message)]
        pub struct WriteGitCommitMessageRequest {
            #[prost(string, repeated, tag = "1")]
            pub diffs: Vec<String>,
            #[prost(string, repeated, tag = "2")]
            pub previous_commit_messages: Vec<String>,
            #[prost(message, optional, tag = "3")]
            pub explicit_context: Option<ExplicitContext>,
        }

        #[derive(Clone, PartialEq, ::prost::Message)]
        pub struct ExplicitContext {
            #[prost(string, tag = "1")]
            pub context: String,
            #[prost(string, optional, tag = "2")]
            pub repo_context: Option<String>,
        }

        #[derive(Clone, PartialEq, ::prost::Message)]
        pub struct WriteGitCommitMessageResponse {
            #[prost(string, tag = "1")]
            pub commit_message: String,
        }

        #[derive(Clone, Copy, PartialEq, ::prost::Message)]
        pub struct BidiAppendResponse {}

        /// `NetworkService/IsConnected` reply. The Cursor extension probes this
        /// ~10s after any slow request starts; a non-OK result is treated as
        /// "network disconnected" and aborts in-flight work (e.g. commit message
        /// generation) even while the model is still streaming, so it always
        /// answers as connected.
        #[derive(Clone, Copy, PartialEq, ::prost::Message)]
        pub struct IsConnectedResponse {}

        #[derive(Clone, PartialEq, ::prost::Message)]
        pub struct CustomErrorDetails {
            #[prost(string, tag = "1")]
            pub title: String,
            #[prost(string, tag = "2")]
            pub detail: String,
            #[prost(bool, optional, tag = "3")]
            pub allow_command_links_potentially_unsafe_please_only_use_for_handwritten_trusted_markdown:
                Option<bool>,
            #[prost(bool, optional, tag = "4")]
            pub is_retryable: Option<bool>,
            #[prost(bool, optional, tag = "5")]
            pub show_request_id: Option<bool>,
            #[prost(bool, optional, tag = "6")]
            pub should_show_immediate_error: Option<bool>,
        }

        #[derive(Clone, PartialEq, ::prost::Message)]
        pub struct ErrorDetails {
            #[prost(enumeration = "error_details::Error", tag = "1")]
            pub error: i32,
            #[prost(message, optional, tag = "2")]
            pub details: Option<CustomErrorDetails>,
            #[prost(bool, optional, tag = "3")]
            pub is_expected: Option<bool>,
        }

        pub mod error_details {
            #[derive(
                Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, ::prost::Enumeration,
            )]
            #[repr(i32)]
            pub enum Error {
                Unspecified = 0,
                CustomMessage = 29,
                ProviderError = 57,
                Internal = 59,
            }
        }
    }
}
