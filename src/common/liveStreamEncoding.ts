import {
  getStorageBoolean,
  getStorageObject,
  StorageKeys
} from "@/common/localStorage";
import { log } from "@/common/logger";
import env from "@/common/env";

export const HEAVY_GAME_MAX_BITRATE_KBPS = 2000;
export const HEAVY_GAME_MAX_FRAMERATE = 30;

/** Soft ceiling when LiveKit SFU is on — protects server upload bandwidth. */
export const SFU_MAX_BITRATE_KBPS = 2500;
export const SFU_DEFAULT_BITRATE_KBPS = 2000;
export const SFU_MIN_BITRATE_KBPS = 250;

export const MESH_MAX_BITRATE_KBPS = 8000;
export const MESH_DEFAULT_BITRATE_KBPS = 2500;

export type LiveQuality =
  | "480p"
  | "720p"
  | "1080p"
  | "1440p"
  | "source";

export type LiveFramerate = 15 | 24 | 30 | 60;

/** @deprecated use LiveFramerate */
export type LiveFramerateLabel = "1fps 💀" | "10fps" | "30fps" | "60fps" | "Source";

export const LIVE_QUALITY_OPTIONS: readonly LiveQuality[] = [
  "480p",
  "720p",
  "1080p",
  "1440p",
  "source"
] as const;

export const LIVE_FRAMERATE_OPTIONS: readonly LiveFramerate[] = [
  15, 24, 30, 60
] as const;

export function isLiveKitSfuMode() {
  return env.LIVEKIT_ENABLED;
}

export function getDefaultLiveQuality(): LiveQuality {
  return isLiveKitSfuMode() ? "1080p" : "720p";
}

export function getDefaultLiveFramerate(): LiveFramerate {
  return 30;
}

export function getBitrateForQuality(quality: LiveQuality) {
  if (isLiveKitSfuMode()) {
    const map: Record<LiveQuality, number> = {
      "480p": 1000,
      "720p": 2000,
      "1080p": 2500,
      "1440p": 2500,
      source: 2500
    };
    return clampLiveBitrateKbps(map[quality]);
  }
  const map: Record<LiveQuality, number> = {
    "480p": 1500,
    "720p": 2500,
    "1080p": 4500,
    "1440p": 6000,
    source: 2500
  };
  return clampLiveBitrateKbps(map[quality]);
}

export function getDefaultLiveBitrateKbps() {
  return getBitrateForQuality(getDefaultLiveQuality());
}

export function getMaxLiveBitrateKbps() {
  let max = isLiveKitSfuMode() ? SFU_MAX_BITRATE_KBPS : MESH_MAX_BITRATE_KBPS;
  if (isHeavyGameModeEnabled()) {
    max = Math.min(max, HEAVY_GAME_MAX_BITRATE_KBPS);
  }
  return max;
}

export function clampLiveBitrateKbps(kbps: number) {
  const max = getMaxLiveBitrateKbps();
  return Math.max(SFU_MIN_BITRATE_KBPS, Math.min(max, Math.round(kbps)));
}

export function isHeavyGameModeEnabled() {
  return getStorageBoolean(StorageKeys.voiceLiveHeavyGameMode, false);
}

export function getStoredLiveQuality(): LiveQuality {
  const stored = getStorageObject(
    StorageKeys.voiceLiveQuality,
    getDefaultLiveQuality()
  );
  if (
    typeof stored === "string" &&
    LIVE_QUALITY_OPTIONS.includes(stored as LiveQuality)
  ) {
    return stored as LiveQuality;
  }
  return getDefaultLiveQuality();
}

export function getStoredLiveFramerate(): LiveFramerate {
  const stored = getStorageObject(
    StorageKeys.voiceLiveFramerate,
    getDefaultLiveFramerate()
  );
  if (
    typeof stored === "number" &&
    LIVE_FRAMERATE_OPTIONS.includes(stored as LiveFramerate)
  ) {
    return stored as LiveFramerate;
  }
  return getDefaultLiveFramerate();
}

