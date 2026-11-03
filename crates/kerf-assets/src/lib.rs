//! Media providers (search through their official APIs), checked downloads
//! into Kerf's asset folder, and attribution reports.
//!
//! Safety rules this crate enforces:
//! - Requests only go to the provider API endpoints defined in [`Provider`].
//! - Files are only downloaded from URLs that an API response returned (the
//!   caller passes a [`RemoteAsset`] it got from [`net::Net::search`], never a
//!   URL typed by the user), over HTTPS, from the provider's file hosts
//!   (redirects included), with size and content-type limits.
//! - Downloads are written to a temporary file and renamed when complete;
//!   nothing downloaded is executed or unpacked.
//! - License data is what the provider states; `commercial` is "yes" only
//!   when that license allows commercial use, "unknown" when it is not stated.

pub mod license;
pub mod net;
pub mod parse;
pub mod report;

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum AssetError {
    #[error("{0}")]
    Invalid(String),
    #[error("Netzwerkfehler: {0}")]
    Network(String),
    #[error("Der Anbieter antwortete mit HTTP {status}: {detail}")]
    Http { status: u16, detail: String },
    #[error("Für {0} ist kein API-Schlüssel hinterlegt")]
    MissingKey(&'static str),
    #[error("Zu viele Anfragen an {0}; bitte kurz warten")]
    RateLimited(&'static str),
    #[error("Download abgelehnt: {0}")]
    Refused(String),
    #[error("Abgebrochen")]
    Cancelled,
    #[error("Dateifehler: {0}")]
    Io(String),
}

pub type Result<T> = std::result::Result<T, AssetError>;

pub(crate) fn invalid(s: impl Into<String>) -> AssetError {
    AssetError::Invalid(s.into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Pexels,
    Giphy,
    Freesound,
    Openverse,
}

/// What a search looks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchKind {
    Photo,
    Video,
    Gif,
    Audio,
}

impl Provider {
    pub const ALL: [Provider; 4] = [Provider::Pexels, Provider::Giphy, Provider::Freesound, Provider::Openverse];

    pub fn id(self) -> &'static str {
        match self {
            Provider::Pexels => "pexels",
            Provider::Giphy => "giphy",
            Provider::Freesound => "freesound",
            Provider::Openverse => "openverse",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Provider::Pexels => "Pexels",
            Provider::Giphy => "GIPHY",
            Provider::Freesound => "Freesound",
            Provider::Openverse => "Openverse",
        }
    }

    pub fn from_id(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.id() == s)
    }

    /// Whether the API needs a key from the user (Openverse works anonymously).
    pub fn needs_key(self) -> bool {
        !matches!(self, Provider::Openverse)
    }

    pub fn kinds(self) -> &'static [SearchKind] {
        match self {
            Provider::Pexels => &[SearchKind::Photo, SearchKind::Video],
            Provider::Giphy => &[SearchKind::Gif],
            Provider::Freesound => &[SearchKind::Audio],
            Provider::Openverse => &[SearchKind::Photo, SearchKind::Audio],
        }
    }

    /// Default API base (overridable for tests).
    pub fn api_base(self) -> &'static str {
        match self {
            Provider::Pexels => "https://api.pexels.com",
            Provider::Giphy => "https://api.giphy.com",
            Provider::Freesound => "https://freesound.org",
            Provider::Openverse => "https://api.openverse.org",
        }
    }

    /// Hosts (and their subdomains) files may come from; `None` means the
    /// file is hosted by the original source the API names (Openverse
    /// indexes other sites), so any HTTPS host in the API's own result.
    pub fn file_hosts(self) -> Option<&'static [&'static str]> {
        match self {
            Provider::Pexels => Some(&["pexels.com"]),
            Provider::Giphy => Some(&["giphy.com"]),
            Provider::Freesound => Some(&["freesound.org"]),
            Provider::Openverse => None,
        }
    }

    /// Where the user gets an API key.
    pub fn key_url(self) -> &'static str {
        match self {
            Provider::Pexels => "https://www.pexels.com/api/",
            Provider::Giphy => "https://developers.giphy.com/",
            Provider::Freesound => "https://freesound.org/apiv2/apply/",
            Provider::Openverse => "https://api.openverse.org/v1/",
        }
    }
}

/// One file of a result (renditions differ in size).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteFile {
    pub url: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    /// As stated by the API ("" when not stated; checked again on download).
    pub mime: String,
    /// Bytes as stated by the API (0 = unknown).
    pub size: u64,
}

/// License data as the provider states it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct License {
    /// Short code, e.g. "cc0", "by", "by-nc", "pexels", "giphy".
    pub code: String,
    pub name: String,
    pub url: String,
    /// "yes", "no" or "unknown".
    pub commercial: String,
    /// "yes", "no" or "unknown" (No-Derivatives licenses say "no").
    pub modification: String,
    pub attribution_required: bool,
    /// Credit line to use (empty when none is needed and none was given).
    pub attribution: String,
    /// Restrictions and hints shown next to the license.
    pub notes: String,
}

/// A search result. Only the backend creates these; downloads take one back.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteAsset {
    pub provider: String,
    pub provider_id: String,
    /// Library asset kind: "photo", "video", "gif", "audio" or "sfx".
    pub kind: String,
    pub title: String,
    pub creator: String,
    pub creator_url: String,
    pub page_url: String,
    pub thumb_url: String,
    pub width: u32,
    pub height: u32,
    pub duration_ms: u64,
    pub tags: Vec<String>,
    pub files: Vec<RemoteFile>,
    pub license: License,
    /// Provider rating or maturity flag ("" when none).
    pub rating: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchPage {
    pub results: Vec<RemoteAsset>,
    pub page: u32,
    pub has_more: bool,
    pub total: Option<u64>,
    /// Shown above the results (e.g. why a filter left nothing).
    pub notice: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub provider: Provider,
    pub kind: SearchKind,
    pub query: String,
    #[serde(default = "one")]
    pub page: u32,
    #[serde(default)]
    pub commercial_only: bool,
}

fn one() -> u32 {
    1
}

impl SearchRequest {
    pub fn validate(&self) -> Result<()> {
        if !self.provider.kinds().contains(&self.kind) {
            return Err(invalid(format!("{} bietet diese Medienart nicht an", self.provider.name())));
        }
        let q = self.query.trim();
        if q.is_empty() || q.chars().count() > 200 || q.chars().any(char::is_control) {
            return Err(invalid("Suchbegriff fehlt oder ist zu lang"));
        }
        if !(1..=500).contains(&self.page) {
            return Err(invalid("Seite"));
        }
        Ok(())
    }
}

/// Results per page (Openverse allows at most 20 without authentication).
pub const PER_PAGE: u32 = 20;
