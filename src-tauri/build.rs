// Copies the editor's own files (the page, its style sheet and its scripts) next to the build
// output, where the program embeds them. Nothing else in the repository goes into the program.
use std::{env, fs, io, path::Path};

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("the editor folder");
    let web = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).join("web");
    let _ = fs::remove_dir_all(&web);
    fs::create_dir_all(&web).expect("create the web folder");
    for file in ["index.html", "style.css"] {
        fs::copy(root.join(file), web.join(file)).unwrap_or_else(|e| panic!("copy {file}: {e}"));
        println!("cargo:rerun-if-changed={}", root.join(file).display());
    }
    copy_dir(&root.join("js"), &web.join("js")).expect("copy the scripts");
    println!("cargo:rerun-if-changed={}", root.join("js").display());
    tauri_build::build()
}
