import {
  getStorageObject,
  setStorageObject,
  StorageKeys
} from "@/common/localStorage";

export type NoiseSuppressionMode = "disabled" | "browser" | "enhanced";

export const NoiseSuppressionModes: NoiseSuppressionMode[] = [
  "disabled",
  "browser",
  "enhanced"
];

/** Discord-style boost: 100% = normal, 200% = max amplification. */
export const MAX_VOICE_VOLUME_PERCENT = 200;
export const MAX_VOICE_VOLUME_LINEAR = MAX_VOICE_VOLUME_PERCENT / 100;

export interface VoiceMicConstraints {
  echo: boolean;
  gain: boolean;
  /** @deprecated use noiseMode */
  noise?: boolean;
  noiseMode?: NoiseSuppressionMode;
}

const defaultConstraints = (): VoiceMicConstraints => ({
  echo: true,
  gain: true,
  noiseMode: "enhanced"
});

export function getVoiceMicConstraints(): VoiceMicConstraints {
  const stored = getStorageObject(
    StorageKeys.voiceMicConstraints,
    defaultConstraints()
  );
  return {
    ...defaultConstraints(),
    ...stored,
    noiseMode: resolveNoiseSuppressionMode(stored)
  };
}

export function resolveNoiseSuppressionMode(
  constraints: Partial<VoiceMicConstraints>
): NoiseSuppressionMode {
  if (
    constraints.noiseMode &&
    NoiseSuppressionModes.includes(constraints.noiseMode)
  ) {
    return constraints.noiseMode;
  }
  if (constraints.noise === false) return "disabled";
  if (constraints.noise === true) return "enhanced";
  return "enhanced";
}

function readGainPercent(key: StorageKeys, fallback = 100) {
  const stored = getStorageObject(key, fallback);
  const percent = typeof stored === "number" ? stored : fallback;
  return Math.max(0, Math.min(MAX_VOICE_VOLUME_PERCENT, percent));
}

/** User / stream volume as linear gain (0–2). */
export function clampVoiceVolumeLinear(volume: number) {
  if (!Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(MAX_VOICE_VOLUME_LINEAR, volume));
}

/** Global output volume (what you hear), stored as 0–200 percent. */
export function getOutputGainPercent() {
  return readGainPercent(StorageKeys.voiceOutputGain, 100);
}

export function getOutputGainLinear() {
  return getOutputGainPercent() / 100;
}

export function setOutputGainPercent(percent: number) {
  const next = Math.max(0, Math.min(MAX_VOICE_VOLUME_PERCENT, Math.round(percent)));
  setStorageObject(StorageKeys.voiceOutputGain, next);
  return next;
}

/** Mic input gain, stored as 0–200 percent (matches noiseSuppressor). */
export function getInputGainPercent() {
  return readGainPercent(StorageKeys.voiceInputGain, 100);
}

export function setInputGainPercent(percent: number) {
  const next = Math.max(0, Math.min(MAX_VOICE_VOLUME_PERCENT, Math.round(percent)));
  setStorageObject(StorageKeys.voiceInputGain, next);
  return next;
}

/** Effective playback volume: per-user × master output. */
export function effectiveRemoteVolume(userVolume: number) {
  return clampVoiceVolumeLinear(userVolume) * getOutputGainLinear();
}
