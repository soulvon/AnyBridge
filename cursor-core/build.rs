//! Generates Cursor protobuf bindings and validates captured wire contracts.
use std::{env, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let proto_dir = manifest.join("protocols/cursor");
    let protos = [proto_dir.join("agent_v1.proto")];
    let aiserver_proto = proto_dir.join("aiserver_v1.proto");

    env::set_var(
        "PROTOC",
        protoc_bin_vendored::protoc_bin_path().expect("vendored protoc"),
    );

    prost_build::Config::new()
        .compile_protos(
            &protos,
            &[
                proto_dir.clone(),
                protoc_bin_vendored::include_path().expect("vendored protobuf includes"),
            ],
        )
        .expect("compile Cursor protobuf schema");

    for proto in protos {
        println!("cargo:rerun-if-changed={}", proto.display());
    }
    let aiserver_source = std::fs::read_to_string(&aiserver_proto).expect("read aiserver_v1.proto");
    for required in [
        "message BidiAppendRequest",
        "string data = 1;",
        "BidiRequestId request_id = 2;",
        "int64 append_seqno = 3;",
        "bytes data_binary = 4;",
        "message BidiAppendResponse",
        "message CustomErrorDetails",
        "optional bool is_retryable = 4;",
        "optional bool show_request_id = 5;",
        "optional bool should_show_immediate_error = 6;",
        "message ErrorDetails",
        "ERROR_PROVIDER_ERROR = 57;",
        "CustomErrorDetails details = 2;",
        "optional bool is_expected = 3;",
    ] {
        assert!(
            aiserver_source.contains(required),
            "aiserver Bidi wire schema changed: missing {required}"
        );
    }
    // The extracted aiserver file currently contains unrelated duplicate message names, so
    // compiling that entire package would generate invalid Rust. `cursor/proto.rs` defines only
    // the validated Bidi and ErrorDetails wire subsets; agent_v1.proto remains fully generated.
    println!("cargo:rerun-if-changed={}", aiserver_proto.display());
}
