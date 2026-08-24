#[unsafe(no_mangle)]
/// # Safety
///
/// The returned pointer is owned by the statically linked test grammar and must
/// be consumed only through the compatible Tree-sitter C API.
pub unsafe extern "C" fn tree_sitter_diffuse_test_json() -> *const () {
    unsafe { (tree_sitter_json::LANGUAGE.into_raw())() }
}
