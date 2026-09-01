import { createStore, reconcile } from "solid-js/store";
import { RawVoice } from "../RawData";
import { batch, createEffect, createMemo, createSignal, on } from "solid-js";
import { postGenerateCredential, postLiveKitToken } from "../services/VoiceService";
import { getVoiceIceServers } from "../voiceIceServers";
import { emitVoiceSignal } from "../emits/voiceEmits";

import type SimplePeer from "@thaunknown/simple-peer";
import useUsers, { User } from "./useUsers";
import {
  getStorageBoolean,
  getStorageObject,
  getStorageString,
  StorageKeys,
  useVoiceInputMode
} from "@/common/localStorage";
import useAccount from "./useAccount";
import vad from "voice-activity-detection";
import { downKeys, useGlobalKey } from "@/common/GlobalKey";
import { arrayEquals } from "@/common/arrayEquals";
import { LazySimplePeer } from "@/components/LazySimplePeer";
import { log } from "@/common/logger";
import {
  wrapMicWithNoiseSuppression,
  getMicGainLinear
} from "@/common/noiseSuppressor";
import {
  getVoiceMicConstraints,
  resolveNoiseSuppressionMode,
  clampVoiceVolumeLinear,
  effectiveRemoteVolume
} from "@/common/voiceAudioSettings";
import { setMediaElementVolume } from "@/common/voicePlaybackVolume";
import env from "@/common/env";
import { ConnectionState, Track } from "livekit-client";
import {
  connectLiveKitRoom,
  disconnectLiveKitRoom,
  publishLiveKitScreenShare,
  setLiveKitDeafened,
  setLiveKitMicrophoneEnabled,
  reapplyLiveKitRemoteVolumes,
  setLiveKitRemoteVolume,
  setLiveKitScreenShareSubscribed,
  unpublishLiveKitScreenShare
} from "../livekit/livekitRoom";

export function isLiveKitEnabled() {
  return env.LIVEKIT_ENABLED;
}

function playRemoteMedia(el: HTMLMediaElement) {
  const tryPlay = () => {
    void el.play().catch(() => {});
  };
  tryPlay();
  const unlock = () => {
    tryPlay();
    document.removeEventListener("pointerdown", unlock);
  };
  document.addEventListener("pointerdown", unlock, { once: true });
}

type StreamWithTracks = {
  stream: MediaStream;
  tracks: MediaStreamTrack[];
};

// cachedVolumes[userId] = volume
export const [cachedVolumes, setCachedVolumes] = createStore<
  Record<string, number>
>({});
// Live / screen-share audio volume (separate from mic call volume).
export const [cachedLiveVolumes, setCachedLiveVolumes] = createStore<
  Record<string, number>
>({});
// watchedLives[streamerUserId] = lives the local user chose to watch.
const [watchedLives, setWatchedLives] = createStore<Record<string, boolean>>(
  {}
);
// livePublishers[streamerUserId] = remotes currently publishing screen share
const [livePublishers, setLivePublishers] = createStore<Record<string, boolean>>(
  {}
);
// Placeholder so UI can show "LIVE / watch" before ScreenShare is subscribed.
const livePublisherPlaceholders = new Map<string, MediaStream>();
/** Delay clearing remote video UI during brief LiveKit ICE/resubscribe blips. */
const pendingVideoRemovals = new Map<string, ReturnType<typeof setTimeout>>();
const VIDEO_UNSUBSCRIBE_GRACE_MS = 2500;

function cancelPendingVideoRemoval(userId: string) {
  const timer = pendingVideoRemovals.get(userId);
  if (timer) {
    clearTimeout(timer);
    pendingVideoRemovals.delete(userId);
  }
}
// liveViewers[viewerUserId] = remotes currently watching our outbound live
const [liveViewers, setLiveViewers] = createStore<Record<string, boolean>>({});
export type ConnectionStatus = "CONNECTED" | "DISCONNECTED" | "CONNECTING";

export type VoiceUser = RawVoice & {
  user: () => User;
  peer?: SimplePeer.Instance;
  streamWithTracks?: StreamWithTracks[];
  audio?: HTMLAudioElement;
  voiceActivity?: boolean;
  vadInstance?: ReturnType<typeof vad>;
  connectionStatus: ConnectionStatus;
};

type ChannelUsersMap = Record<string, VoiceUser | undefined>;
type VoiceUsersMap = Record<string, ChannelUsersMap>;

// voiceUsers[channelId][userId] = VoiceUser
const [voiceUsers, setVoiceUsers] = createStore<VoiceUsersMap>({});
const [deafened, setDeafened] = createStore({
  enabled: false,
  wasMicEnabled: false
});

