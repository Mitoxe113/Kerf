use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum EditError {
    #[error("sequence not found")]
    SequenceNotFound,
    #[error("track not found")]
    TrackNotFound,
    #[error("clip not found")]
    ClipNotFound,
    #[error("media not found")]
    MediaNotFound,
    #[error("bin not found")]
    BinNotFound,
    #[error("marker not found")]
    MarkerNotFound,
    #[error("track is locked")]
    TrackLocked,
    #[error("media is not ready yet")]
    MediaNotReady,
    #[error("media is still used by {0} clip(s)")]
    MediaInUse(usize),
    #[error("clip kind does not match the target track")]
    TrackKindMismatch,
    #[error("target track does not exist")]
    TrackOutOfRange,
    #[error("no adjacent clip for this edit")]
    NoNeighbor,
    #[error("cannot remove the last sequence")]
    LastSequence,
    #[error("a sequence cannot contain itself")]
    NestCycle,
    #[error("the sequence is nested in {0} clip(s)")]
    SequenceInUse(usize),
    #[error("invalid value: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, EditError>;
