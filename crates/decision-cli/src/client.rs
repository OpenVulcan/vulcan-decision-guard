//! Client side of the local endpoint: one exchange per connection, plus service start-up.

use std::io::BufReader;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use decision_core::{CONTRACT_VERSION, Request, Response, endpoint_name, read_frame, write_frame};
use interprocess::local_socket::{Stream, prelude::*};

/// Longest wait for a freshly started service to answer, including a model load.
pub const ENSURE_TIMEOUT: Duration = Duration::from_secs(10);
/// Pause between connection attempts while waiting for the service.
const RETRY_INTERVAL: Duration = Duration::from_millis(50);

/// Sends one request and reads its response.
pub fn exchange(request: &Request) -> Result<Response, String> {
    let name = endpoint_name().map_err(|error| format!("endpoint unavailable: {error}"))?;
    let stream = Stream::connect(name).map_err(|error| format!("service unreachable: {error}"))?;
    let mut reader = BufReader::new(stream);
    write_frame(reader.get_mut(), request).map_err(|error| format!("send failed: {error}"))?;
    read_frame(&mut reader).map_err(|error| format!("receive failed: {error}"))
}

/// Makes sure a service speaking this client's contract is running, starting it when needed.
pub fn ensure() -> Result<(), String> {
    match ping() {
        Ok(Response::Pong { contract, .. }) if contract == CONTRACT_VERSION => return Ok(()),
        Ok(_) => replace_outdated_service()?,
        Err(_) => {}
    }
    start_service()?;
    let deadline = Instant::now() + ENSURE_TIMEOUT;
    loop {
        match ping() {
            Ok(Response::Pong { contract, .. }) if contract == CONTRACT_VERSION => return Ok(()),
            Ok(other) => return Err(format!("service answered {other:?}")),
            Err(error) if Instant::now() >= deadline => {
                return Err(format!("service did not start in time: {error}"));
            }
            Err(_) => std::thread::sleep(RETRY_INTERVAL),
        }
    }
}

fn ping() -> Result<Response, String> {
    exchange(&Request::Ping {
        contract: CONTRACT_VERSION,
    })
}

/// Stops a service from another version and waits until it no longer answers.
fn replace_outdated_service() -> Result<(), String> {
    let _ = exchange(&Request::Shutdown);
    let deadline = Instant::now() + ENSURE_TIMEOUT;
    while ping().is_ok() {
        if Instant::now() >= deadline {
            return Err(String::from("outdated service did not stop"));
        }
        std::thread::sleep(RETRY_INTERVAL);
    }
    Ok(())
}

/// Starts `serve` from this executable, fully detached so the host does not wait on it.
fn start_service() -> Result<(), String> {
    let exe =
        std::env::current_exe().map_err(|error| format!("cannot locate executable: {error}"))?;
    let mut command = Command::new(exe);
    command
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut command);
    command
        .spawn()
        .map(drop)
        .map_err(|error| format!("cannot start service: {error}"))
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    stop_inheriting_std_handles();
}

/// Marks this process's standard handles non-inheritable.
///
/// Windows passes every inheritable handle to a child even when its stdio is redirected. A host
/// plugin reads `ensure`'s stdout through a pipe until end of file, so a service that inherited
/// that pipe would keep the plugin waiting for as long as the service lives.
#[cfg(windows)]
#[allow(unsafe_code)]
fn stop_inheriting_std_handles() {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};
    let handles = [
        std::io::stdin().as_raw_handle(),
        std::io::stdout().as_raw_handle(),
        std::io::stderr().as_raw_handle(),
    ];
    for handle in handles {
        if !handle.is_null() {
            // SAFETY: the handle is this process's own standard handle, valid for its lifetime;
            // clearing the inherit flag does not change how this process uses it.
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
        }
    }
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

pub fn status() -> ExitCode {
    match ping() {
        Ok(Response::Pong { contract, version }) => {
            println!("running: version {version}, contract {contract}");
            ExitCode::SUCCESS
        }
        Ok(other) => {
            println!("unexpected answer: {other:?}");
            ExitCode::FAILURE
        }
        Err(error) => {
            println!("not running: {error}");
            ExitCode::FAILURE
        }
    }
}

pub fn stop() -> ExitCode {
    match exchange(&Request::Shutdown) {
        Ok(_) => ExitCode::SUCCESS,
        Err(error) => {
            println!("not running: {error}");
            ExitCode::SUCCESS
        }
    }
}
