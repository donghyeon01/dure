//! Where the running app bundle lives on macOS.
//!
//! LaunchServices registers every `.app` copy that carries this bundle
//! identifier. A copy retained for rollback under App Backups can therefore be
//! launched by bundle id; it must not claim the app channel or republish the
//! shared descriptor and hook scripts that point into its own bundle. The
//! bundled CLI bootstrap renames idle retained copies to `.app-backup` so
//! LaunchServices no longer treats them as applications
//! (`cli/lib/retained-app-backups.mjs`).

use std::path::{Path, PathBuf};

const RETAINED_APP_BACKUPS: [&str; 4] = ["Library", "Application Support", "Dure", "App Backups"];

pub(crate) fn retained_app_backups_root(home: &Path) -> PathBuf {
    RETAINED_APP_BACKUPS
        .iter()
        .fold(home.to_path_buf(), |path, component| path.join(component))
}

/// The innermost `.app` (or inert `.app-backup`) directory that holds
/// `executable` under its `Contents` directory.
pub(crate) fn enclosing_app_bundle(executable: &Path) -> Option<&Path> {
    executable.ancestors().skip(1).find(|ancestor| {
        let bundle_name = ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_ascii_lowercase)
            .is_some_and(|name| name.ends_with(".app") || name.ends_with(".app-backup"));
        bundle_name
            && executable
                .strip_prefix(ancestor)
                .is_ok_and(|inside| inside.starts_with("Contents"))
    })
}

/// Whether `executable` runs from inside the retained app-backups folder,
/// compared both as given and after resolving symlinks.
pub(crate) fn is_retained_app_backup(executable: &Path, home: &Path) -> bool {
    let root = retained_app_backups_root(home);
    if executable.starts_with(&root) {
        return true;
    }
    match (root.canonicalize(), executable.canonicalize()) {
        (Ok(root), Ok(executable)) => executable.starts_with(root),
        _ => false,
    }
}

/// The running executable when it is a retained backup copy.
pub(crate) fn running_retained_app_backup() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let home = dirs::home_dir()?;
    is_retained_app_backup(&executable, &home).then_some(executable)
}

/// The bundle that holds this process's macOS privacy permissions.
pub(crate) fn running_app_bundle() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let executable = executable.canonicalize().unwrap_or(executable);
    enclosing_app_bundle(&executable).map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_retained_backup_executable_is_recognized_under_the_backup_folder() {
        let home = Path::new("/Users/fixture");
        let backup = retained_app_backups_root(home)
            .join("Dure-0.2.39-10b6a2f25ee5-20260927.app/Contents/MacOS/dure");
        assert!(is_retained_app_backup(&backup, home));
        assert!(!is_retained_app_backup(
            Path::new("/Applications/Dure.app/Contents/MacOS/dure"),
            home,
        ));
        // Component-wise: a sibling folder sharing the prefix is not a backup.
        assert!(!is_retained_app_backup(
            Path::new("/Users/fixture/Library/Application Support/Dure/App Backups Old/Dure.app/Contents/MacOS/dure"),
            home,
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_home_still_identifies_the_retained_backup() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let executable = retained_app_backups_root(&home).join("Dure-0.2.39.app/Contents/MacOS");
        std::fs::create_dir_all(&executable).unwrap();
        let executable = executable.join("dure");
        std::fs::write(&executable, b"fixture").unwrap();
        let linked_home = root.path().join("linked-home");
        std::os::unix::fs::symlink(&home, &linked_home).unwrap();
        let through_link =
            retained_app_backups_root(&linked_home).join("Dure-0.2.39.app/Contents/MacOS/dure");
        assert!(is_retained_app_backup(&through_link, &home));
        assert!(is_retained_app_backup(&executable, &linked_home));
    }

    #[test]
    fn the_enclosing_bundle_is_the_directory_that_owns_contents() {
        assert_eq!(
            enclosing_app_bundle(Path::new("/Applications/Dure.app/Contents/MacOS/dure")),
            Some(Path::new("/Applications/Dure.app")),
        );
        assert_eq!(
            enclosing_app_bundle(Path::new(
                "/Users/fixture/Library/Application Support/Dure/App Backups/Dure-0.2.39.app-backup/Contents/MacOS/dure",
            )),
            Some(Path::new(
                "/Users/fixture/Library/Application Support/Dure/App Backups/Dure-0.2.39.app-backup",
            )),
        );
        assert_eq!(
            enclosing_app_bundle(Path::new("/tmp/target/debug/dure")),
            None
        );
        assert_eq!(
            enclosing_app_bundle(Path::new("/tmp/Dure.app/MacOS/dure")),
            None,
        );
    }
}
