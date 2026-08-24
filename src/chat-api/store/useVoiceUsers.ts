import { createStore, reconcile } from "solid-js/store";
import { RawVoice } from "../RawData";
import { batch, createEffect, createMemo, createSignal, on } from "solid-js";
import { getCachedCredentials } from "../services/VoiceService";
import { emitVoiceSignal } from "../emits/voiceEmits";

import type SimplePeer from "@thaunknown/simple-peer";
import useUsers, { User } from "./useUsers";
import {
  getStorageBoolean,
  getStorageNumber,
  getStorageObject,
  setStorageObject,
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
import { wrapMicWithNoiseSuppression, preloadNoiseSuppressor, getMicGainLinear } from "@/common/noiseSuppressor";
import {
  applyHardwarePreferredVideoEncoding,
  clampLiveBitrateKbps,
  getEffectiveLiveBitrateKbps,
  getEffectiveLiveFramerate,
  prepareOutgoingVideoTrack
} from "@/common/liveStreamEncoding";
import {
  getVoiceMicConstraints,
  resolveNoiseSuppressionMode
} from "@/common/voiceAudioSettings";
import env from "@/common/env";
import {
  connectLiveKitRoom,
  disconnectLiveKitRoom,
  publishLiveKitScreenShare,
  setLiveKitDeafened,
  setLiveKitMicrophoneEnabled,
  setLiveKitRemoteVolume,
  setLiveKitScreenShareSubscribed,
  setLiveKitAudioOutput,
  setLiveKitOutputGain,
  unpublishLiveKitScreenShare
} from "@/chat-api/livekit/livekitRoom";
import {
  MAX_OUTPUT_GAIN_PERCENT,
  getOutputGainLinear
} from "@/common/outputGain";
import { postLiveKitToken } from "../services/VoiceService";
import { ConnectionState, Track } from "livekit-client";

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

// cachedVolumes[userId] = voice volume
export const [cachedVolumes, setCachedVolumes] = createStore<
  Record<string, number>
>({});
// cachedLiveVolumes[userId] = screen-share / live audio volume
export const [cachedLiveVolumes, setCachedLiveVolumes] = createStore<
  Record<string, number>
>({});
// watchedLives[streamerUserId] = lives the local user chose to watch.
const [watchedLives, setWatchedLives] = createStore<Record<string, boolean>>(
  {}
);
// livePublishers[streamerUserId] = remote users currently publishing screen share
const [livePublishers, setLivePublishers] = createStore<Record<string, boolean>>(
  {}
);
const emptyLiveStreams = new Map<string, MediaStream>();
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
  originalAudioStream?: MediaStream | null;
  videoStream: MediaStream | null;
  vadInstance?: ReturnType<typeof vad>;
  vadAudioStream?: MediaStream | null;
  micCleanup?: () => void;
  micSetGain?: (linear: number) => void;
  micMuted?: boolean;
}
const [currentVoiceUser, setCurrentVoiceUser] = createSignal<
  CurrentVoiceUser | undefined
>(undefined);