interface CurrentVoiceUser {
  channelId: string;
  audioStream: MediaStream | null;
  videoStream: MediaStream | null;
  originalAudioStream?: MediaStream | null;
  vadInstance?: ReturnType<typeof vad>;
  vadAudioStream?: MediaStream | null;
  micCleanup?: () => void;
}
const [currentVoiceUser, setCurrentVoiceUser] = createSignal<
  CurrentVoiceUser | undefined
>(undefined);

const { start, stop } = useGlobalKey();
const [voiceMode] = useVoiceInputMode();

createEffect(
  on(currentVoiceUser, (current) => {
    stop();
    if (!current?.channelId) return;
    if (voiceMode() !== "PTT") return;
    start();
  })
);

function toggleDeafen() {
  const newDeafenEnabled = !deafened.enabled;
  const currentUser = currentVoiceUser();
  if (!currentUser) return;

  const isMicEnabled = !!currentUser.audioStream;

  if (isLiveKitEnabled()) {
    setLiveKitDeafened(newDeafenEnabled);
  }

  const voiceUsers = getVoiceUsersByChannelId(currentUser.channelId);
  voiceUsers.forEach((voiceUser) => {
    if (voiceUser.audio) {
      voiceUser.audio.muted = newDeafenEnabled;
    }
  });

  if (!newDeafenEnabled && deafened.wasMicEnabled) {
    enableMic();
  }

  if (newDeafenEnabled && isMicEnabled) {
    disableMic();
  }

  batch(() => {
    setDeafened("enabled", newDeafenEnabled);
    setDeafened("wasMicEnabled", isMicEnabled);
  });
}

const micTrack = createMemo(() => {
  const current = currentVoiceUser();
  return current?.audioStream?.getAudioTracks()[0];
});

createEffect(
  on(
    () => downKeys.length,
    () => {
      const bound = getStorageObject(StorageKeys.PTTBoundKeys, []);
      if (!bound.length) return;
      const mic = micTrack();
      if (!mic) return;
      const current = currentVoiceUser();
      if (!current) return;

      if (!arrayEquals(downKeys, bound)) {
        mic.enabled = false;
        setVoiceUsers(current.channelId, useAccount().user()?.id!, {
          voiceActivity: false
        });
        return;
      }
      mic.enabled = true;
      setVoiceUsers(current.channelId, useAccount().user()?.id!, {
        voiceActivity: true
      });
    }
  )
);

const setCurrentChannelId = (channelId: string | null, reconnect = false) => {
  const current = currentVoiceUser();
  if (current?.channelId && current.channelId !== channelId) {
    removeAllPeers(current?.channelId);
    current.vadInstance?.destroy();
    current.vadAudioStream?.getAudioTracks()[0]?.stop();
    batch(() => {
      getVoiceUsersByChannelId(current.channelId).forEach((voiceUser) => {
        voiceUser.vadInstance?.destroy();
        setVoiceUsers(current.channelId, voiceUser.userId, {
          voiceActivity: false,
          vadInstance: undefined
        });
      });
    });
  }
  if (!channelId) {
    current?.micCleanup?.();
    void disconnectLiveKitRoom();
    setCurrentVoiceUser(undefined);
    setDeafened("wasMicEnabled", false);

    current?.audioStream?.getTracks().forEach((track) => {
      track.stop();
    });
    current?.videoStream?.getTracks().forEach((track) => {
      track.stop();
    });
    setWatchedLives(reconcile({}));
    setLivePublishers(reconcile({}));
    setLiveViewers(reconcile({}));
    livePublisherPlaceholders.clear();

    return;
  }
  if (!reconnect || !current || current.channelId !== channelId) {
    setCurrentVoiceUser({
      channelId,
      audioStream: current?.audioStream ?? null,
      videoStream: current?.videoStream ?? null,
      originalAudioStream: current?.originalAudioStream,
      vadAudioStream: current?.vadAudioStream ?? null,
      vadInstance: current?.vadInstance,
      micCleanup: current?.micCleanup
    });
  }

  if (isLiveKitEnabled()) {
    void connectLiveKitToChannel(channelId);
  }
};

let liveKitConnectTask: Promise<void> | null = null;
let liveKitConnectChannelId: string | null = null;

