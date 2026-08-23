use std::process::Command;

use diffuse_core::VERSION;

#[test]
fn version_commands_match_the_product_version() {
    for argument in ["version", "--version"] {
        let output = Command::new(env!("CARGO_BIN_EXE_diffuse"))
            .arg(argument)
            .output()
            .expect("run diffuse CLI");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("diffuse {VERSION}\n")
        );
        assert!(output.stderr.is_empty());
    }
}
