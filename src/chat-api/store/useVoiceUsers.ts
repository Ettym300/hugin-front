import { createStore, reconcile } from "solid-js/store";
import { RawVoice } from "../RawData";
import { batch, createEffect, createMemo, createSignal, on } from "solid-js";
import {
  getCachedCredentials,
  postLiveKitToken
} from "../services/VoiceService";
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

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: ["stun:stun.l.google.com:19302"]
  },
  {
    urls: "stun:stun.relay.metered.ca:80"
  },
  {
    urls: "turn:a.relay.metered.ca:80",
    username: "b9fafdffb3c428131bd9ae10",
    credential: "DTk2mXfXv4kJYPvD"
  },
  {
    urls: "turn:a.relay.metered.ca:80?transport=tcp",
    username: "b9fafdffb3c428131bd9ae10",
    credential: "DTk2mXfXv4kJYPvD"
  },
  {
    urls: "turn:a.relay.metered.ca:443",
    username: "b9fafdffb3c428131bd9ae10",
    credential: "DTk2mXfXv4kJYPvD"
  },
  {
    urls: "turn:a.relay.metered.ca:443?transport=tcp",
    username: "b9fafdffb3c428131bd9ae10",
    credential: "DTk2mXfXv4kJYPvD"
  }
];

function asIceServerList(value: unknown): RTCIceServer[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => asIceServerList(item));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.iceServers) return asIceServerList(obj.iceServers);
    if (obj.urls || obj.url) return [value as RTCIceServer];
  }
  return [];
}

const createIceServers = (): RTCIceServer[] => {
  // Avoid [null, ...] when Cloudflare TURN credentials were never fetched (DEV).
  const extra = getStorageBoolean(StorageKeys.voiceUseTurnServers, true)
    ? asIceServerList(getCachedCredentials())
    : [];
  return [...extra, ...FALLBACK_ICE_SERVERS];
};

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
  if (current?.channelId) {
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
  if (!reconnect) {
    setCurrentVoiceUser({
      channelId,
      audioStream: null,
      videoStream: null,
      vadAudioStream: null,
      vadInstance: undefined,
      micMuted: true
    });
  }

  if (isLiveKitEnabled()) {
    void connectLiveKitToChannel(channelId);
  }
};

async function connectLiveKitToChannel(channelId: string) {
  try {
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
      },
      onScreenShareUnpublished: (userId) => {
        setLivePublishers(userId, false);
        setWatchedLives(userId, false);
        livePublisherPlaceholders.delete(userId);
      },
      onRemoteTrack: ({ userId, track, stream, source, audioElement }) => {
        const voiceUser = getVoiceUser(channelId, userId);
        if (!voiceUser) return;

        pushVoiceUserTrack(voiceUser, track, stream);

        if (track.kind === "video") {
          applyIncomingVideoWatch(userId, track);
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
      onRemoteTrackRemoved: ({ userId, kind }) => {
        const voiceUser = getVoiceUser(channelId, userId);
        if (!voiceUser?.streamWithTracks) return;

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
  } catch (err) {
    log("RTC", "Failed to connect LiveKit", err);
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
  return voiceUser.streamWithTracks?.find((stream) =>
    stream.tracks.find((track) => track.kind === kind)
  )?.stream;
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
        iceServers: createIceServers()
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
  let noiseMode = resolveNoiseSuppressionMode(getVoiceMicConstraints());
  // LiveKit already encodes Opus — skip RNNoise re-encode.
  if (isLiveKitEnabled() && noiseMode === "enhanced") {
    noiseMode = "browser";
  }
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
    setLiveKitScreenShareSubscribed(userId, watch);
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
  if (remote) return remote;
  // LiveKit: screen share is only subscribed after watch — use publisher flag.
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