async function connectLiveKitToChannel(channelId: string) {
  if (liveKitConnectChannelId === channelId && liveKitConnectTask) {
    return liveKitConnectTask;
  }

  liveKitConnectChannelId = channelId;
  liveKitConnectTask = (async () => {
    if (getStorageBoolean(StorageKeys.voiceUseTurnServers, true)) {
      await postGenerateCredential().catch(() => {});
    }
    const auth = await postLiveKitToken(channelId);
    const latest = currentVoiceUser();
    if (!latest || latest.channelId !== channelId) return;

    await connectLiveKitRoom(auth, {
      onConnectionState: (state) => {
        if (state !== ConnectionState.Connected) return;
        const me = useAccount().user()?.id;
        getVoiceUsersByChannelId(channelId).forEach((voiceUser) => {
          if (voiceUser.userId === me) return;
          updateConnectionStatus(voiceUser, "CONNECTED");
        });
      },
      onParticipantConnected: (userId) => {
        const voiceUser = getVoiceUser(channelId, userId);
        if (voiceUser) updateConnectionStatus(voiceUser, "CONNECTED");
      },
      onParticipantDisconnected: (userId) => {
        const voiceUser = getVoiceUser(channelId, userId);
        if (voiceUser) updateConnectionStatus(voiceUser, "DISCONNECTED");
        setLivePublishers(userId, false);
        setWatchedLives(userId, false);
        livePublisherPlaceholders.delete(userId);
      },
      onScreenSharePublished: (userId) => {
        setLivePublishers(userId, true);
        // Discord-style: show remote lives automatically once they publish.
        if (userId !== useAccount().user()?.id) {
          setWatchedLives(userId, true);
          applyLiveWatch(userId, true);
        }
      },
      onScreenShareUnpublished: (userId) => {
        cancelPendingVideoRemoval(userId);
        setLivePublishers(userId, false);
        setWatchedLives(userId, false);
        livePublisherPlaceholders.delete(userId);
      },
      onScreenShareSync: (liveUserIds) => {
        const stillLive = new Set(liveUserIds);
        for (const userId of Object.keys(livePublishers)) {
          if (livePublishers[userId] && !stillLive.has(userId)) {
            cancelPendingVideoRemoval(userId);
            setLivePublishers(userId, false);
            setWatchedLives(userId, false);
            livePublisherPlaceholders.delete(userId);
          }
        }
      },
      onRemoteTrack: ({ userId, track, stream, source, audioElement }) => {
        const voiceUser = getVoiceUser(channelId, userId);
        if (!voiceUser) return;

        if (track.kind === "video") {
          cancelPendingVideoRemoval(userId);
        }

        pushVoiceUserTrack(voiceUser, track, stream);

        if (track.kind === "video") {
          applyIncomingVideoWatch(userId, track);
          // Ensure LiveKit screen share is visible (watch may have been set first).
          if (isLiveKitEnabled() && watchedLives[userId]) {
            track.enabled = true;
          }
        }

        if (source === Track.Source.Microphone && audioElement) {
          const volume = clampVoiceVolumeLinear(cachedVolumes[userId] || 1);
          setVoiceUsers(channelId, userId, "audio", audioElement as HTMLAudioElement);
          setLiveKitRemoteVolume(userId, volume, Track.Source.Microphone);
        }

        if (source === Track.Source.ScreenShareAudio && audioElement) {
          const volume = clampVoiceVolumeLinear(cachedLiveVolumes[userId] || 1);
          setLiveKitRemoteVolume(userId, volume, Track.Source.ScreenShareAudio);
        }

        updateConnectionStatus(voiceUser, "CONNECTED");
      },
      onRemoteTrackRemoved: ({ userId, kind, mediaTrackId }) => {
        const voiceUser = getVoiceUser(channelId, userId);
        if (!voiceUser?.streamWithTracks) return;

        // ICE blips unsubscribe briefly — don't wipe the tile for a few seconds.
        if (kind === "video" && isLiveKitEnabled()) {
          cancelPendingVideoRemoval(userId);
          const timer = setTimeout(() => {
            pendingVideoRemovals.delete(userId);
            const latest = getVoiceUser(channelId, userId);
            if (!latest?.streamWithTracks) return;
            const filtered = latest.streamWithTracks
              .map((entry) => ({
                stream: entry.stream,
                // Only drop the specific track that unsubscribed — a
                // stop+restart within the grace window republishes a new
                // track id, which must survive this stale timer.
                tracks: entry.stream
                  .getTracks()
                  .filter(
                    (t) =>
                      t.readyState !== "ended" &&
                      (t.kind !== "video" || t.id !== mediaTrackId)
                  )
              }))
              .filter((entry) => entry.tracks.length > 0);
            setVoiceUsers(channelId, userId, "streamWithTracks", filtered);
          }, VIDEO_UNSUBSCRIBE_GRACE_MS);
          pendingVideoRemovals.set(userId, timer);
          return;
        }

        const filtered = voiceUser.streamWithTracks
          .map((entry) => ({
            stream: entry.stream,
            tracks: entry.stream
              .getTracks()
              .filter((t) => t.readyState !== "ended")
          }))
          .filter((entry) => entry.tracks.length > 0);

        setVoiceUsers(channelId, userId, "streamWithTracks", filtered);
        if (
          kind === "audio" &&
          !filtered.some((s) => s.tracks.some((t) => t.kind === "audio"))
        ) {
          setVoiceUsers(channelId, userId, "audio", undefined);
        }
      }
    });
  })();

  try {
    await liveKitConnectTask;
  } catch (err) {
    log("RTC", "Failed to connect LiveKit", err);
  } finally {
    if (liveKitConnectChannelId === channelId) {
      liveKitConnectTask = null;
      liveKitConnectChannelId = null;
    }
  }
}