const { start, stop } = useGlobalKey();
const [voiceMode] = useVoiceInputMode();
let enableMicGeneration = 0;
let missingPeerTimer: number | undefined;

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

  const voiceUsers = getVoiceUsersByChannelId(currentUser.channelId);
  voiceUsers.forEach((voiceUser) => {
    if (voiceUser.audio) {
      voiceUser.audio.muted = newDeafenEnabled;
    }
  });

  if (isLiveKitEnabled()) {
    setLiveKitDeafened(newDeafenEnabled);
  }

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
  if (missingPeerTimer) {
    window.clearTimeout(missingPeerTimer);
    missingPeerTimer = undefined;
  }
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
    enableMicGeneration++;
    void disconnectLiveKitRoom();
    setCurrentVoiceUser(undefined);
    setDeafened("wasMicEnabled", false);

    current?.micCleanup?.();
    current?.audioStream?.getTracks().forEach((track) => {
      track.stop();
    });
    current?.originalAudioStream?.getTracks().forEach((track) => {
      track.stop();
    });
    current?.videoStream?.getTracks().forEach((track) => {
      track.stop();
    });
    setWatchedLives(reconcile({}));
    setLiveViewers(reconcile({}));
    setLivePublishers(reconcile({}));
    emptyLiveStreams.clear();

    return;
  }
  void preloadNoiseSuppressor();
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
    return;
  }

  missingPeerTimer = window.setTimeout(() => {
    const latest = currentVoiceUser();
    if (!latest || latest.channelId !== channelId) return;
    const me = useAccount().user()?.id;
    getVoiceUsersByChannelId(channelId).forEach((voiceUser) => {
      if (voiceUser.userId === me || voiceUser.peer) return;
      log("RTC", "No offer from", voiceUser.user().username, "- initiating");
      createPeer(voiceUser);
    });
  }, 2000);
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
      },
      onScreenSharePublished: (userId) => {
        setLivePublishers(userId, true);
        const voiceUser = getVoiceUser(channelId, userId);
        if (voiceUser) updateConnectionStatus(voiceUser, "CONNECTED");
        if (watchedLives[userId]) {
          setLiveKitScreenShareSubscribed(userId, true);
        }
      },
      onScreenShareUnpublished: (userId) => {
        setLivePublishers(userId, false);
        setWatchedLives(userId, false);
        setLiveKitScreenShareSubscribed(userId, false);
      },
      onRemoteTrack: ({ userId, track, stream, source, audioElement }) => {
        const voiceUser = getVoiceUser(channelId, userId);
        if (!voiceUser) return;
        pushVoiceUserTrack(voiceUser, track, stream);
        updateConnectionStatus(voiceUser, "CONNECTED");

        if (track.kind === "audio" && source === Track.Source.Microphone) {
          const volume = cachedVolumes[userId] ?? 1;
          setLiveKitRemoteVolume(userId, volume, Track.Source.Microphone);

          const audio = audioElement ?? voiceUser.audio ?? new Audio();
          if (!audioElement) {
            // Elemento próprio (sem LiveKit): volume aqui satura em 1.0.
            audio.volume = Math.min(1, volume * getOutputGainLinear());
            audio.muted = deafened.enabled;
            const deviceId = getStorageString(
              StorageKeys.outputDeviceId,
              undefined
            );
            if (deviceId) {
              audio.setSinkId(JSON.parse(deviceId));
            }
            const activeAudio = activeRemoteStream(userId, "audio");
            audio.srcObject = activeAudio || null;
          }

          voiceUser.vadInstance?.destroy();
          const activeAudio = activeRemoteStream(userId, "audio");
          const vadInstance = createVadInstance(activeAudio, undefined, userId);
          batch(() => {
            setVoiceUsers(channelId, userId, "vadInstance", vadInstance);
            if (audio.srcObject || audioElement) {
              playRemoteMedia(audio);
            }
            setVoiceUsers(channelId, userId, "audio", audio);
          });
        }

        if (
          track.kind === "video" &&
          (source === Track.Source.ScreenShare ||
            source === Track.Source.Camera)
        ) {
          setLivePublishers(userId, true);
        }
      },
      onRemoteTrackRemoved: ({ userId, source, audioElement }) => {
        const voiceUser = getVoiceUser(channelId, userId);
        if (!voiceUser) return;
        if (source === Track.Source.Microphone && audioElement) {
          voiceUser.vadInstance?.destroy();
          setVoiceUsers(channelId, userId, {
            audio: undefined,
            vadInstance: undefined,
            voiceActivity: false,
            streamWithTracks: []
          });
          return;
        }
        const audio = activeRemoteStream(userId, "audio");
        if (!audio && voiceUser.audio) {
          voiceUser.vadInstance?.destroy();
          voiceUser.audio.srcObject = null;
          setVoiceUsers(channelId, userId, {
            audio: undefined,
            vadInstance: undefined,
            voiceActivity: false,
            streamWithTracks: []
          });
        }
      }
    });

    // Re-publish local tracks if we already had them (reconnect).
    const current = currentVoiceUser();
    if (current?.audioStream) {
      const mic = current.audioStream.getAudioTracks()[0];
      await setLiveKitMicrophoneEnabled(true, mic);
    }
    if (current?.videoStream) {
      await publishLiveKitScreenShare(current.videoStream);
    }
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
    return voiceUser.streamWithTracks?.find((stream) =>
      stream.tracks.every((track) => track.kind === kind)
    )?.stream;
  } else {
    return voiceUser.streamWithTracks?.find((stream) =>
      stream.tracks.find((track) => track.kind === kind)
    )?.stream;
  }
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
  return Object.values(voiceUsers[id] || {}).filter(Boolean) as VoiceUser[];
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

