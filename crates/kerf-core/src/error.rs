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
    #[error("the angle has no footage there")]
    NoFootage,
    #[error("cannot unnest: {0:?}")]
    CannotUnnest(UnnestBlock),
    #[error("invalid value: {0}")]
    Invalid(String),
}

/// Why a nested clip cannot be unnested without changing what it shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnnestBlock {
    /// The clip does not show a sequence.
    NotNested,
    /// The nested sequence has another frame rate or picture size.
    Settings,
    /// The nested clip changes its sequence (speed, keys, effects, fades,
    /// transitions, transform, opacity, colour or sound).
    ClipChanged,
    /// A track involved is hidden, muted, solo, not at 0 dB or has effects.
    TrackMix,
    /// The clip's range cuts into a transition or fade of the sequence.
    Edge,
    /// A clip of the sequence uses a blend mode other than normal.
    BlendMode,
}

pub type Result<T> = std::result::Result<T, EditError>;