const activeRemoteStream = (userId: string, kind: "audio" | "video") => {
  const current = currentVoiceUser();
  if (!current) return;
  const voiceUser = getVoiceUser(current.channelId, userId);
  if (!voiceUser) return;

  if (kind === "audio") {
    const streams = voiceUser.streamWithTracks || [];
    // Prefer mic-only streams; fall back to any stream that still has audio
    // (e.g. screen share with system audio mixed in).
    return (
      streams.find((s) => s.tracks.every((t) => t.kind === "audio"))?.stream ||
      streams.find((s) => s.tracks.some((t) => t.kind === "audio"))?.stream
    );
  }
  const videoStreams = voiceUser.streamWithTracks || [];
  // A quick stop+restart of a screen share can leave the old (now-ended)
  // stream sitting in front of the freshly republished one for a moment —
  // prefer a stream whose track is still live so the tile doesn't freeze
  // on the last frame of the previous share.
  return (
    videoStreams.find((s) =>
      s.tracks.some((t) => t.kind === kind && t.readyState !== "ended")
    )?.stream ||
    videoStreams.find((s) => s.tracks.some((t) => t.kind === kind))?.stream
  );
};

const removeAllPeers = (channelIdToRemove?: string) => {
  batch(() => {
    for (const channelId in voiceUsers) {
      for (const userId in voiceUsers[channelId]) {
        const voiceUser = getVoiceUser(channelId, userId);
        if (!voiceUser) continue;
        if (channelIdToRemove && voiceUser?.channelId !== channelIdToRemove)
          continue;
        voiceUser.peer?.destroy();
        voiceUser.vadInstance?.destroy();
        voiceUser.audio?.remove();
        setVoiceUsers(channelId, userId, "peer", undefined);
        setVoiceUsers(channelId, userId, "streamWithTracks", []);
      }
    }
  });
};

const getVoiceUsersByChannelId = (id: string) => {
  return Object.values(voiceUsers[id] || {}) as VoiceUser[];
};

const getVoiceUser = (channelId?: string, userId?: string) => {
  return voiceUsers[channelId!]?.[userId!];
};
const removeVoiceUser = (channelId: string, userId: string) => {
  const voiceUser = getVoiceUser(channelId, userId);
  if (!voiceUser) return;
  batch(() => {
    voiceUser?.vadInstance?.destroy();
    voiceUser.peer?.destroy();
    voiceUser.audio?.remove();
    setVoiceUsers(channelId, userId, undefined);
    setLiveViewers(userId, false);
    setWatchedLives(userId, false);
  });
};

const createVoiceUser = (rawVoice: RawVoice, reconnecting = false) => {
  const account = useAccount();
  const users = useUsers();

  if (!voiceUsers[rawVoice.channelId]) {
    setVoiceUsers(rawVoice.channelId, {});
  }

  {
    const user = users.get(rawVoice.userId);
    user?.setVoiceChannelId(rawVoice.channelId);
  }

  const newVoiceUser: VoiceUser = {
    connectionStatus: "CONNECTING",
    ...rawVoice,
    user,
    streamWithTracks: []
  };

  if (!reconnecting || rawVoice.userId !== account.user()?.id) {
    setVoiceUsers(rawVoice.channelId, rawVoice.userId, newVoiceUser);
  }

  const isCurrentUserInVoice =
    rawVoice.channelId === currentVoiceUser()?.channelId;

  if (isCurrentUserInVoice) {
    if (isLiveKitEnabled()) {
      updateConnectionStatus(newVoiceUser, "CONNECTED");
      return;
    }
    if (!reconnecting) {
      createPeer(newVoiceUser);
    }
  }
};

function user(this: VoiceUser) {
  const users = useUsers();
  return users.get(this.userId)!;
}

const updateConnectionStatus = (
  voiceUser: VoiceUser,
  status: ConnectionStatus
) => {
  try {
    setVoiceUsers(
      voiceUser.channelId,
      voiceUser.userId,
      "connectionStatus",
      status
    );
  } catch {
    /* empty */
  }
};

type LiveWatchMessage = { t: "liveWatch"; watch: boolean };

const sendLiveWatchMessage = (
  peer: SimplePeer.Instance | undefined,
  watch: boolean
) => {
  if (!peer) return;
  const payload: LiveWatchMessage = { t: "liveWatch", watch };
  try {
    peer.send(JSON.stringify(payload));
  } catch (err) {
    log("RTC", "Failed to send live watch state", err);
  }
};

