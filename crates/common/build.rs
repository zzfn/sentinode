use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 使用内置的 protoc，免去本机/CI 手动安装
    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    unsafe {
        std::env::set_var("PROTOC", protoc);
    }

    let proto_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../proto")
        .canonicalize()?;
    let proto_file = proto_root.join("sentinode.proto");

    tonic_prost_build::compile_protos(proto_file)?;

    println!("cargo:rerun-if-changed=../../proto/sentinode.proto");
    Ok(())
}
