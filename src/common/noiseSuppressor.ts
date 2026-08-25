import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { log } from "@/common/logger";
import { getStorageObject, StorageKeys } from "@/common/localStorage";
import type { NoiseSuppressionMode } from "@/common/voiceAudioSettings";

export type WrappedMic = {
  stream: MediaStream;
  originalStream: MediaStream;
  dispose: () => void;
  setGain: (linear: number) => void;
};

export function getMicGainLinear() {
  const stored = getStorageObject(StorageKeys.voiceInputGain, 100);
  const percent = typeof stored === "number" ? stored : 100;
  return Math.max(0, Math.min(2, percent / 100));
}

let rnnoiseWasm: ArrayBuffer | null = null;
let preloadPromise: Promise<void> | null = null;

async function loadRnnoiseWasm() {
  if (!rnnoiseWasm) {
    rnnoiseWasm = await loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseSimdWasmPath
    });
  }
  return rnnoiseWasm;
}

export function preloadNoiseSuppressor() {
  if (!preloadPromise) {
    preloadPromise = loadRnnoiseWasm()
      .then(() => undefined)
      .catch((err) => {
        preloadPromise = null;
        log("RTC", "Failed to preload noise suppressor", err);
      });
  }
  return preloadPromise;
}

function createStoatHighpass(ctx: AudioContext) {
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 50;
  highpass.Q.value = Math.SQRT1_2;
  return highpass;
}

function createStoatCompressor(ctx: AudioContext) {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -3;
  compressor.knee.value = 0;
  compressor.ratio.value = 20;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.05;
  return compressor;
}

function createAudioContext() {
  try {
    return new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  } catch {
    return new AudioContext({ latencyHint: "interactive" });
  }
}

function passthrough(input: MediaStream): WrappedMic {
  return {
    stream: input,
    originalStream: input,
    dispose: () => {
      input.getTracks().forEach((track) => track.stop());
    },
    setGain: () => {}
  };
}

async function wrapWithGainOnly(input: MediaStream): Promise<WrappedMic> {
  const ctx = createAudioContext();
  try {
    await ctx.resume();
    const source = ctx.createMediaStreamSource(input);
    const gain = ctx.createGain();
    gain.gain.value = getMicGainLinear();
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    dest.channelCountMode = "explicit";
    dest.channelInterpretation = "speakers";
    const keepAlive = ctx.createGain();
    keepAlive.gain.value = 0;
    source.connect(gain);
    gain.connect(dest);
    gain.connect(keepAlive);
    keepAlive.connect(ctx.destination);

    const pump = new Audio();
    pump.muted = true;
    pump.volume = 0;
    pump.srcObject = dest.stream;
    try {
      await pump.play();
    } catch {
      // autoplay can fail
    }

    const processedTrack = dest.stream.getAudioTracks()[0];
    if (processedTrack) {
      processedTrack.contentHint = "speech";
      processedTrack.enabled = true;
      if (processedTrack.muted) {
        await Promise.race([
          new Promise<void>((resolve) => {
            processedTrack.addEventListener("unmute", () => resolve(), {
              once: true
            });
          }),
          new Promise<void>((resolve) => window.setTimeout(resolve, 800))
        ]);
      }
    }

    const webRtc = webRtcAudioStream(dest.stream, input);
    return {
      stream: webRtc.stream,
      originalStream: input,
      setGain: (linear) => {
        gain.gain.value = linear;
      },
      dispose: () => {
        webRtc.extraDispose();
        pump.pause();
        pump.srcObject = null;
        dest.stream.getTracks().forEach((track) => track.stop());
        try {
          source.disconnect();
          gain.disconnect();
          keepAlive.disconnect();
        } catch {
          // already disconnected
        }
        void ctx.close();
        input.getTracks().forEach((track) => track.stop());
      }
    };
  } catch (err) {
    void ctx.close();
    log("RTC", "Input gain graph failed", err);
    return passthrough(input);
  }
}

