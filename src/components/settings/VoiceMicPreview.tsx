import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup
} from "solid-js";
import { styled } from "solid-styled-components";
import { t } from "@nerimity/i18lite";
import useStore from "@/chat-api/store/useStore";
import {
  StorageKeys,
  getStorageObject,
  getStorageString,
  useLocalStorage
} from "@/common/localStorage";
import { wrapMicWithNoiseSuppression } from "@/common/noiseSuppressor";
import type { NoiseSuppressionMode } from "@/common/voiceAudioSettings";
import {
  getVoiceMicConstraints,
  resolveNoiseSuppressionMode
} from "@/common/voiceAudioSettings";
import SettingsBlock from "../ui/settings-block/SettingsBlock";
import Button from "../ui/Button";
import { FlexRow } from "../ui/Flexbox";
import Slider from "../ui/Slider";
import Text from "../ui/Text";

const BAR_COUNT = 32;
const BAR_INDEXES = Array.from({ length: BAR_COUNT }, (_, index) => index);

const PreviewSettingsBlock = styled(SettingsBlock)`
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
`;

const PreviewColumn = styled("div")`
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
`;

const TestRow = styled(FlexRow)`
  align-items: center;
  width: 100%;
  min-width: 220px;
`;

const Meter = styled("div")`
  display: flex;
  overflow: hidden;
  flex: 1;
  align-items: stretch;
  height: 22px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.35);
`;

const Bar = styled("div")<{
  filled: boolean;
  transmitting: boolean;
}>`
  flex: 1;
  min-width: 2px;
  margin-right: 1px;
  background: ${(props) =>
    !props.filled
      ? "rgba(255, 255, 255, 0.08)"
      : props.transmitting
        ? "#23a559"
        : "#f0b132"};
  &:last-child {
    margin-right: 0;
  }
`;

const SensitivityWrap = styled("div")`
  position: relative;
  width: 100%;
  min-width: 180px;
`;

const SensitivitySlider = styled("input")`
  position: absolute;
  z-index: 2;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  cursor: pointer;
  opacity: 0;
`;

const ThresholdMark = styled("div")`
  position: absolute;
  z-index: 1;
  top: -2px;
  bottom: -2px;
  width: 3px;
  border-radius: 2px;
  background: white;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.6);
  pointer-events: none;
`;

const StatusText = styled("div")`
  font-size: 12px;
  opacity: 0.7;
`;

const GainRow = styled("div")`
  display: flex;
  align-items: center;
  width: 100%;
  .slider {
    flex: 1;
    width: 100%;
  }
  .slider input {
    width: 100%;
  }
`;

function getPreviewConstraints(): MediaTrackConstraints {
  const constraints = getVoiceMicConstraints();
  const noiseMode = resolveNoiseSuppressionMode(constraints);
  const deviceId = getStorageString(StorageKeys.inputDeviceId, undefined);
  const audio: MediaTrackConstraints = {
    echoCancellation: constraints.echo,
    noiseSuppression: noiseMode === "browser",
    autoGainControl: constraints.gain
  };
  if (deviceId) {
    try {
      audio.deviceId = { exact: JSON.parse(deviceId) };
    } catch {
      // keep default device
    }
  }
  return audio;
}

function levelFromAnalyser(analyser: AnalyserNode, buffer: Uint8Array) {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const value = ((buffer[i] ?? 128) - 128) / 128;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4.2);
}

