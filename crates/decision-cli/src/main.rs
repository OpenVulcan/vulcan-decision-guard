//! `vulcan-decision`: the resident judge service and its management commands.
//!
//! - `serve` keeps the model and account session loaded and answers judge requests. It is a
//!   per-user singleton shared by every host plugin, so no tool call pays a model load.
//! - `ensure` starts `serve` when it is not running and waits until it answers.
//! - `endpoint` prints the endpoint and contract for host plugins, such as the dsh plugin,
//!   which connect to `serve` directly and keep one connection open.

mod client;
mod judge;
mod serve;

use std::process::ExitCode;

const USAGE: &str = "usage: vulcan-decision <serve | ensure | endpoint | status | stop>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["serve"] => serve::run(),
        ["ensure"] => match client::ensure() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("vulcan-decision: {error}");
                ExitCode::FAILURE
            }
        },
        ["endpoint"] => match decision_core::endpoint_path() {
            Ok(endpoint) => {
                let description = serde_json::json!({
                    "endpoint": endpoint,
                    "contract": decision_core::CONTRACT_VERSION,
                    "version": env!("CARGO_PKG_VERSION"),
                });
                println!("{description}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("vulcan-decision: {error}");
                ExitCode::FAILURE
            }
        },
        ["status"] => client::status(),
        ["stop"] => client::stop(),
        ["--version"] => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
