//! Errors of the control-side API (the C++ engine throws `std::invalid_argument` / `runtime_error`
//! for the same conditions). Never produced on the audio thread.

use alloc::string::String;
use core::fmt;

/// Why a plan, patch or asset was refused. The running graph is unchanged when this is returned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    message: String,
}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// `require(condition, message)` of engine.cpp.
pub(crate) fn require(condition: bool, message: &str) -> Result<(), Error> {
    if condition { Ok(()) } else { Err(Error::new(message)) }
}
