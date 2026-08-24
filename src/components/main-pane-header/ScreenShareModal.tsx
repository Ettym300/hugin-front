import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount
} from "solid-js";
import { t } from "@nerimity/i18lite";
import useStore from "@/chat-api/store/useStore";
import { ElectronCaptureSource, electronWindowAPI } from "@/common/Electron";
import { StorageKeys, useLocalStorage } from "@/common/localStorage";
import {
  LIVE_FRAMERATE_OPTIONS,
  LIVE_QUALITY_OPTIONS,
  LiveFramerate,
  LiveQuality,
  applyLiveEncodingSettings,
  getDefaultLiveFramerate,
  getDefaultLiveQuality,
  getLiveQualityDimensions,
  getStoredLiveFramerate,
  getStoredLiveQuality,
  isHeavyGameModeEnabled
} from "@/common/liveStreamEncoding";
import { Modal } from "../ui/modal";
import Checkbox from "../ui/Checkbox";
import style from "./ScreenShareModal.module.scss";

const isWindows =
  navigator?.userAgentData?.platform === "Windows" ||
  /Windows/i.test(navigator.userAgent);

/** Linux/Wayland: sem lista interna — getSources abre o portal do KDE. */
function useSystemScreenPicker() {
  const api = electronWindowAPI();
  if (!api?.isElectron) return false;
  if (api.platform === "linux") return true;
  if (api.platform === "win32" || api.platform === "darwin") return false;
  return !isWindows && /Linux/i.test(navigator.userAgent);
}

let audioGenerator: any | null = null;
let writer: any | null = null;

if (electronWindowAPI()?.isElectron) {
  const { sampleRate, numChannels } = { sampleRate: 48000, numChannels: 2 };

  electronWindowAPI()?.appLoopbackData?.(async (d) => {
    const float32 = new Float32Array(d.length / 2);
    const view = new DataView(d.buffer);
    for (let i = 0; i < float32.length; i++) {
      float32[i] = view.getInt16(i * 2, true) / 32768;
    }

    const audioData = new AudioData({
      format: "f32",
      sampleRate,
      numberOfFrames: float32.length / numChannels,
      numberOfChannels: numChannels,
      timestamp: performance.now() * 1000,
      data: float32
    });

    try {
      await writer?.write(audioData);
    } catch {
      electronWindowAPI()?.appLoopbackReset?.();
    }
  });
}

function qualityLabel(quality: LiveQuality) {
  if (quality === "source") {
    return t("mainPaneHeader.voice.screenShareModal.sourceQuality");
  }
  return quality;
}

function framerateLabel(fps: LiveFramerate) {
  return `${fps} fps`;
}