/**
 * Sent over the simple-peer data channel, so telling a streamer that we want
 * their video never touches the signalling server.
 */
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
  void applyOutgoingVideoBitrate(voiceUser);
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

  let peer = voiceUser.peer;
  if (!peer) {
    const peerConfig = {
      initiator,
      trickle: true,
      streams,
      config: {
        iceServers: createIceServers()
      }
    };
    try {
      peer = new LazySimplePeer(peerConfig);
    } catch (err) {
      log("RTC", "Peer create failed, retrying with fallback ICE", err);
      try {
        peer = new LazySimplePeer({
          ...peerConfig,
          config: { iceServers: FALLBACK_ICE_SERVERS }
        });
      } catch (retryErr) {
        log("RTC", "Peer create retry failed", retryErr);
        return;
      }
    }
  }

  setVoiceUsers(voiceUser.channelId, voiceUser.userId, "peer", peer);

  // Codec preferences only affect the next offer/answer, so this has to run
  // before simple-peer negotiates (it queues negotiation asynchronously).
  applyHardwarePreferredVideoEncoding(peerConnection(peer));

  const activePeer = peer;

  activePeer.on("data", (data) => handlePeerData(voiceUser, data));

  activePeer.on("connect", () => {
    log("RTC", "Connected to", voiceUser.user().username + "!");
    updateConnectionStatus(voiceUser, "CONNECTED");
    sendLiveWatchMessage(activePeer, !!watchedLives[voiceUser.userId]);
    window.setTimeout(() => {
      void applyOutgoingLiveEncoding(voiceUser);
    }, 400);
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
    log(
      "RTC",
      "Remote",
      track.kind,
      "from",
      voiceUser.user().username,
      track.readyState
    );

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
    const volume = cachedVolumes[userId] ?? 1;
    audio.volume = Math.min(1, volume * getOutputGainLinear());
    audio.muted = deafened.enabled;
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

function localVadThreshold() {
  const sensitivity = getStorageNumber(StorageKeys.voiceInputSensitivity, 25);
  return 0.02 + (Math.min(95, Math.max(5, sensitivity)) / 100) * 0.16;
}

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

  const vadInstance = vad(audioContext, vadStream, {
    fftSize: 1024,
    smoothingTimeConstant: 0.4,
    minCaptureFreq: 80,
    maxCaptureFreq: 4000,
    ...(!userId
      ? {
          minNoiseLevel: localVadThreshold(),
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

const applyIncomingVideoWatch = (userId: string, track: MediaStreamTrack) => {
  if (userId === useAccount().user()?.id) {
    track.enabled = true;
    return;
  }
  const watch = !!watchedLives[userId];
  track.enabled = watch;
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

  // Ask the streamer to start/stop encoding for us.
  const current = currentVoiceUser();
  if (!current) return;
  sendLiveWatchMessage(getVoiceUser(current.channelId, userId)?.peer, watch);
};

const toggleLiveWatched = (userId: string) => {
  setLiveWatched(userId, !isLiveWatched(userId));
};

const disableMic = () => {
  enableMicGeneration++;
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
      micCleanup: undefined,
      micSetGain: undefined
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
        "RTC",
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

const applyConstraintsToStream = async (stream?: MediaStream | null) => {
  const track = stream?.getAudioTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints(getStoredMicConstraints());
  } catch (err) {
    log("RTC", "Failed to apply microphone constraints", err);
  }
};

const applyMicConstraints = async () => {
  const current = currentVoiceUser();
  if (!current?.audioStream) return;
  await applyConstraintsToStream(
    current.originalAudioStream ?? current.audioStream
  );
};

const applyOutputDevice = () => {
  const deviceId = getStorageString(StorageKeys.outputDeviceId, undefined);
  const current = currentVoiceUser();
  if (!current || !deviceId) return;

  const parsedDeviceId = JSON.parse(deviceId);
  if (isLiveKitEnabled()) {
    setLiveKitAudioOutput(parsedDeviceId);
  }
  getVoiceUsersByChannelId(current.channelId).forEach((voiceUser) => {
    voiceUser.audio?.setSinkId?.(parsedDeviceId);
  });
};

const restartMic = async () => {
  const current = currentVoiceUser();
  if (!current?.audioStream) return;
  disableMic();
  await enableMic();
};

const updateLocalVadSensitivity = () => {
  const current = currentVoiceUser();
  if (!current?.audioStream) return;

  current.vadInstance?.destroy();

  let vadInstance: ReturnType<typeof vad> | undefined;
  if (voiceMode() === "VOICE_ACTIVITY" && current.vadAudioStream) {
    vadInstance = createVadInstance(current.vadAudioStream, current.audioStream);
  } else if (voiceMode() === "OPEN") {
    vadInstance = createVadInstance(current.audioStream);
  }

  setCurrentVoiceUser({ ...current, vadInstance });
};

const enableMic = async () => {
  const current = currentVoiceUser();
  if (!current) return;

  if (current.audioStream) {
    return;
  }
  const generation = ++enableMicGeneration;
  const rawStream = await getUserMic();
  let noiseMode = resolveNoiseSuppressionMode(getVoiceMicConstraints());
  // LiveKit publishes Opus at high bitrate — skip RNNoise re-encode to reduce artifacts.
  if (isLiveKitEnabled() && noiseMode === "enhanced") {
    noiseMode = "browser";
  }
  const wrapped = await wrapMicWithNoiseSuppression(rawStream, noiseMode);

  const stillCurrent = currentVoiceUser();
  if (
    generation !== enableMicGeneration ||
    !stillCurrent ||
    stillCurrent.channelId !== current.channelId ||
    stillCurrent.audioStream
  ) {
    wrapped.dispose();
    return;
  }
  wrapped.setGain(getMicGainLinear());
  const stream = wrapped.stream;

  let vadStream: MediaStream | undefined;
  let vadInstance: ReturnType<typeof vad> | undefined;

  if (voiceMode() === "PTT") {
    stream.getAudioTracks()[0]!.enabled = false;
  }

  if (voiceMode() === "VOICE_ACTIVITY") {
    // Detect on the real mic. Cloning the processed dest stream is silent in Chrome.
    vadStream = wrapped.originalStream.clone();
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
    ...stillCurrent,
    audioStream: stream,
    originalAudioStream: wrapped.originalStream,
    vadInstance,
    vadAudioStream: vadStream,
    micCleanup: wrapped.dispose,
    micSetGain: wrapped.setGain
  });
};

const setMicGain = (percent: number) => {
  const linear = Math.max(0, Math.min(2, percent / 100));
  currentVoiceUser()?.micSetGain?.(linear);
};

const setOutputGain = (percent: number) => {
  const clamped = Math.max(0, Math.min(MAX_OUTPUT_GAIN_PERCENT, percent));
  const linear = clamped / 100;

  if (isLiveKitEnabled()) {
    setLiveKitOutputGain(linear);
    return;
  }

  const current = currentVoiceUser();
  if (!current) return;
  getVoiceUsersByChannelId(current.channelId).forEach((voiceUser) => {
    if (!voiceUser.audio) return;
    const base = cachedVolumes[voiceUser.userId] ?? 1;
    voiceUser.audio.volume = Math.min(1, base * linear);
  });
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

  const videoTrack = stream.getVideoTracks()[0];
  prepareOutgoingVideoTrack(videoTrack);

  if (isLiveKitEnabled()) {
    void publishLiveKitScreenShare(stream).catch((err) => {
      log("RTC", "Failed to publish LiveKit screen share", err);
    });
  } else {
    addStreamToPeers(stream);
  }

  if (!videoTrack) return;

  videoTrack.onended = () => {
    if (isLiveKitEnabled()) {
      void unpublishLiveKitScreenShare();
    } else {
      removeStream(stream);
    }
    setCurrentVoiceUser({ ...current, videoStream: null });
    videoTrack.onended = null;
  };
  window.setTimeout(() => {
    void applyOutgoingLiveEncoding();
  }, 400);
};

function peerConnection(peer?: SimplePeer.Instance) {
  return (peer as { _pc?: RTCPeerConnection } | undefined)?._pc;
}

export function getLiveBitrateKbps() {
  return getEffectiveLiveBitrateKbps();
}

const applyOutgoingVideoBitrate = async (voiceUser?: VoiceUser) => {
  const current = currentVoiceUser();
  if (!current?.videoStream) return;
  const maxBitrate = getEffectiveLiveBitrateKbps() * 1000;
  const maxFramerate = getEffectiveLiveFramerate();
  const targets = voiceUser
    ? [voiceUser]
    : getVoiceUsersByChannelId(current.channelId);

  for (const user of targets) {
    const pc = peerConnection(user.peer);
    if (!pc) continue;
    const active = !!liveViewers[user.userId];
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      try {
        const params = sender.getParameters();
        // Game capture is high-motion, so shed resolution before frames.
        (params as any).degradationPreference = "maintain-framerate";
        if (!params.encodings?.length) {
          params.encodings = [{}];
        }
        params.encodings.forEach((encoding) => {
          // Inactive encodings release the encoder entirely, which is what
          // keeps a stream from costing one encode per person in the channel.
          encoding.active = active;
          encoding.maxBitrate = maxBitrate;
          if (maxFramerate) {
            encoding.maxFramerate = maxFramerate;
          } else {
            delete encoding.maxFramerate;
          }
        });
        await sender.setParameters(params);
      } catch (err) {
        log("RTC", "Failed to apply live encoding", err);
      }
    }
  }
};

const applyOutgoingLiveEncoding = async (voiceUser?: VoiceUser) => {
  await applyOutgoingVideoBitrate(voiceUser);
};

const setLiveBitrate = (kbps: number) => {
  const clamped = clampLiveBitrateKbps(kbps);
  setStorageObject(StorageKeys.voiceLiveBitrate, clamped);
  void applyOutgoingLiveEncoding();
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
    try {
      voiceUser.peer?.addStream(stream);
      // simple-peer queues renegotiation asynchronously, so setting codec
      // preferences here still lands before the offer is created.
      applyHardwarePreferredVideoEncoding(peerConnection(voiceUser.peer));
    } catch (err) {
      log("RTC", "Failed to add stream to", voiceUser.user().username, err);
    }
  });
};

const removeStreamFromPeers = (stream: MediaStream) => {
  const current = currentVoiceUser();
  if (!current) return;
  const voiceUsers = getVoiceUsersByChannelId(current.channelId);

  voiceUsers.forEach((voiceUser) => {
    try {
      voiceUser.peer?.removeStream(stream);
    } catch (err) {
      log("RTC", "Failed to remove stream from", voiceUser.user().username, err);
    }
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
    // Peers re-announce their watch state on reconnect.
    setLiveViewers(reconcile({}));

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

const placeholderLiveStream = (userId: string) => {
  let stream = emptyLiveStreams.get(userId);
  if (!stream) {
    stream = new MediaStream();
    emptyLiveStreams.set(userId, stream);
  }
  return stream;
};

const videoEnabled = (userId: string) => {
  const account = useAccount();
  if (account.user()?.id === userId) {
    const currentUser = currentVoiceUser();
    return currentUser?.videoStream;
  }
  const remote = activeRemoteStream(userId, "video");
  if (remote) return remote;
  if (isLiveKitEnabled() && livePublishers[userId]) {
    return placeholderLiveStream(userId);
  }
  return undefined;
};

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
    isLiveWatched,
    setLiveWatched,
    toggleLiveWatched,
    toggleMic,
    applyMicConstraints,
    applyOutputDevice,
    restartMic,
    setMicGain,
    setOutputGain,
    updateLocalVadSensitivity,
    setVideoStream,
    setLiveBitrate,
    getLiveBitrateKbps,
    applyOutgoingLiveEncoding,
    resetAll,
    isLiveKitEnabled,

    isLocalMicMuted: () => !currentVoiceUser()?.audioStream,

    micEnabled,
    toggleDeafen,
    deafened
  };
}
