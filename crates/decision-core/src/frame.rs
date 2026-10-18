//! Newline-delimited JSON framing with a hard size limit.

use std::io::{self, BufRead, Write};

use serde::Serialize;
use serde::de::DeserializeOwned;

/// Largest accepted frame. Tool arguments can carry whole files, so this is generous; a larger
/// call cannot be judged and is denied by the client.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Why a frame could not be read.
#[derive(Debug)]
pub enum FrameError {
    /// The peer closed the connection before a complete frame.
    Closed,
    /// The frame exceeded [`MAX_FRAME_BYTES`].
    TooLarge,
    /// The transport failed.
    Io(io::Error),
    /// The frame was not the expected JSON message.
    Json(serde_json::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => f.write_str("connection closed before a complete frame"),
            Self::TooLarge => write!(f, "frame exceeds {MAX_FRAME_BYTES} bytes"),
            Self::Io(error) => write!(f, "transport error: {error}"),
            Self::Json(error) => write!(f, "malformed frame: {error}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// Reads one newline-terminated JSON frame.
pub fn read_frame<T: DeserializeOwned>(reader: &mut impl BufRead) -> Result<T, FrameError> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(FrameError::Io)?;
        if available.is_empty() {
            return Err(FrameError::Closed);
        }
        let (chunk, done) = match available.iter().position(|byte| *byte == b'\n') {
            Some(end) => (&available[..end], true),
            None => (available, false),
        };
        if line.len() + chunk.len() > MAX_FRAME_BYTES {
            return Err(FrameError::TooLarge);
        }
        line.extend_from_slice(chunk);
        let consumed = chunk.len() + usize::from(done);
        reader.consume(consumed);
        if done {
            return serde_json::from_slice(&line).map_err(FrameError::Json);
        }
    }
}

/// Writes one JSON frame followed by a newline and flushes it.
pub fn write_frame<T: Serialize>(writer: &mut impl Write, message: &T) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(message).map_err(io::Error::other)?;
    bytes.push(b'\n');
    writer.write_all(&bytes)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CONTRACT_VERSION, Request};
    use std::io::Cursor;

    #[test]
    fn frames_round_trip_back_to_back() {
        let mut wire = Vec::new();
        write_frame(
            &mut wire,
            &Request::Ping {
                contract: CONTRACT_VERSION,
            },
        )
        .expect("write");
        write_frame(&mut wire, &Request::Shutdown).expect("write");
        let mut reader = Cursor::new(wire);
        let first: Request = read_frame(&mut reader).expect("first");
        let second: Request = read_frame(&mut reader).expect("second");
        assert_eq!(
            first,
            Request::Ping {
                contract: CONTRACT_VERSION
            }
        );
        assert_eq!(second, Request::Shutdown);
        assert!(matches!(
            read_frame::<Request>(&mut reader),
            Err(FrameError::Closed)
        ));
    }

    #[test]
    fn oversized_frames_are_rejected_without_buffering_them_whole() {
        let mut reader = Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 1]);
        assert!(matches!(
            read_frame::<Request>(&mut reader),
            Err(FrameError::TooLarge)
        ));
    }
}
