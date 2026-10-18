//! The resident service: one per user, shared by every host.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::BufReader;
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use decision_core::{
    CONTRACT_VERSION, FrameError, Request, Response, data_dir, endpoint_name, read_frame,
    write_frame,
};
use interprocess::local_socket::{ListenerOptions, Stream, prelude::*};

use crate::judge;

/// The service exits after this long with no open connection and no request; the next call
/// starts it again. A resident host plugin keeps one connection open, which keeps it alive.
const IDLE_SHUTDOWN: Duration = Duration::from_secs(30 * 60);
/// How often the idle watcher checks the last activity.
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// Liveness state the idle watcher reads.
struct Activity {
    last: Mutex<Instant>,
    open_connections: AtomicUsize,
}

impl Activity {
    fn touch(&self) {
        if let Ok(mut last) = self.last.lock() {
            *last = Instant::now();
        }
    }
}

/// Counts one open connection for as long as it lives.
struct OpenConnection<'a>(&'a Activity);

impl<'a> OpenConnection<'a> {
    fn new(activity: &'a Activity) -> Self {
        activity.open_connections.fetch_add(1, Ordering::SeqCst);
        Self(activity)
    }
}

impl Drop for OpenConnection<'_> {
    fn drop(&mut self) {
        self.0.touch();
        self.0.open_connections.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn run() -> ExitCode {
    // Holding this lock for the whole process makes the service a per-user singleton.
    let _lock = match acquire_lock() {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            eprintln!("vulcan-decision: service is already running");
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            eprintln!("vulcan-decision: cannot lock the service: {error}");
            return ExitCode::FAILURE;
        }
    };
    let listener = match endpoint_name().and_then(|name| {
        // The lock guarantees no live service owns the name, so a leftover socket is stale.
        ListenerOptions::new()
            .name(name)
            .try_overwrite(true)
            .create_sync()
    }) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("vulcan-decision: cannot listen: {error}");
            return ExitCode::FAILURE;
        }
    };

    let activity = Arc::new(Activity {
        last: Mutex::new(Instant::now()),
        open_connections: AtomicUsize::new(0),
    });
    spawn_idle_watcher(Arc::clone(&activity));
    for connection in listener.incoming() {
        match connection {
            Ok(stream) => {
                let activity = Arc::clone(&activity);
                std::thread::spawn(move || serve_connection(stream, &activity));
            }
            Err(error) => eprintln!("vulcan-decision: incoming connection failed: {error}"),
        }
    }
    ExitCode::SUCCESS
}

/// Returns the held lock, or `None` when another service holds it.
fn acquire_lock() -> std::io::Result<Option<File>> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir()?.join("serve.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

fn spawn_idle_watcher(activity: Arc<Activity>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(IDLE_CHECK_INTERVAL);
            if activity.open_connections.load(Ordering::SeqCst) > 0 {
                continue;
            }
            let idle = activity
                .last
                .lock()
                .map(|instant| instant.elapsed())
                .unwrap_or_default();
            if idle >= IDLE_SHUTDOWN {
                std::process::exit(0);
            }
        }
    });
}

fn serve_connection(stream: Stream, activity: &Activity) {
    let _open = OpenConnection::new(activity);
    let mut reader = BufReader::new(stream);
    loop {
        let request = match read_frame::<Request>(&mut reader) {
            Ok(request) => request,
            Err(FrameError::Closed) => return,
            Err(error) => {
                let _ = write_frame(
                    reader.get_mut(),
                    &Response::Error {
                        message: error.to_string(),
                    },
                );
                return;
            }
        };
        activity.touch();
        let shutting_down = request == Request::Shutdown;
        let response = respond(request);
        if write_frame(reader.get_mut(), &response).is_err() {
            return;
        }
        if shutting_down {
            std::process::exit(0);
        }
    }
}

fn respond(request: Request) -> Response {
    match request {
        Request::Ping { .. } => Response::Pong {
            contract: CONTRACT_VERSION,
            version: String::from(env!("CARGO_PKG_VERSION")),
        },
        Request::Judge { contract, call } if contract == CONTRACT_VERSION => Response::Verdict {
            verdict: judge::judge(&call),
        },
        Request::Judge { .. } => Response::ContractMismatch {
            contract: CONTRACT_VERSION,
        },
        Request::Shutdown => Response::ShuttingDown,
    }
}
