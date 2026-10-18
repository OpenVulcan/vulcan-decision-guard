//! Location of the per-user service endpoint and data directory.

use std::io;
use std::path::PathBuf;

use interprocess::local_socket::{GenericFilePath, Name, prelude::*};

/// Directory name under the user's home that holds service state.
const DATA_DIR_NAME: &str = ".vulcan-decision";

/// Returns the per-user data directory, creating it with owner-only access.
pub fn data_dir() -> io::Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory is unknown"))?;
    let dir = home.join(DATA_DIR_NAME);
    create_private_dir(&dir)?;
    Ok(dir)
}

/// Returns the path of the local endpoint every client connects to and the service listens on.
///
/// This is the only definition of the endpoint location; clients in other languages read it
/// from `vulcan-decision endpoint`. Windows uses a named pipe that includes the user name. Unix
/// uses a socket file inside the owner-only data directory, because abstract sockets carry no
/// access control.
pub fn endpoint_path() -> io::Result<String> {
    if cfg!(windows) {
        let user = std::env::var("USERNAME").unwrap_or_default();
        let user: String = user
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        Ok(format!(r"\\.\pipe\vulcan-decision-{user}.sock"))
    } else {
        let dir = data_dir()?.join("run");
        create_private_dir(&dir)?;
        dir.join("serve.sock")
            .into_os_string()
            .into_string()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "endpoint path is not UTF-8"))
    }
}

/// Returns [`endpoint_path`] as a local socket name.
pub fn endpoint_name() -> io::Result<Name<'static>> {
    endpoint_path()?.to_fs_name::<GenericFilePath>()
}

#[cfg(unix)]
fn create_private_dir(dir: &std::path::Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn create_private_dir(dir: &std::path::Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)
}
