//! Wire contract shared by the resident `vulcan-decision serve` process and every host client.
//!
//! Host plugins never load a model or open an account session themselves. They send one
//! [`JudgeRequest`] per tool call over a per-user local endpoint to the resident service and map
//! the returned [`Verdict`] to their host's decision format. Anything that prevents a verdict from
//! arriving must be treated as a denial by the client.

pub mod endpoint;
pub mod frame;
pub mod protocol;

pub use endpoint::{data_dir, endpoint_name, endpoint_path};
pub use frame::{FrameError, MAX_FRAME_BYTES, read_frame, write_frame};
pub use protocol::{CONTRACT_VERSION, Host, JudgeRequest, Request, Response, Verdict};
