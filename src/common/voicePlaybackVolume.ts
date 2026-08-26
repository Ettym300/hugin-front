/**
 * HTMLMediaElement.volume is capped at 1. For Discord-style boost (>100%),
 * route the stream through a Web Audio GainNode while muting the element.
 */

type BoostGraph = {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  stream: MediaStream;
};

const boostByElement = new WeakMap<HTMLMediaElement, BoostGraph>();

function teardownBoost(el: HTMLMediaElement) {
  const graph = boostByElement.get(el);
  if (!graph) return;
  try {
    graph.source.disconnect();
    graph.gain.disconnect();
  } catch {
    /* already disconnected */
  }
  void graph.ctx.close().catch(() => {});
  boostByElement.delete(el);
}

function ensureBoost(el: HTMLMediaElement, stream: MediaStream): BoostGraph | null {
  const existing = boostByElement.get(el);
  if (existing && existing.stream === stream) return existing;
  teardownBoost(el);

  try {
    const ctx = new AudioContext();
    void ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(ctx.destination);
    const graph: BoostGraph = { ctx, source, gain, stream };
    boostByElement.set(el, graph);
    return graph;
  } catch {
    return null;
  }
}

/** Apply linear volume (0–2+) to an HTML media element, with boost above 1. */
export function setMediaElementVolume(el: HTMLMediaElement, volume: number) {
  const v = Math.max(0, volume);
  const stream = el.srcObject;

  if (v <= 1 || !(stream instanceof MediaStream)) {
    teardownBoost(el);
    el.muted = v <= 0;
    el.volume = Math.min(1, v);
    return;
  }

  const graph = ensureBoost(el, stream);
  if (!graph) {
    el.muted = false;
    el.volume = 1;
    return;
  }

  // Element stays muted so only the GainNode plays (avoids double audio).
  el.muted = true;
  el.volume = 1;
  graph.gain.gain.value = v;
}

export function clearMediaElementVolumeBoost(el: HTMLMediaElement) {
  teardownBoost(el);
}