const handlePeerData = (voiceUser: VoiceUser, data: unknown) => {
  let parsed: Partial<LiveWatchMessage>;
  try {
    const text =
      typeof data === "string"
        ? data
        : new TextDecoder().decode(data as ArrayBufferView);
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (parsed?.t !== "liveWatch") return;

  setLiveViewers(voiceUser.userId, !!parsed.watch);
  log(
    "RTC",
    voiceUser.user().username,
    parsed.watch ? "started watching our live" : "stopped watching our live"
  );
};

const createPeer = (voiceUser: VoiceUser, signal?: SimplePeer.SignalData) => {
  if (isLiveKitEnabled()) return;
  if (!LazySimplePeer) {
    console.log("No LazySimplePeer");
    return;
  }
  const current = currentVoiceUser();
  if (voiceUser.userId === useAccount().user()?.id) return;
  const initiator = !signal;

  const streams: MediaStream[] = [];
  if (current?.audioStream) {
    streams.push(current.audioStream);
  }
  if (current?.videoStream) {
    streams.push(current.videoStream);
  }

  const peer =
    voiceUser.peer ||
    new LazySimplePeer({
      initiator,
      trickle: true,
      config: {
        iceServers: getVoiceIceServers()
      },
      streams
    });

  setVoiceUsers(voiceUser.channelId, voiceUser.userId, "peer", peer);

  peer.on("data", (data) => handlePeerData(voiceUser, data));

  peer.on("connect", () => {
    log("RTC", "Connected to", voiceUser.user().username + "!");
    updateConnectionStatus(voiceUser, "CONNECTED");
    sendLiveWatchMessage(peer, !!watchedLives[voiceUser.userId]);
  });
  peer.on("end", () => {
    log("RTC", "Disconnected from", voiceUser.user().username + ".");
    updateConnectionStatus(voiceUser, "DISCONNECTED");
  });
  peer.on("close", () => {
    log("RTC", voiceUser.user().username, "disconnected.");
    updateConnectionStatus(voiceUser, "DISCONNECTED");
  });
  peer.on("error", (err) => {
    console.error(err);
  });
  peer.on("signal", (data) => {
    emitVoiceSignal(voiceUser.channelId, voiceUser.userId, data);
  });

  peer.on("track", (track, stream) => {
    const channelId = voiceUser.channelId;
    const userId = voiceUser.userId;

    stream.onremovetrack = (event) => {
      const newVoiceUser = getVoiceUser(channelId, userId);
      const activeAudioStream = activeRemoteStream(userId, "audio");
      if (activeAudioStream?.id === stream.id) {
        newVoiceUser?.vadInstance?.destroy();
        setVoiceUsers(channelId, userId, {
          voiceActivity: false,
          vadInstance: undefined
        });
      }

      const streams = newVoiceUser?.streamWithTracks;
      if (!streams) return;
      const streamWithTracksIndex = streams.findIndex(
        (s) => s.stream?.id === stream?.id
      );
      const tracks = streams[streamWithTracksIndex]?.tracks;

      const newTracks = tracks?.filter((t) => t.id !== event.track.id);
      if (!newTracks?.length) {
        const newStreamWithTracks = streams.filter(
          (s) => s.stream?.id !== stream?.id
        );
        setVoiceUsers(
          channelId,
          userId,
          "streamWithTracks",
          newStreamWithTracks
        );
        return;
      }

      setVoiceUsers(
        channelId,
        userId,
        "streamWithTracks",
        streamWithTracksIndex,
        "tracks",
        newTracks
      );
    };

    pushVoiceUserTrack(voiceUser, track, stream);
    if (track.kind === "video") {
      applyIncomingVideoWatch(userId, track);
    }

    const newVoiceUser = getVoiceUser(channelId, userId);

    const streams = newVoiceUser?.streamWithTracks;
    if (!streams) return;

    const audio = newVoiceUser.audio || new Audio();
    const volume = clampVoiceVolumeLinear(cachedVolumes[userId] || 1);
    setMediaElementVolume(audio, effectiveRemoteVolume(volume));
    if (deafened.enabled) audio.muted = true;
    const deviceId = getStorageString(StorageKeys.outputDeviceId, undefined);
    if (deviceId) {
      audio.setSinkId(JSON.parse(deviceId));
    }
    const activeAudio = activeRemoteStream(userId, "audio");

    newVoiceUser.vadInstance?.destroy();

    const vadInstance = createVadInstance(activeAudio, undefined, userId);
    batch(() => {
      setVoiceUsers(channelId, userId, "vadInstance", vadInstance);

      audio.srcObject = activeAudio || null;
      playRemoteMedia(audio);
      if (!audio.srcObject) {
        setVoiceUsers(channelId, userId, "audio", undefined);
      }
      setVoiceUsers(channelId, userId, "audio", audio);
    });
  });

  if (signal) {
    peer.signal(signal);
  }
};

function createVadInstance(
  vadStream?: MediaStream,
  originalStream?: MediaStream,
  userId?: string
) {
  if (!vadStream) return;
  const account = useAccount();

  const originalStreamTrack = originalStream?.getAudioTracks()[0];

  const current = currentVoiceUser();
  if (!current) return;
  const audioContext = new AudioContext();
  // Browsers start AudioContext suspended until a user gesture; without resume
  // VOICE_ACTIVITY never opens the outbound mic track.
  void audioContext.resume();

  let stopTimer: number | undefined;
  const clearStopTimer = () => {
    if (stopTimer) {
      window.clearTimeout(stopTimer);
      stopTimer = undefined;
    }
  };

  const setTalking = (talking: boolean) => {
    setVoiceUsers(current.channelId, userId || account.user()?.id!, {
      voiceActivity: talking
    });
    if (originalStreamTrack) {
      originalStreamTrack.enabled = talking;
    }
  };

  // Local gate was 0.15 (too high for many mics) → unmuted but silent to peers.
  const vadInstance = vad(audioContext, vadStream, {
    fftSize: 1024,
    smoothingTimeConstant: 0.4,
    minCaptureFreq: 80,
    maxCaptureFreq: 4000,
    ...(!userId
      ? {
          minNoiseLevel: 0.035,
          maxNoiseLevel: 0.7,
          avgNoiseMultiplier: 1,
          noiseCaptureDuration: 0
        }
      : {
          minNoiseLevel: 0,
          noiseCaptureDuration: 100,
          avgNoiseMultiplier: 0.1,
          maxNoiseLevel: 0.01
        }),

    onVoiceStart: function () {
      clearStopTimer();
      setTalking(true);
    },
    onVoiceStop: function () {
      clearStopTimer();
      // Keep the mic open between words so speech is not clipped.
      stopTimer = window.setTimeout(() => {
        setTalking(false);
        stopTimer = undefined;
      }, userId ? 180 : 550);
    }
  });

  const destroy = vadInstance.destroy.bind(vadInstance);
  vadInstance.destroy = () => {
    clearStopTimer();
    destroy();
    void audioContext.close();
  };

  return vadInstance;
}

const pushVoiceUserTrack = (
  voiceUser: VoiceUser,
  track: MediaStreamTrack,
  stream: MediaStream
) => {
  const channelId = voiceUser.channelId;
  const userId = voiceUser.userId;

  const newVoiceUser = getVoiceUser(channelId, userId);

  const streams = newVoiceUser?.streamWithTracks;
  if (!streams) return;

  const streamWithTracksIndex = streams.findIndex(
    (s) => s.stream.id === stream.id
  );
  const streamWithTracks = streams[streamWithTracksIndex];

  if (streamWithTracks && streamWithTracksIndex >= 0) {
    setVoiceUsers(
      channelId,
      userId,
      "streamWithTracks",
      streamWithTracksIndex,
      {
        tracks: [...streamWithTracks.tracks, track]
      }
    );
    return;
  }

  setVoiceUsers(channelId, userId, "streamWithTracks", streams.length, {
    stream,
    tracks: [track]
  });
};

const disableMic = () => {
  const userId = useAccount().user()?.id!;
  const current = currentVoiceUser();
  if (!current) return;

  if (current.audioStream) {
    current.vadInstance?.destroy();

    current.vadAudioStream?.getTracks().forEach((track) => {
      track.stop();
    });
    if (isLiveKitEnabled()) {
      void setLiveKitMicrophoneEnabled(false);
    } else {
      removeStream(current.audioStream);
    }
    current.micCleanup?.();
    setCurrentVoiceUser({
      ...current,
      audioStream: null,
      originalAudioStream: null,
      vadInstance: undefined,
      vadAudioStream: null,
      micCleanup: undefined
    });
    setVoiceUsers(current.channelId, userId, {
      voiceActivity: false
    });

    return;
  }
};

const getStoredMicConstraints = (): MediaTrackConstraints => {
  const constraints = getVoiceMicConstraints();
  const noiseMode = resolveNoiseSuppressionMode(constraints);

  return {
    echoCancellation: constraints.echo,
    // Browser NS only in "browser" mode — enhanced uses RNNoise instead.
    noiseSuppression: noiseMode === "browser",
    autoGainControl: constraints.gain
  };
};

const getUserMic = (shouldLog = true) => {
  const deviceId = getStorageString(StorageKeys.inputDeviceId, undefined);
  const audioConstraints = getStoredMicConstraints();

  const rtcLog = (...args: unknown[]) => {
    if (shouldLog) {
      log("RTC", ...args);
    }
  };

  if (!deviceId) {
    rtcLog("Using Default Microphone");
    return navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false
    });
  }
  const parsedDeviceId = JSON.parse(deviceId);
  return navigator.mediaDevices
    .getUserMedia({
      audio: {
        ...audioConstraints,
        deviceId: { exact: parsedDeviceId }
      },
      video: false
    })
    .then((stream) => {
      rtcLog("Using Microphone with deviceId", parsedDeviceId);
      return stream;
    })
    .catch(() => {
      rtcLog(
        "Failed to get microphone with deviceId",
        parsedDeviceId,
        "Falling back to default microphone"
      );
      return navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });
    });
};

