import { getStorageObject, StorageKeys } from "@/common/localStorage";

export const MAX_OUTPUT_GAIN_PERCENT = 500;

/**
 * Ganho aplicado ao áudio recebido em chamadas.
 *
 * `HTMLMediaElement.volume` satura em 1.0, então qualquer valor acima de 100%
 * só funciona via Web Audio (GainNode). O AudioContext compartilhado abaixo é
 * criado sob demanda, apenas quando alguém realmente passa de 100%.
 */
export function getOutputGainPercent() {
  const stored = getStorageObject(StorageKeys.voiceOutputGain, 100);
  const percent = typeof stored === "number" ? stored : 100;
  return Math.max(0, Math.min(MAX_OUTPUT_GAIN_PERCENT, percent));
}

export function getOutputGainLinear() {
  return getOutputGainPercent() / 100;
}

let sharedContext: AudioContext | null = null;

export function getOutputAudioContext() {
  if (typeof window === "undefined") return null;
  if (!sharedContext) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    sharedContext = new Ctor();
  }
  if (sharedContext.state === "suspended") {
    void sharedContext.resume().catch(() => {});
  }
  return sharedContext;
}
