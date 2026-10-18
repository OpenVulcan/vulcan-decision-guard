//! Request and response messages exchanged over the local endpoint.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Version of the client/service contract. Bump it on any incompatible message change.
///
/// A service that receives a different version answers [`Response::ContractMismatch`]; the client
/// then stops it with [`Request::Shutdown`] and starts the service shipped next to itself.
pub const CONTRACT_VERSION: u32 = 1;

/// The coding host a tool call comes from; it selects host-specific rules on the service side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Host {
    /// DeepSeek harness, through the dsh plugin.
    Dsh,
}

/// One tool call to judge before it runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JudgeRequest {
    /// Host that is about to run the call.
    pub host: Host,
    /// Host session identifier, when the host provides one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Working directory the call runs in, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Tool name exactly as the host reports it.
    pub tool: String,
    /// Tool arguments exactly as the host reports them.
    pub arguments: Value,
}

/// A request sent by a client. Every line on the wire is one request or one response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// Liveness and version probe.
    Ping {
        /// The client's [`CONTRACT_VERSION`].
        contract: u32,
    },
    /// Judge one tool call.
    Judge {
        /// The client's [`CONTRACT_VERSION`].
        contract: u32,
        /// The call to judge.
        call: JudgeRequest,
    },
    /// Stop the service. Accepted regardless of contract version so upgrades can replace it.
    Shutdown,
}

/// The service's answer to one [`Request`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    /// Answer to [`Request::Ping`].
    Pong {
        /// The service's [`CONTRACT_VERSION`].
        contract: u32,
        /// The service's package version.
        version: String,
    },
    /// Answer to [`Request::Judge`].
    Verdict {
        /// The decision for the call.
        verdict: Verdict,
    },
    /// The request carried a contract version the service does not speak.
    ContractMismatch {
        /// The service's [`CONTRACT_VERSION`].
        contract: u32,
    },
    /// Answer to [`Request::Shutdown`]; the service exits after sending it.
    ShuttingDown,
    /// The request could not be processed. Clients treat it as a denial.
    Error {
        /// English diagnostic.
        message: String,
    },
}

/// Final decision for one tool call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum Verdict {
    /// Run the call.
    Allow,
    /// Do not run the call.
    Deny {
        /// English reason returned to the model.
        reason: String,
    },
    /// Ask the user; hosts that cannot ask treat this as [`Verdict::Deny`].
    Ask {
        /// English reason shown with the question.
        reason: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requests_round_trip_with_their_wire_tags() {
        let request = Request::Judge {
            contract: CONTRACT_VERSION,
            call: JudgeRequest {
                host: Host::Dsh,
                session_id: None,
                cwd: Some(String::from("/w")),
                tool: String::from("Bash"),
                arguments: json!({"command": "ls"}),
            },
        };
        let wire = serde_json::to_value(&request).expect("serialize");
        assert_eq!(wire["type"], "judge");
        assert_eq!(wire["call"]["host"], "dsh");
        assert!(wire["call"].get("session_id").is_none());
        let back: Request = serde_json::from_value(wire).expect("deserialize");
        assert_eq!(back, request);
    }

    #[test]
    fn shutdown_carries_no_contract_so_any_version_can_stop_the_service() {
        let wire = serde_json::to_value(Request::Shutdown).expect("serialize");
        assert_eq!(wire, json!({"type": "shutdown"}));
    }
}
