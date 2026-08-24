import { getStorageObject, StorageKeys } from "@/common/localStorage";

export type NoiseSuppressionMode = "disabled" | "browser" | "enhanced";

export const NoiseSuppressionModes: NoiseSuppressionMode[] = [
  "disabled",
  "browser",
  "enhanced"
];

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
  const stored = getStorageObject(StorageKeys.voiceMicConstraints, defaultConstraints());
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
