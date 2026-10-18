//! Decision backends. The cloud and local backends plug in here.

use decision_core::{JudgeRequest, Verdict};

/// Judges one call. Without a configured backend every call is denied.
pub fn judge(_call: &JudgeRequest) -> Verdict {
    Verdict::Deny {
        reason: String::from(
            "Vulcan Decision has no decision backend configured yet; sign in or install a model",
        ),
    }
}
