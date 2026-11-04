//! Audio effects and channel routing. The export renders them with FFmpeg
//! filters (`kerf-media`), the preview with WebAudio biquads and ports of
//! the same FFmpeg dynamics in an AudioWorklet (`src/engine/dsp.ts`).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

fn yes() -> bool {
    true
}

/// Shape of one equaliser band (RBJ biquads, as FFmpeg and WebAudio compute them).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EqShape {
    HighPass,
    LowShelf,
    Peak,
    HighShelf,
    LowPass,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqBand {
    pub shape: EqShape,
    /// Centre or corner frequency, Hz.
    pub freq: f32,
    /// Peak and shelves; ignored by the pass filters.
    #[serde(default)]
    pub gain_db: f32,
    /// Peak bandwidth and pass-filter resonance (0.707 = Butterworth); shelves use slope 1.
    #[serde(default = "butterworth")]
    pub q: f32,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn butterworth() -> f32 {
    std::f32::consts::FRAC_1_SQRT_2
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum AudioEffectKind {
    /// Biquads in order.
    Eq { bands: Vec<EqBand> },
    /// FFmpeg `acompressor`: RMS detection of the channel average.
    Compressor { threshold_db: f32, ratio: f32, attack_ms: f32, release_ms: f32, knee_db: f32, makeup_db: f32 },
    /// FFmpeg `agate` (downward expander): below the threshold the level
    /// drops by `ratio`, at most by `range_db`.
    Gate { threshold_db: f32, range_db: f32, ratio: f32, attack_ms: f32, release_ms: f32 },
    /// FFmpeg `alimiter`: 5 ms look-ahead, peaks held at `ceiling_db`.
    Limiter { ceiling_db: f32, release_ms: f32 },
}

/// Look-ahead of the limiter (FFmpeg's default attack).
pub const LIMITER_ATTACK_MS: f64 = 5.0;
/// Most bands of one equaliser.
pub const MAX_EQ_BANDS: usize = 8;

impl AudioEffectKind {
    /// True when the effect leaves the signal unchanged.
    pub fn is_identity(&self) -> bool {
        match self {
            AudioEffectKind::Eq { bands } => bands.iter().all(|b| !b.enabled || (matches!(b.shape, EqShape::Peak | EqShape::LowShelf | EqShape::HighShelf) && b.gain_db == 0.0)),
            AudioEffectKind::Compressor { ratio, makeup_db, .. } => *ratio <= 1.0 && *makeup_db == 0.0,
            AudioEffectKind::Gate { range_db, ratio, .. } => *range_db >= 0.0 || *ratio <= 1.0,
            AudioEffectKind::Limiter { .. } => false,
        }
    }

    /// Parameters clamped to the ranges both renderers support; None when one is not a number.
    pub fn sanitized(&self) -> Option<Self> {
        let ok = |v: f32, lo: f32, hi: f32| v.is_finite().then(|| v.clamp(lo, hi));
        Some(match self {
            AudioEffectKind::Eq { bands } => {
                if bands.len() > MAX_EQ_BANDS {
                    return None;
                }
                let mut out = Vec::with_capacity(bands.len());
                for b in bands {
                    out.push(EqBand { shape: b.shape, freq: ok(b.freq, 20.0, 20_000.0)?, gain_db: ok(b.gain_db, -24.0, 24.0)?, q: ok(b.q, 0.1, 18.0)?, enabled: b.enabled });
                }
                AudioEffectKind::Eq { bands: out }
            }
            AudioEffectKind::Compressor { threshold_db, ratio, attack_ms, release_ms, knee_db, makeup_db } => AudioEffectKind::Compressor {
                threshold_db: ok(*threshold_db, -60.0, 0.0)?,
                ratio: ok(*ratio, 1.0, 20.0)?,
                attack_ms: ok(*attack_ms, 0.1, 2000.0)?,
                release_ms: ok(*release_ms, 1.0, 9000.0)?,
                knee_db: ok(*knee_db, 0.0, 18.0)?,
                makeup_db: ok(*makeup_db, 0.0, 36.0)?,
            },
            AudioEffectKind::Gate { threshold_db, range_db, ratio, attack_ms, release_ms } => AudioEffectKind::Gate {
                threshold_db: ok(*threshold_db, -80.0, 0.0)?,
                range_db: ok(*range_db, -90.0, 0.0)?,
                ratio: ok(*ratio, 1.0, 100.0)?,
                attack_ms: ok(*attack_ms, 0.1, 2000.0)?,
                release_ms: ok(*release_ms, 1.0, 9000.0)?,
            },
            AudioEffectKind::Limiter { ceiling_db, release_ms } => AudioEffectKind::Limiter { ceiling_db: ok(*ceiling_db, -24.0, 0.0)?, release_ms: ok(*release_ms, 1.0, 8000.0)? },
        })
    }
}

/// Noise reduction of a clip's source sound with FFmpeg `afftdn`, before
/// everything else (speed, channels, effects, volume). It is rendered once
/// per media and setting into the cache; preview and export both play that
/// file, so they sound the same.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Denoise {
    /// Off keeps the settings.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// How far the noise is lowered, dB (`nr`).
    pub reduction_db: f32,
    /// Level of the noise, dB (`nf`).
    pub floor_db: f32,
    /// Follow a changing noise level (`tn`).
    #[serde(default)]
    pub track: bool,
    /// Shape of the noise learned from a part with noise only: one level per
    /// band in dB, as `afftdn` reports it after sampling (`bn` with
    /// `nt=custom`). Empty: white noise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profile: Vec<f32>,
}

/// Bands of a learned noise profile (`afftdn`).
pub const DENOISE_BANDS: usize = 15;

impl Default for Denoise {
    /// FFmpeg's defaults.
    fn default() -> Self {
        Self { enabled: true, reduction_db: 12.0, floor_db: -50.0, track: false, profile: Vec::new() }
    }
}

impl Denoise {
    /// Clamped to the ranges `afftdn` accepts (it clips band levels to
    /// ±24 dB itself); None for a value that is not a number or a profile of
    /// the wrong length.
    pub fn sanitized(&self) -> Option<Self> {
        let ok = |v: f32, lo: f32, hi: f32| v.is_finite().then(|| v.clamp(lo, hi));
        if !self.profile.is_empty() && self.profile.len() != DENOISE_BANDS {
            return None;
        }
        Some(Self {
            enabled: self.enabled,
            reduction_db: ok(self.reduction_db, 0.01, 97.0)?,
            floor_db: ok(self.floor_db, -80.0, -20.0)?,
            track: self.track,
            profile: self.profile.iter().map(|v| ok(*v, -24.0, 24.0)).collect::<Option<_>>()?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEffect {
    pub id: Uuid,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(flatten)]
    pub kind: AudioEffectKind,
}

/// Sanitised copies of `effects`, or None when a parameter is invalid.
pub fn sanitize_effects(effects: &[AudioEffect]) -> Option<Vec<AudioEffect>> {
    effects.iter().map(|e| Some(AudioEffect { id: e.id, enabled: e.enabled, kind: e.kind.sanitized()? })).collect()
}

/// Effects that change the signal.
pub fn active(effects: &[AudioEffect]) -> impl Iterator<Item = &AudioEffectKind> {
    effects.iter().filter(|e| e.enabled && !e.kind.is_identity()).map(|e| &e.kind)
}

/// How a clip's source channels reach the stereo mix (mono sources are on both).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChannelMap {
    #[default]
    Stereo,
    /// (L + R) / 2 on both sides.
    Mono,
    /// The left channel on both sides.
    Left,
    Right,
    /// Left and right exchanged.
    Swap,
}

impl ChannelMap {
    pub fn is_stereo(&self) -> bool {
        *self == ChannelMap::Stereo
    }

    /// Output gains `[[l<-l, l<-r], [r<-l, r<-r]]`.
    pub fn matrix(&self) -> [[f32; 2]; 2] {
        match self {
            ChannelMap::Stereo => [[1.0, 0.0], [0.0, 1.0]],
            ChannelMap::Mono => [[0.5, 0.5], [0.5, 0.5]],
            ChannelMap::Left => [[1.0, 0.0], [1.0, 0.0]],
            ChannelMap::Right => [[0.0, 1.0], [0.0, 1.0]],
            ChannelMap::Swap => [[0.0, 1.0], [1.0, 0.0]],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effects_are_clamped_and_identity_is_detected() {
        let comp = AudioEffectKind::Compressor { threshold_db: -90.0, ratio: 50.0, attack_ms: 0.0, release_ms: 1e9, knee_db: 6.0, makeup_db: 3.0 };
        assert_eq!(
            comp.sanitized(),
            Some(AudioEffectKind::Compressor { threshold_db: -60.0, ratio: 20.0, attack_ms: 0.1, release_ms: 9000.0, knee_db: 6.0, makeup_db: 3.0 })
        );
        assert!(AudioEffectKind::Gate { threshold_db: f32::NAN, range_db: -20.0, ratio: 2.0, attack_ms: 10.0, release_ms: 100.0 }.sanitized().is_none());
        let flat = AudioEffectKind::Eq { bands: vec![EqBand { shape: EqShape::Peak, freq: 1000.0, gain_db: 0.0, q: 1.0, enabled: true }] };
        assert!(flat.is_identity());
        let cut = AudioEffectKind::Eq { bands: vec![EqBand { shape: EqShape::HighPass, freq: 80.0, gain_db: 0.0, q: 0.7, enabled: true }] };
        assert!(!cut.is_identity());
        let json = r#"{"id":"00000000-0000-0000-0000-000000000001","type":"limiter","ceilingDb":-1.0,"releaseMs":50.0}"#;
        let e: AudioEffect = serde_json::from_str(json).unwrap();
        assert!(e.enabled && matches!(e.kind, AudioEffectKind::Limiter { .. }));
    }
}
