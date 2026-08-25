import { AudioPresets } from "livekit-client";

/** Voice channels — high-quality mono Opus. */
export const LIVEKIT_VOICE_AUDIO_PRESET = AudioPresets.musicHighQuality;

/** Screen-share / system audio — stereo Opus. */
export const LIVEKIT_LIVE_AUDIO_PRESET = AudioPresets.musicStereo;

export const LIVEKIT_MIC_PUBLISH_OPTIONS = {
  audioPreset: LIVEKIT_VOICE_AUDIO_PRESET,
  dtx: true,
  red: true
} as const;

export const LIVEKIT_SCREEN_AUDIO_PUBLISH_OPTIONS = {
  audioPreset: LIVEKIT_LIVE_AUDIO_PRESET,
  dtx: false,
  red: true
} as const;