export function LiveShareSettingsPicker(props?: {
  showAdvanced?: boolean;
  onSettingsChange?: (settings: {
    quality: LiveQuality;
    framerate: LiveFramerate;
  }) => void;
}) {
  const { voiceUsers } = useStore();
  const [quality, setQuality] = useLocalStorage<LiveQuality>(
    StorageKeys.voiceLiveQuality,
    getDefaultLiveQuality()
  );
  const [framerate, setFramerate] = useLocalStorage<LiveFramerate>(
    StorageKeys.voiceLiveFramerate,
    getDefaultLiveFramerate()
  );

  const syncEncoding = (q: LiveQuality, fps: LiveFramerate) => {
    const applied = applyLiveEncodingSettings(q, fps, voiceUsers.setLiveBitrate);
    setQuality(applied.quality);
    setFramerate(applied.framerate);
    props?.onSettingsChange?.(applied);
  };

  onMount(() => {
    syncEncoding(getStoredLiveQuality(), getStoredLiveFramerate());
  });

  return (
    <div class={style.body}>
      <div class={style.section}>
        <div class={style.sectionLabel}>
          {t("mainPaneHeader.voice.screenShareModal.videoQuality")}
        </div>
        <div class={style.pillRow}>
          <For each={[...LIVE_QUALITY_OPTIONS]}>
            {(option) => (
              <button
                type="button"
                class={style.pill}
                data-selected={quality() === option}
                onClick={() => syncEncoding(option, framerate())}
              >
                {qualityLabel(option)}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class={style.section}>
        <div class={style.sectionLabel}>
          {t("mainPaneHeader.voice.screenShareModal.framerate")}
        </div>
        <div class={style.pillRow}>
          <For each={[...LIVE_FRAMERATE_OPTIONS]}>
            {(option) => (
              <button
                type="button"
                class={style.pill}
                data-selected={framerate() === option}
                onClick={() => syncEncoding(quality(), option)}
              >
                {framerateLabel(option)}
              </button>
            )}
          </For>
        </div>
      </div>

      <Show when={props?.showAdvanced}>
        <div class={style.advanced}>
          <HeavyGameModePicker />
        </div>
      </Show>
    </div>
  );
}

/** @deprecated use LiveShareSettingsPicker */
export const LiveQualityPresetPicker = LiveShareSettingsPicker;

/** @deprecated use LiveShareSettingsPicker */
export const LiveBitratePicker = LiveShareSettingsPicker;

export function HeavyGameModePicker(props?: { onChange?: (enabled: boolean) => void }) {
  const { voiceUsers } = useStore();
  const [heavyGame, setHeavyGame] = useLocalStorage(
    StorageKeys.voiceLiveHeavyGameMode,
    false
  );

  const onToggle = (enabled: boolean) => {
    setHeavyGame(enabled);
    props?.onChange?.(enabled);
    if (voiceUsers.currentUser()?.videoStream) {
      void voiceUsers.applyOutgoingLiveEncoding();
    }
    if (enabled) {
      applyLiveEncodingSettings(
        getStoredLiveQuality(),
        getStoredLiveFramerate(),
        voiceUsers.setLiveBitrate
      );
    }
  };

  return (
    <>
      <Checkbox
        label={t("mainPaneHeader.voice.screenShareModal.heavyGameMode")}
        checked={heavyGame()}
        onChange={onToggle}
      />
      <div class={style.hint}>
        {t("mainPaneHeader.voice.screenShareModal.heavyGameModeDescription")}
      </div>
    </>
  );
}

export function ScreenShareModal(props: { close: () => void }) {
  const { voiceUsers } = useStore();
  const [quality] = useLocalStorage<LiveQuality>(
    StorageKeys.voiceLiveQuality,
    getDefaultLiveQuality()
  );
  const [framerate] = useLocalStorage<LiveFramerate>(
    StorageKeys.voiceLiveFramerate,
    getDefaultLiveFramerate()
  );
  const [shareSystemAudio, setShareSystemAudio] = createSignal(true);
  const [preventEcho, setPreventEcho] = createSignal(true);
  const [electronSourceId, setElectronSourceId] = createSignal<string>();
  const [starting, setStarting] = createSignal(false);

  const isElectron = () => !!electronWindowAPI()?.isElectron;
  const changing = () => !!voiceUsers.currentUser()?.videoStream;

  onMount(() => {
    if (isHeavyGameModeEnabled()) {
      applyLiveEncodingSettings(quality(), framerate(), voiceUsers.setLiveBitrate);
    } else {
      applyLiveEncodingSettings(quality(), framerate(), voiceUsers.setLiveBitrate);
    }
  });

  const startSharing = async () => {
    if (starting()) return;
    // No Linux o portal do sistema escolhe a fonte; no Windows precisa da lista.
    if (isElectron() && !useSystemScreenPicker() && !electronSourceId()) return;

    setStarting(true);
    try {
      const applied = applyLiveEncodingSettings(
        quality(),
        framerate(),
        voiceUsers.setLiveBitrate
      );
      // Áudio de sistema via loopback só existe no Electron Windows.
      const includeAudio = isElectron()
        ? isWindows && shareSystemAudio()
        : shareSystemAudio();

      const constraints = buildDisplayMediaConstraints(
        applied.quality,
        applied.framerate,
        includeAudio
      );

      let appTrack: MediaStreamTrack | undefined;

      if (isElectron() && !useSystemScreenPicker()) {
        const sourceId = electronSourceId()!;
        await electronWindowAPI()?.setDesktopCaptureSourceId(sourceId);

        if (isWindows && shareSystemAudio()) {
          if (sourceId.includes("window")) {
            electronWindowAPI()?.appLoopbackStartV2?.({
              type: "CaptureApp",
              chromeMediaSourceId: sourceId
            });
          } else {
            electronWindowAPI()?.appLoopbackStartV2?.({
              type: "CaptureSystem",
              excludeSelf: preventEcho()
            });
          }

          /* @ts-expect-error MediaStreamTrackGenerator is not in the DOM lib */
          audioGenerator = new MediaStreamTrackGenerator({ kind: "audio" });
          writer = audioGenerator!.writable.getWriter();
          appTrack = new MediaStream([audioGenerator!]).getAudioTracks()[0];
        }
      }

      const stream = await navigator.mediaDevices
        .getDisplayMedia(constraints)
        .catch(() => undefined);
      if (!stream) return;

      if (appTrack) {
        stream.getAudioTracks().forEach((track) => stream.removeTrack(track));
        stream.addTrack(appTrack);
      } else if (!includeAudio) {
        stream.getAudioTracks().forEach((track) => {
          track.stop();
          stream.removeTrack(track);
        });
      }

      voiceUsers.setVideoStream(stream);
      props.close();
    } finally {
      setStarting(false);
    }
  };

  const shareAudioLabel = () => {
    if (isElectron() && electronSourceId()?.includes("window")) {
      return t("mainPaneHeader.voice.screenShareModal.shareAppAudio");
    }
    return t("mainPaneHeader.voice.screenShareModal.shareAudio");
  };

  return (
    <Modal.Root close={props.close} desktopMaxWidth={560} desktopMinWidth={420}>
      <Modal.Header
        title={
          changing()
            ? t("mainPaneHeader.voice.screenShareModal.changeTitle")
            : t("mainPaneHeader.voice.screenShareModal.title")
        }
      />
      <Modal.Body>
        <LiveShareSettingsPicker />

        <Show when={!useSystemScreenPicker()}>
          <div class={style.toggleRow}>
            <span class={style.toggleLabel}>{shareAudioLabel()}</span>
            <button
              type="button"
              class={style.toggle}
              data-on={shareSystemAudio()}
              aria-pressed={shareSystemAudio()}
              aria-label={shareAudioLabel()}
              onClick={() => setShareSystemAudio((v) => !v)}
            />
          </div>
        </Show>

        <Show
          when={
            shareSystemAudio() &&
            isElectron() &&
            electronSourceId()?.includes("screen") &&
            isWindows
          }
        >
          <div class={style.toggleRow}>
            <span class={style.toggleLabel}>
              {t("mainPaneHeader.voice.screenShareModal.preventEcho")}
            </span>
            <button
              type="button"
              class={style.toggle}
              data-on={preventEcho()}
              aria-pressed={preventEcho()}
              onClick={() => setPreventEcho((v) => !v)}
            />
          </div>
        </Show>

        <Show when={isElectron() && !useSystemScreenPicker()}>
          <ElectronCaptureSourceList ref={setElectronSourceId} />
        </Show>
      </Modal.Body>
      <Modal.Footer>
        <Modal.Button
          label={t("general.cancelButton")}
          color="var(--alert-color)"
          onClick={props.close}
        />
        <Modal.Button
          label={t("mainPaneHeader.voice.screenShareModal.startSharing")}
          primary
          disabled={
            starting() ||
            (isElectron() && !useSystemScreenPicker() && !electronSourceId())
          }
          onClick={() => void startSharing()}
        />
      </Modal.Footer>
    </Modal.Root>
  );
}

function buildDisplayMediaConstraints(
  quality: LiveQuality,
  framerate: LiveFramerate,
  audio: boolean
): MediaStreamConstraints & {
  video: MediaTrackConstraints & { resizeMode: string };
} {
  const { width, height } = getLiveQualityDimensions(quality);
  return {
    video: {
      width,
      height,
      frameRate: framerate,
      resizeMode: "none"
    },
    audio: audio
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      : false
  };
}

function ElectronCaptureSourceList(props: { ref: (id: () => string | undefined) => void }) {
  const [sources, setSources] = createSignal<ElectronCaptureSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = createSignal<string | null>(null);

  createEffect(() => {
    props.ref(() => selectedSourceId() ?? undefined);
  });

  const fetchSources = async () => {
    const next = await electronWindowAPI()?.getDesktopCaptureSources();
    if (!next) return;

    if (!next.find((source) => source.id === selectedSourceId())) {
      setSelectedSourceId(null);
    }
    setSources(next);
  };

  onMount(() => {
    void fetchSources();
    // Polling no Linux abre o portal XDG a cada 3s — só atualiza no Windows.
    if (!isWindows) {
      return;
    }
    const timeoutId = window.setInterval(() => void fetchSources(), 3000);
    onCleanup(() => clearInterval(timeoutId));
  });

  return (
    <div class={style.sources}>
      <For each={sources()}>
        {(source) => (
          <SourceItem
            source={source}
            selected={selectedSourceId() === source.id}
            onClick={() => setSelectedSourceId(source.id)}
          />
        )}
      </For>
    </div>
  );
}

function SourceItem(props: {
  source: ElectronCaptureSource;
  selected?: boolean;
  onClick: () => void;
}) {
  const label = () =>
    props.source.name?.trim() ||
    (props.source.id.includes("screen")
      ? t("mainPaneHeader.voice.screenShareModal.screenSource")
      : t("mainPaneHeader.voice.screenShareModal.windowSource"));

  return (
    <button
      type="button"
      class={style.sourceItem}
      data-selected={props.selected}
      onClick={props.onClick}
      title={label()}
    >
      <img class={style.sourceImage} src={props.source.thumbnailUrl} alt="" />
      <span class={style.sourceText}>{label()}</span>
    </button>
  );
}
