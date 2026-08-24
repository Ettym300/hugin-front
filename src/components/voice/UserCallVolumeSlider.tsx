import { Show } from "solid-js";
import { t } from "@nerimity/i18lite";
import { Track } from "livekit-client";
import useStore from "@/chat-api/store/useStore";
import {
  cachedLiveVolumes,
  cachedVolumes,
  setCachedLiveVolumes,
  setCachedVolumes
} from "@/chat-api/store/useVoiceUsers";
import { isLiveKitSfuMode } from "@/common/liveStreamEncoding";
import { setLiveKitRemoteVolume } from "@/chat-api/livekit/livekitRoom";
import { MAX_OUTPUT_GAIN_PERCENT } from "@/common/outputGain";
import Text from "../ui/Text";
import styles from "./UserCallVolumeSlider.module.scss";

const maxLinear = () => MAX_OUTPUT_GAIN_PERCENT / 100;

export function UserCallVolumeSlider(props: { userId: string }) {
  const store = useStore();
  const isMe = () => props.userId === store.account.user()?.id;
  const inSameCall = () =>
    !!store.voiceUsers.getVoiceUser(
      store.voiceUsers.currentUser()?.channelId!,
      props.userId
    ) && !isMe();
  const isStreaming = () => store.voiceUsers.videoEnabled(props.userId);
  const voiceVolume = () => cachedVolumes[props.userId] ?? 1;
  const liveVolume = () => cachedLiveVolumes[props.userId] ?? 1;
  const audio = () =>
    store.voiceUsers.getVoiceUser(
      store.voiceUsers.currentUser()?.channelId!,
      props.userId
    )?.audio;

  const applyVoiceVolume = (volume: number) => {
    setCachedVolumes(props.userId, volume);
    if (isLiveKitSfuMode()) {
      setLiveKitRemoteVolume(props.userId, volume, Track.Source.Microphone);
      return;
    }
    const el = audio();
    if (el) el.volume = Math.min(1, volume);
  };

  const applyLiveVolume = (volume: number) => {
    setCachedLiveVolumes(props.userId, volume);
    if (isLiveKitSfuMode()) {
      setLiveKitRemoteVolume(props.userId, volume, Track.Source.ScreenShare);
      setLiveKitRemoteVolume(
        props.userId,
        volume,
        Track.Source.ScreenShareAudio
      );
    }
  };

  return (
    <Show when={inSameCall()}>
      <div class={styles.voiceVolume}>
        <div class={styles.row}>
          <div class={styles.label}>{t("userContextMenu.userVolume")}</div>
          <Text size={12} opacity={0.8}>
            {Math.round(voiceVolume() * 100)}%
          </Text>
        </div>
        <input
          type="range"
          min={0}
          max={maxLinear()}
          step={0.01}
          value={voiceVolume()}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onInput={(event) =>
            applyVoiceVolume(Number(event.currentTarget.value))
          }
        />
      </div>
      <Show when={isStreaming()}>
        <div class={styles.voiceVolume}>
          <div class={styles.row}>
            <div class={styles.label}>{t("userContextMenu.liveVolume")}</div>
            <Text size={12} opacity={0.8}>
              {Math.round(liveVolume() * 100)}%
            </Text>
          </div>
          <input
            type="range"
            min={0}
            max={maxLinear()}
            step={0.01}
            value={liveVolume()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onInput={(event) =>
              applyLiveVolume(Number(event.currentTarget.value))
            }
          />
        </div>
      </Show>
    </Show>
  );
}