const enableMic = async () => {
  const current = currentVoiceUser();
  if (!current) return;

  if (current.audioStream) {
    return;
  }
  const rawStream = await getUserMic();
  const noiseMode = resolveNoiseSuppressionMode(getVoiceMicConstraints());
  // Process before publish: LiveKit encodes Opus of whatever track we give it.
  const wrapped = await wrapMicWithNoiseSuppression(rawStream, noiseMode);
  wrapped.setGain(getMicGainLinear());
  const stream = wrapped.stream;

  let vadStream: MediaStream | undefined;
  let vadInstance: ReturnType<typeof vad> | undefined;

  if (voiceMode() === "OPEN") {
    setVoiceUsers(current.channelId, useAccount().user()?.id!, {
      voiceActivity: true
    });
  }

  if (voiceMode() === "VOICE_ACTIVITY") {
    // Detect on the real mic. Cloning the processed dest stream is silent in Chrome.
    vadStream = wrapped.originalStream.clone();
  }

  if (voiceMode() !== "OPEN") {
    stream.getAudioTracks()[0]!.enabled = false;
  }

  if (voiceMode() === "VOICE_ACTIVITY") {
    vadInstance = createVadInstance(vadStream, stream);
  } else if (voiceMode() === "OPEN") {
    vadInstance = createVadInstance(stream);
  }

  if (isLiveKitEnabled()) {
    const micTrack = stream.getAudioTracks()[0];
    await setLiveKitMicrophoneEnabled(true, micTrack);
  } else {
    addStreamToPeers(stream);
  }

  setCurrentVoiceUser({
    ...current,
    audioStream: stream,
    originalAudioStream: wrapped.originalStream,
    vadInstance,
    vadAudioStream: vadStream,
    micCleanup: wrapped.dispose
  });
};