function webRtcAudioStream(
  processed: MediaStream,
  fallback: MediaStream
): { stream: MediaStream; extraDispose: () => void } {
  const track = processed.getAudioTracks()[0];
  if (!track || track.muted) {
    if (track?.muted) {
      log("RTC", "Processed mic stayed muted; sending original microphone");
    }
    return { stream: fallback, extraDispose: () => {} };
  }

  const Processor = (window as any).MediaStreamTrackProcessor;
  const Generator = (window as any).MediaStreamTrackGenerator;
  if (typeof Processor === "function" && typeof Generator === "function") {
    try {
      const processor = new Processor({ track });
      const generator = new Generator({ kind: "audio" });
      const abort = new AbortController();
      processor.readable
        .pipeTo(generator.writable, { signal: abort.signal })
        .catch(() => {});
      const out = new MediaStream([generator]);
      return {
        stream: out,
        extraDispose: () => {
          abort.abort();
          out.getTracks().forEach((t) => t.stop());
        }
      };
    } catch (err) {
      log("RTC", "MediaStreamTrackGenerator failed", err);
    }
  }

  return { stream: processed, extraDispose: () => {} };
}

async function tryBrowserNoiseSuppression(input: MediaStream) {
  const track = input.getAudioTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ noiseSuppression: true });
  } catch {
    // browser may not allow toggling this constraint
  }
}

async function wrapWithStoatVoice(input: MediaStream) {
  const wasmBinary = await loadRnnoiseWasm();
  const ctx = createAudioContext();
  try {
    if (ctx.sampleRate !== 48000) {
      throw new Error(`Unsupported sample rate: ${ctx.sampleRate}`);
    }
    await ctx.resume();
    await ctx.audioWorklet.addModule(rnnoiseWorkletPath);
    const rnnoise = new RnnoiseWorkletNode(ctx, {
      wasmBinary,
      maxChannels: 1
    });
    const highpass = createStoatHighpass(ctx);
    const compressor = createStoatCompressor(ctx);
    const source = ctx.createMediaStreamSource(input);
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    dest.channelCountMode = "explicit";
    dest.channelInterpretation = "speakers";
    const merger = ctx.createChannelMerger(2);
    const gain = ctx.createGain();
    gain.gain.value = getMicGainLinear();
    const keepAlive = ctx.createGain();
    keepAlive.gain.value = 0;

    source.connect(highpass);
    highpass.connect(rnnoise);
    rnnoise.connect(compressor);
    compressor.connect(merger, 0, 0);
    compressor.connect(merger, 0, 1);
    merger.connect(gain);
    gain.connect(dest);
    gain.connect(keepAlive);
    keepAlive.connect(ctx.destination);

    const pump = new Audio();
    pump.muted = true;
    pump.volume = 0;
    pump.srcObject = dest.stream;
    try {
      await pump.play();
    } catch {
      // autoplay can fail
    }

    const processedTrack = dest.stream.getAudioTracks()[0];
    if (processedTrack) {
      processedTrack.contentHint = "speech";
      processedTrack.enabled = true;
      if (processedTrack.muted) {
        await Promise.race([
          new Promise<void>((resolve) => {
            processedTrack.addEventListener("unmute", () => resolve(), {
              once: true
            });
          }),
          new Promise<void>((resolve) => window.setTimeout(resolve, 800))
        ]);
      }
    }

    const webRtc = webRtcAudioStream(dest.stream, input);

    return {
      stream: webRtc.stream,
      originalStream: input,
      setGain: (linear: number) => {
        gain.gain.value = linear;
      },
      dispose: () => {
        webRtc.extraDispose();
        pump.pause();
        pump.srcObject = null;
        dest.stream.getTracks().forEach((track) => track.stop());
        try {
          rnnoise.destroy();
        } catch {
          // already torn down
        }
        try {
          source.disconnect();
          highpass.disconnect();
          rnnoise.disconnect();
          compressor.disconnect();
          merger.disconnect();
          gain.disconnect();
          keepAlive.disconnect();
        } catch {
          // already disconnected
        }
        void ctx.close();
        input.getTracks().forEach((track) => track.stop());
      }
    };
  } catch (err) {
    void ctx.close();
    throw err;
  }
}

export async function wrapMicWithNoiseSuppression(
  input: MediaStream,
  mode: NoiseSuppressionMode
): Promise<WrappedMic> {
  if (mode === "disabled") return wrapWithGainOnly(input);

  if (mode === "browser") {
    await tryBrowserNoiseSuppression(input);
    return wrapWithGainOnly(input);
  }

  try {
    const wrapped = await wrapWithStoatVoice(input);
    log("RTC", "Using enhanced voice processing (RNNoise + compressor)");
    return wrapped;
  } catch (enhancedError) {
    log(
      "RTC",
      "Enhanced voice processing failed, using browser filter",
      enhancedError
    );
    await tryBrowserNoiseSuppression(input);
    return wrapWithGainOnly(input);
  }
}
