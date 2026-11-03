// What the system webview can decode for the preview. The export never
// depends on it (FFmpeg decodes), but the monitor stays black without it.
// On Linux, WebKitGTK decodes H.264 and AAC only through GStreamer's libav
// plugin (Debian/Ubuntu: gstreamer1.0-libav); proxies are H.264 as well.

export interface PreviewCodecs {
  h264: boolean;
  aac: boolean;
}

type Probe = (mime: string) => string;

const videoProbe: Probe = (mime) => document.createElement("video").canPlayType(mime);

export function probePreviewCodecs(probe: Probe = videoProbe): PreviewCodecs {
  return {
    h264: probe('video/mp4; codecs="avc1.640028"') !== "",
    aac: probe('audio/mp4; codecs="mp4a.40.2"') !== "",
  };
}

let cached: PreviewCodecs | null = null;

/** Probed once per session; the answer cannot change while Kerf runs. */
export function previewCodecs(): PreviewCodecs {
  return (cached ??= probePreviewCodecs());
}

/** Names of the formats the preview cannot play, e.g. ["H.264", "AAC"]. */
export function missingPreviewCodecs(c: PreviewCodecs): string[] {
  return [!c.h264 && "H.264", !c.aac && "AAC"].filter((x): x is string => !!x);
}

/** What to do about it, as specific as the platform allows. */
export function previewCodecRemedy(userAgent: string): string {
  return /Linux/.test(userAgent)
    ? "Unter Debian/Ubuntu das Paket gstreamer1.0-libav installieren (sudo apt install gstreamer1.0-libav) und Kerf neu starten."
    : "Dem System fehlen Decoder für die Wiedergabe in der Vorschau.";
}