const restartMic = async () => {
  const current = currentVoiceUser();
  if (!current?.audioStream) return;
  disableMic();
  await enableMic();
};

const toggleMic = async () => {
  const current = currentVoiceUser();
  if (!current) return;

  if (current.audioStream) {
    disableMic();
    return;
  }
  enableMic();
};

const setVideoStream = (stream: MediaStream | null) => {
  const current = currentVoiceUser();
  if (!current) return;
  if (current.videoStream) {
    if (isLiveKitEnabled()) {
      void unpublishLiveKitScreenShare();
    } else {
      removeStream(current.videoStream);
    }
  }
  setCurrentVoiceUser({ ...current, videoStream: stream });

  if (!stream) return;

  if (isLiveKitEnabled()) {
    void publishLiveKitScreenShare(stream).catch((err) => {
      log("RTC", "Failed to publish LiveKit screen share", err);
    });
  } else {
    addStreamToPeers(stream);
  }

  const videoTrack = stream.getVideoTracks()[0]!;

  videoTrack.onended = () => {
    if (isLiveKitEnabled()) {
      void unpublishLiveKitScreenShare();
    } else {
      removeStream(stream);
    }
    setCurrentVoiceUser({ ...current, videoStream: null });
    videoTrack.onended = null;
  };
};

const removeStream = (stream: MediaStream) => {
  removeStreamFromPeers(stream);
  stream.getTracks().forEach((track) => {
    track.stop();
  });
};

const addStreamToPeers = (stream: MediaStream) => {
  const current = currentVoiceUser();
  if (!current) return;
  const voiceUsers = getVoiceUsersByChannelId(current.channelId);

  voiceUsers.forEach((voiceUser) => {
    voiceUser.peer?.addStream(stream);
  });
};

const removeStreamFromPeers = (stream: MediaStream) => {
  const current = currentVoiceUser();
  if (!current) return;
  const voiceUsers = getVoiceUsersByChannelId(current.channelId);

  voiceUsers.forEach((voiceUser) => {
    voiceUser.peer?.removeStream(stream);
  });
};

const signal = (voiceUser: VoiceUser, signal: SimplePeer.SignalData) => {
  if (!voiceUser.peer) {
    console.error("No peer for voice user", voiceUser);
    return;
  }

  voiceUser.peer.signal(signal);
};

function resetAll() {
  const account = useAccount();
  const current = currentVoiceUser();
  batch(() => {
    removeAllPeers();
    // setCurrentVoiceUser(undefined);

    if (current) {
      const currentVoiceUser = getVoiceUser(
        current.channelId,
        account.user()?.id!
      );
      if (currentVoiceUser) {
        setVoiceUsers(
          reconcile({
            [current.channelId]: { [account.user()?.id!]: currentVoiceUser }
          })
        );
      }
    } else {
      setVoiceUsers(reconcile({}));
    }
  });
}