export function applyLiveEncodingSettings(
  quality: LiveQuality,
  framerate: LiveFramerate,
  setBitrate: (kbps: number) => void
) {
  let q = quality;
  let fps = framerate;
  if (isHeavyGameModeEnabled()) {
    q = "720p";
    fps = 30;
  }
  setBitrate(getBitrateForQuality(q));
  return { quality: q, framerate: fps };
}

export function getEffectiveLiveBitrateKbps() {
  const stored = getStorageObject(
    StorageKeys.voiceLiveBitrate,
    getDefaultLiveBitrateKbps()
  );
  const value = typeof stored === "number" ? stored : getDefaultLiveBitrateKbps();
  return clampLiveBitrateKbps(value);
}

export function getEffectiveLiveFramerate() {
  if (isHeavyGameModeEnabled()) return HEAVY_GAME_MAX_FRAMERATE;
  return getStoredLiveFramerate();
}

export function getLiveQualityDimensions(quality: LiveQuality) {
  switch (quality) {
    case "480p":
      return { width: 848, height: 480 };
    case "720p":
      return { width: 1280, height: 720 };
    case "1080p":
      return { width: 1920, height: 1080 };
    case "1440p":
      return { width: 2560, height: 1440 };
    case "source":
      return { width: window.screen.width, height: window.screen.height };
    default:
      return { width: 1280, height: 720 };
  }
}

export function prepareOutgoingVideoTrack(track?: MediaStreamTrack | null) {
  if (!track || track.kind !== "video") return;
  if (isHeavyGameModeEnabled() || isLiveKitSfuMode()) {
    track.contentHint = "motion";
  }
}

/**
 * H264 first: it is the only codec with widespread hardware encoder support
 * (NVENC/AMF/QuickSync), which runs on dedicated silicon instead of competing
 * with the game for shader cores or CPU threads. VP8/VP9 fall back to libvpx
 * software encoding, which is what makes heavy games stutter.
 */
const VIDEO_CODEC_PRIORITY = ["video/h264", "video/vp8", "video/vp9", "video/av1"];

function sortedVideoCodecs() {
  if (typeof RTCRtpSender.getCapabilities !== "function") return [];
  const caps = RTCRtpSender.getCapabilities("video");
  if (!caps?.codecs?.length) return [];
  return [...caps.codecs].sort((a, b) => {
    const ai = VIDEO_CODEC_PRIORITY.indexOf(a.mimeType.toLowerCase());
    const bi = VIDEO_CODEC_PRIORITY.indexOf(b.mimeType.toLowerCase());
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

/**
 * Must run before the peer creates its offer/answer. setCodecPreferences only
 * affects the next negotiation, so calling it on an established connection is
 * a no-op.
 */
export function applyHardwarePreferredVideoEncoding(pc?: RTCPeerConnection) {
  if (!pc || !isHeavyGameModeEnabled()) return;
  const codecs = sortedVideoCodecs();
  if (!codecs.length) return;

  for (const transceiver of pc.getTransceivers()) {
    const isVideo =
      transceiver.sender.track?.kind === "video" ||
      transceiver.receiver.track?.kind === "video";
    if (!isVideo) continue;
    try {
      transceiver.setCodecPreferences(codecs);
    } catch (err) {
      log("RTC", "Heavy game codec preference failed", err);
    }
  }
}

/** @deprecated */
export function getLiveQualityPresets() {
  return LIVE_QUALITY_OPTIONS.map((id) => ({
    id,
    bitrateKbps: getBitrateForQuality(id),
    framerateLabel: "30fps" as LiveFramerateLabel,
    hintKey: "preset720" as const
  }));
}

/** @deprecated */
export function getLiveQualityPreset(id: LiveQuality) {
  return {
    id,
    bitrateKbps: getBitrateForQuality(id),
    framerateLabel: "30fps" as LiveFramerateLabel,
    hintKey: "preset720" as const
  };
}

/** @deprecated */
export function getLiveQualityOptions() {
  return LIVE_QUALITY_OPTIONS;
}

/** @deprecated */
export function getLiveFramerateOptions() {
  return LIVE_FRAMERATE_OPTIONS;
}