export function VoiceMicPreview(props: {
  inputDeviceId?: string;
  constraints: {
    echo: boolean;
    gain: boolean;
    noiseMode: NoiseSuppressionMode;
  };
}) {
  const { voiceUsers } = useStore();
  const [level, setLevel] = createSignal(0);
  const [testing, setTesting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [sensitivity, setSensitivity] = useLocalStorage(
    StorageKeys.voiceInputSensitivity,
    25
  );
  const [inputGain, setInputGain] = useLocalStorage(
    StorageKeys.voiceInputGain,
    100
  );

  let previewStream: MediaStream | null = null;
  let ownsStream = false;
  let disposeMic: (() => void) | null = null;
  let setPreviewGain: ((linear: number) => void) | null = null;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let loopback: HTMLAudioElement | null = null;
  let raf = 0;
  let generation = 0;

  const stopLoopback = () => {
    if (loopback) {
      loopback.pause();
      loopback.srcObject = null;
      loopback = null;
    }
    setTesting(false);
  };

  const stopPreview = () => {
    generation += 1;
    cancelAnimationFrame(raf);
    stopLoopback();
    analyser?.disconnect();
    analyser = null;
    void audioContext?.close();
    audioContext = null;
    disposeMic?.();
    disposeMic = null;
    setPreviewGain = null;
    if (ownsStream) {
      previewStream?.getTracks().forEach((track) => track.stop());
    }
    previewStream = null;
    ownsStream = false;
    setLevel(0);
  };

  const startMeter = (stream: MediaStream) => {
    audioContext = new AudioContext();
    void audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    const buffer = new Uint8Array(analyser.fftSize);
    let displayed = 0;

    const tick = () => {
      if (!analyser) return;
      const instant = levelFromAnalyser(analyser, buffer);
      displayed = instant > displayed ? instant : displayed * 0.9;
      setLevel(displayed);
      raf = requestAnimationFrame(tick);
    };
    tick();
  };

  const startPreview = async () => {
    const id = ++generation;
    stopLoopback();
    cancelAnimationFrame(raf);
    analyser?.disconnect();
    analyser = null;
    void audioContext?.close();
    audioContext = null;
    disposeMic?.();
    disposeMic = null;
    setPreviewGain = null;
    if (ownsStream) {
      previewStream?.getTracks().forEach((track) => track.stop());
    }
    previewStream = null;
    ownsStream = false;
    setLevel(0);
    setError(null);

    let rawStream: MediaStream;
    try {
      rawStream = await navigator.mediaDevices.getUserMedia({
        audio: getPreviewConstraints(),
        video: false
      });
    } catch {
      if (id === generation) setError(t("settings.call.micTestError"));
      return;
    }

    if (id !== generation) {
      rawStream.getTracks().forEach((track) => track.stop());
      return;
    }

    const wrapped = await wrapMicWithNoiseSuppression(
      rawStream,
      props.constraints.noiseMode
    );

    if (id !== generation) {
      wrapped.dispose();
      return;
    }

    previewStream = wrapped.stream;
    ownsStream = true;
    disposeMic = wrapped.dispose;
    setPreviewGain = wrapped.setGain;
    wrapped.setGain(Math.max(0, Math.min(2, inputGain() / 100)));
    startMeter(wrapped.stream);
  };

  const toggleTest = async () => {
    if (testing()) {
      stopLoopback();
      return;
    }
    if (!previewStream) {
      await startPreview();
    }
    if (!previewStream) return;

    const audio = new Audio();
    audio.srcObject = previewStream;
    audio.volume = 0.85;
    const outputDeviceId = getStorageString(
      StorageKeys.outputDeviceId,
      undefined
    );
    if (outputDeviceId && audio.setSinkId) {
      try {
        await audio.setSinkId(JSON.parse(outputDeviceId));
      } catch {
        // keep default output
      }
    }
    try {
      await audio.play();
      loopback = audio;
      setTesting(true);
    } catch {
      setError(t("settings.call.micTestError"));
    }
  };

  createEffect(() => {
    props.inputDeviceId;
    props.constraints.echo;
    props.constraints.noiseMode;
    props.constraints.gain;
    void startPreview();
    onCleanup(() => stopPreview());
  });

  createEffect(() => {
    const linear = Math.max(0, Math.min(2, inputGain() / 100));
    setPreviewGain?.(linear);
  });

  const threshold = () => sensitivity() / 100;
  const transmitting = () => level() >= threshold();

  return (
    <>
      <PreviewSettingsBlock
        icon="graphic_eq"
        label={t("settings.call.micTest")}
        description={
          testing()
            ? t("settings.call.micTestListening")
            : t("settings.call.micTestDescription")
        }
      >
        <PreviewColumn>
          <TestRow gap={10}>
            <Button
              margin={0}
              iconName={testing() ? "stop" : "hearing"}
              iconSize={16}
              color={testing() ? "var(--alert-color)" : undefined}
              primary={!testing()}
              label={
                testing()
                  ? t("settings.call.micTestStop")
                  : t("settings.call.micTest")
              }
              onClick={() => void toggleTest()}
            />
            <Meter>
              <For each={BAR_INDEXES}>
                {(index) => (
                  <Bar
                    filled={level() > index / BAR_COUNT}
                    transmitting={index / BAR_COUNT >= threshold()}
                  />
                )}
              </For>
            </Meter>
          </TestRow>
          <Show when={error()}>
            <StatusText style={{ color: "var(--alert-color)" }}>
              {error()}
            </StatusText>
          </Show>
        </PreviewColumn>
      </PreviewSettingsBlock>
      <PreviewSettingsBlock
        icon="volume_up"
        label={t("settings.call.inputVolume")}
        description={t("settings.call.inputVolumeDescription")}
      >
        <PreviewColumn>
          <GainRow>
            <Slider
              min={0}
              max={200}
              value={inputGain()}
              onChange={(value) => {
                const percent = Number(value);
                if (Number.isNaN(percent)) return;
                setInputGain(percent);
                voiceUsers.setMicGain(percent);
              }}
            />
            <Text style={{ width: "48px", "text-align": "center" }}>
              {inputGain()}%
            </Text>
          </GainRow>
        </PreviewColumn>
      </PreviewSettingsBlock>
      <PreviewSettingsBlock
        icon="tune"
        label={t("settings.call.inputSensitivity")}
        description={t("settings.call.inputSensitivityDescription")}
      >
        <PreviewColumn>
          <SensitivityWrap>
            <Meter>
              <For each={BAR_INDEXES}>
                {(index) => (
                  <Bar
                    filled={level() > index / BAR_COUNT}
                    transmitting={index / BAR_COUNT >= threshold()}
                  />
                )}
              </For>
            </Meter>
            <ThresholdMark style={{ left: `calc(${sensitivity()}% - 1px)` }} />
            <SensitivitySlider
              type="range"
              min={5}
              max={95}
              value={sensitivity()}
              onInput={(event) => {
                setSensitivity(Number(event.currentTarget.value));
              }}
              onChange={() => {
                voiceUsers.updateLocalVadSensitivity();
              }}
            />
          </SensitivityWrap>
          <StatusText>
            {transmitting()
              ? t("settings.call.inputSensitivityOpen")
              : t("settings.call.inputSensitivityClosed")}
          </StatusText>
        </PreviewColumn>
      </PreviewSettingsBlock>
    </>
  );
}