const micEnabled = (userId: string) => {
  const account = useAccount();
  if (account.user()?.id === userId) {
    const currentUser = currentVoiceUser();
    return !!currentUser?.audioStream;
  }
  return activeRemoteStream(userId, "audio");
};

const remoteVideoTracks = (userId: string) => {
  const current = currentVoiceUser();
  if (!current) return [];
  const voiceUser = getVoiceUser(current.channelId, userId);
  const tracks: MediaStreamTrack[] = [];
  voiceUser?.streamWithTracks?.forEach((entry) => {
    entry.tracks.forEach((track) => {
      if (track.kind === "video") tracks.push(track);
    });
  });
  return tracks;
};

const applyLiveWatch = (userId: string, watch: boolean) => {
  remoteVideoTracks(userId).forEach((track) => {
    track.enabled = watch;
  });
};

const applyIncomingVideoWatch = (
  userId: string,
  track: MediaStreamTrack
) => {
  if (userId === useAccount().user()?.id) {
    track.enabled = true;
    return;
  }
  // LiveKit: never leave remote video disabled — subscribe/unsubscribe controls bandwidth.
  if (isLiveKitEnabled()) {
    track.enabled = true;
    return;
  }
  track.enabled = !!watchedLives[userId];
};

const isLiveWatched = (userId: string) => {
  if (useAccount().user()?.id === userId) return true;
  return !!watchedLives[userId];
};

const setLiveWatched = (userId: string, watch: boolean) => {
  if (useAccount().user()?.id === userId) return;
  setWatchedLives(userId, watch);
  applyLiveWatch(userId, watch);

  if (isLiveKitEnabled()) {
    // Keep LiveKit subscription always on — hide/show is UI-only.
    // Unsubscribing on hide dropped remote frames and caused "Nenhuma live selecionada".
    if (watch) setLiveKitScreenShareSubscribed(userId, true);
    return;
  }

  const current = currentVoiceUser();
  if (!current) return;
  sendLiveWatchMessage(getVoiceUser(current.channelId, userId)?.peer, watch);
};

const toggleLiveWatched = (userId: string) => {
  setLiveWatched(userId, !isLiveWatched(userId));
};

const videoEnabled = (userId: string) => {
  const account = useAccount();
  if (account.user()?.id === userId) {
    const currentUser = currentVoiceUser();
    return currentUser?.videoStream;
  }
  const remote = activeRemoteStream(userId, "video");
  if (remote?.getVideoTracks().some((t) => t.readyState !== "ended")) {
    return remote;
  }
  // LiveKit: publisher flag keeps LIVE badge / stage slot before TrackSubscribed.
  if (isLiveKitEnabled() && livePublishers[userId]) {
    let placeholder = livePublisherPlaceholders.get(userId);
    if (!placeholder) {
      placeholder = new MediaStream();
      livePublisherPlaceholders.set(userId, placeholder);
    }
    return placeholder;
  }
  return undefined;
};

/** True when there is at least one usable video track (not an empty placeholder). */
const hasLiveVideoFrames = (userId: string) => {
  const stream = videoEnabled(userId);
  return !!stream
    ?.getVideoTracks()
    .some((t) => t.readyState !== "ended" && t.enabled !== false);
};

function reapplyAllRemoteVolumes() {
  reapplyLiveKitRemoteVolumes();
  if (isLiveKitEnabled()) return;
  const current = currentVoiceUser();
  if (!current) return;
  const users = getVoiceUsersByChannelId(current.channelId);
  for (const voiceUser of users) {
    const audio = voiceUser.audio;
    if (!audio) continue;
    const volume = clampVoiceVolumeLinear(cachedVolumes[voiceUser.userId] || 1);
    setMediaElementVolume(audio, effectiveRemoteVolume(volume));
    if (deafened.enabled) audio.muted = true;
  }
}

export default function useVoiceUsers() {
  return {
    createPeer,
    createVoiceUser,
    getVoiceUser,
    getVoiceUsersByChannelId,
    signal,
    removeVoiceUser,
    setCurrentChannelId,
    currentUser: currentVoiceUser,
    activeRemoteStream,
    videoEnabled,
    hasLiveVideoFrames,
    toggleMic,
    restartMic,
    setVideoStream,
    resetAll,

    isLocalMicMuted: () => !currentVoiceUser()?.audioStream,

    micEnabled,
    toggleDeafen,
    deafened,
    isLiveWatched,
    setLiveWatched,
    toggleLiveWatched,
    isLiveKitEnabled,
    reapplyAllRemoteVolumes
  };
}
