import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteAudioTrack,
  RemoteVideoTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  LocalTrackPublication,
  ConnectionState,
  VideoQuality,
  ScreenSharePresets
} from "livekit-client";
import { log } from "@/common/logger";
import {
  LIVEKIT_MIC_PUBLISH_OPTIONS,
  LIVEKIT_SCREEN_AUDIO_PUBLISH_OPTIONS,
  LIVEKIT_VOICE_AUDIO_PRESET
} from "./livekitAudio";
import {
  clampVoiceVolumeLinear,
  effectiveRemoteVolume
} from "@/common/voiceAudioSettings";

export type LiveKitAuth = {
  url: string;
  token: string;
  room: string;
};

export type LiveKitTrackHandlers = {
  onRemoteTrack: (opts: {
    userId: string;
    track: MediaStreamTrack;
    stream: MediaStream;
    source: Track.Source;
    audioElement?: HTMLMediaElement;
  }) => void;
  onRemoteTrackRemoved: (opts: {
    userId: string;
    trackSid: string;
    kind: "audio" | "video";
    source?: Track.Source;
    audioElement?: HTMLMediaElement;
  }) => void;
  onScreenSharePublished: (userId: string) => void;
  onScreenShareUnpublished: (userId: string) => void;
  onParticipantConnected: (userId: string) => void;
  onParticipantDisconnected: (userId: string) => void;
  onConnectionState: (state: ConnectionState) => void;
};

let room: Room | null = null;
let handlers: LiveKitTrackHandlers | null = null;
const remoteStreams = new Map<string, MediaStream>();
const remoteAudioTracks = new Map<string, RemoteAudioTrack>();
const remoteAudioElements = new Map<string, HTMLMediaElement>();
const remoteVideoTracks = new Map<string, RemoteVideoTrack>();
const remoteVolumes = new Map<string, number>();
let deafened = false;
let currentSinkId: string | undefined;
/** webAudioMix enables GainNode volumes > 1 (Discord-style boost). */
const LIVEKIT_WEB_AUDIO_MIX = true;

function audioKey(userId: string, source: Track.Source) {
  return `${userId}:${source}`;
}

function volumeFor(userId: string, source: Track.Source) {
  if (deafened && source === Track.Source.Microphone) return 0;
  const userVol = clampVoiceVolumeLinear(
    remoteVolumes.get(audioKey(userId, source)) ?? 1
  );
  return effectiveRemoteVolume(userVol);
}

function applyVolume(userId: string, source: Track.Source) {
  const key = audioKey(userId, source);
  const track = remoteAudioTracks.get(key);
  if (!track) return;

  const volume = volumeFor(userId, source);
  track.setVolume(volume);
  // With webAudioMix, LiveKit mutes the element and plays via GainNode.
  if (!LIVEKIT_WEB_AUDIO_MIX) {
    const element = remoteAudioElements.get(key);
    if (element) {
      element.volume = Math.min(1, volume);
      element.muted = volume <= 0;
    }
  }
}

function ensureRemoteStream(userId: string, kind: "audio" | "video") {
  const key = `${userId}:${kind}`;
  let stream = remoteStreams.get(key);
  if (!stream) {
    stream = new MediaStream();
    remoteStreams.set(key, stream);
  }
  return stream;
}

function clearRemotePlayback() {
  for (const track of remoteAudioTracks.values()) {
    try {
      track.detach();
    } catch {
      /* already detached */
    }
  }
  for (const track of remoteVideoTracks.values()) {
    try {
      track.detach();
    } catch {
      /* already detached */
    }
  }
  remoteAudioTracks.clear();
  remoteAudioElements.clear();
  remoteVideoTracks.clear();
  remoteStreams.clear();
}

/** Mic + screen share — needed after join and after LiveKit reconnect. */
function subscribeRemotePublications(
  targetRoom: Room,
  opts?: { notifyScreenShare?: boolean }
) {
  for (const participant of targetRoom.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) {
      if (
        pub.source === Track.Source.Microphone ||
        pub.source === Track.Source.ScreenShare ||
        pub.source === Track.Source.ScreenShareAudio
      ) {
        if (!pub.isSubscribed) pub.setSubscribed(true);
      }
      if (opts?.notifyScreenShare && pub.source === Track.Source.ScreenShare) {
        handlers?.onScreenSharePublished(participant.identity);
      }
    }
  }
}

export function isLiveKitRoomConnected() {
  return room?.state === ConnectionState.Connected;
}

export function getLiveKitRoom() {
  return room;
}

function attachRemoteAudio(
  userId: string,
  remoteTrack: RemoteAudioTrack,
  source: Track.Source,
  sinkId?: string
) {
  const key = audioKey(userId, source);
  const existing = remoteAudioTracks.get(key);
  if (existing && existing !== remoteTrack) {
    existing.detach();
    remoteAudioElements.delete(key);
  }

  const element = remoteTrack.attach();
  element.autoplay = true;
  element.style.display = "none";
  if (!element.isConnected) {
    document.body.appendChild(element);
  }

  if (sinkId) {
    currentSinkId = sinkId;
    if ("setSinkId" in element) {
      void (element as HTMLAudioElement).setSinkId(sinkId).catch(() => {});
    }
  }

  remoteAudioTracks.set(key, remoteTrack);
  remoteAudioElements.set(key, element);
  applyVolume(userId, source);
  void element.play().catch(() => {});

  return element;
}

function detachRemoteAudio(userId: string, source: Track.Source) {
  const key = audioKey(userId, source);
  const track = remoteAudioTracks.get(key);
  const element = remoteAudioElements.get(key);
  track?.detach();
  element?.remove();
  remoteAudioTracks.delete(key);
  remoteAudioElements.delete(key);
}

export function setLiveKitRemoteVolume(
  userId: string,
  volume: number,
  source: Track.Source = Track.Source.Microphone
) {
  remoteVolumes.set(audioKey(userId, source), clampVoiceVolumeLinear(volume));
  applyVolume(userId, source);
}

/** Re-apply all remote volumes after master output gain changes. */
export function reapplyLiveKitRemoteVolumes() {
  for (const key of remoteAudioTracks.keys()) {
    const sep = key.lastIndexOf(":");
    if (sep < 0) continue;
    const userId = key.slice(0, sep);
    const source = key.slice(sep + 1) as Track.Source;
    applyVolume(userId, source);
  }
}

export function setLiveKitAudioOutput(deviceId: string) {
  currentSinkId = deviceId;
  for (const [key, track] of remoteAudioTracks) {
    void track.setSinkId?.(deviceId).catch(() => {});
    const el = remoteAudioElements.get(key);
    if (el && "setSinkId" in el) {
      void (el as HTMLAudioElement).setSinkId(deviceId).catch(() => {});
    }
  }
}

export async function connectLiveKitRoom(
  auth: LiveKitAuth,
  nextHandlers: LiveKitTrackHandlers
) {
  await disconnectLiveKitRoom();
  handlers = nextHandlers;
  deafened = false;

  const nextRoom = new Room({
    adaptiveStream: false,
    // Dynacast + simulcast layer hopping was flickering remote screen shares to black.
    dynacast: false,
    // Force legacy /rtc path — LiveKit server <1.9 returns 404 on /rtc/v1.
    singlePeerConnection: false,
    webAudioMix: LIVEKIT_WEB_AUDIO_MIX,
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    videoCaptureDefaults: {
      resolution: {
        width: 1280,
        height: 720,
        frameRate: 30
      }
    },
    publishDefaults: {
      audioPreset: LIVEKIT_VOICE_AUDIO_PRESET,
      dtx: true,
      red: true,
      screenShareEncoding: ScreenSharePresets.h1080fps15.encoding,
      simulcast: false
    }
  });

  room = nextRoom;

  nextRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
    handlers?.onConnectionState(state);
  });

  nextRoom.on(RoomEvent.Reconnected, () => {
    log("RTC", "LiveKit reconnected — re-subscribing remote tracks");
    // Do not re-fire onScreenSharePublished (causes UI churn / subscribe storms).
    subscribeRemotePublications(nextRoom);
  });

  nextRoom.on(RoomEvent.ParticipantConnected, (participant) => {
    handlers?.onParticipantConnected(participant.identity);
  });

  nextRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
    for (const source of [
      Track.Source.Microphone,
      Track.Source.ScreenShareAudio
    ]) {
      detachRemoteAudio(participant.identity, source);
    }
    const videoTrack = remoteVideoTracks.get(participant.identity);
    if (videoTrack) {
      try {
        videoTrack.detach();
      } catch {
        /* ignore */
      }
      remoteVideoTracks.delete(participant.identity);
    }
    for (const kind of ["audio", "video"] as const) {
      remoteStreams.delete(`${participant.identity}:${kind}`);
    }
    handlers?.onParticipantDisconnected(participant.identity);
  });

  nextRoom.on(
    RoomEvent.TrackSubscribed,
    (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) => {
      if (track.kind !== Track.Kind.Audio && track.kind !== Track.Kind.Video) {
        return;
      }

      const mediaTrack = track.mediaStreamTrack;
      const kind = track.kind === Track.Kind.Video ? "video" : "audio";
      const stream = ensureRemoteStream(participant.identity, kind);
      if (!stream.getTracks().some((t) => t.id === mediaTrack.id)) {
        stream.addTrack(mediaTrack);
      }

      let audioElement: HTMLMediaElement | undefined;
      if (track.kind === Track.Kind.Audio) {
        audioElement = attachRemoteAudio(
          participant.identity,
          track as RemoteAudioTrack,
          publication.source
        );
      } else if (
        publication.source === Track.Source.ScreenShare ||
        publication.source === Track.Source.Camera
      ) {
        // Keep a LiveKit-attached <video> so the SFU keeps sending frames.
        const videoTrack = track as RemoteVideoTrack;
        const prev = remoteVideoTracks.get(participant.identity);
        if (prev && prev !== videoTrack) {
          try {
            prev.detach();
          } catch {
            /* ignore */
          }
        }
        try {
          publication.setVideoQuality(VideoQuality.HIGH);
        } catch {
          /* older client */
        }
        const attached = videoTrack.attach();
        attached.playsInline = true;
        attached.muted = true;
        attached.autoplay = true;
        attached.style.display = "none";
        if (!attached.isConnected) {
          document.body.appendChild(attached);
        }
        void attached.play().catch(() => {});
        remoteVideoTracks.set(participant.identity, videoTrack);
      }

      handlers?.onRemoteTrack({
        userId: participant.identity,
        track: mediaTrack,
        // Reuse the same MediaStream — cloning broke addTrack updates / caused flicker.
        stream,
        source: publication.source,
        audioElement
      });
    }
  );

  nextRoom.on(
    RoomEvent.TrackUnsubscribed,
    (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) => {
      const kind = track.kind === Track.Kind.Video ? "video" : "audio";
      const stream = remoteStreams.get(`${participant.identity}:${kind}`);
      if (stream) {
        stream.getTracks().forEach((t) => {
          if (t.id === track.mediaStreamTrack.id) stream.removeTrack(t);
        });
        if (!stream.getTracks().length) {
          remoteStreams.delete(`${participant.identity}:${kind}`);
        }
      }

      let audioElement: HTMLMediaElement | undefined;
      if (track.kind === Track.Kind.Audio) {
        audioElement = remoteAudioElements.get(
          audioKey(participant.identity, publication.source)
        );
        detachRemoteAudio(participant.identity, publication.source);
      } else if (track.kind === Track.Kind.Video) {
        const videoTrack = remoteVideoTracks.get(participant.identity);
        if (videoTrack) {
          try {
            videoTrack.detach();
          } catch {
            /* ignore */
          }
          remoteVideoTracks.delete(participant.identity);
        }
      }

      handlers?.onRemoteTrackRemoved({
        userId: participant.identity,
        trackSid: publication.trackSid,
        kind,
        source: publication.source,
        audioElement
      });
    }
  );

  await nextRoom.connect(auth.url, auth.token, {
    autoSubscribe: false
  });

  for (const participant of nextRoom.remoteParticipants.values()) {
    handlers?.onParticipantConnected(participant.identity);
  }
  subscribeRemotePublications(nextRoom, { notifyScreenShare: true });

  nextRoom.on(RoomEvent.TrackPublished, (publication, participant) => {
    if (!(participant instanceof RemoteParticipant)) return;
    if (
      publication.source === Track.Source.Microphone ||
      publication.source === Track.Source.ScreenShare ||
      publication.source === Track.Source.ScreenShareAudio
    ) {
      publication.setSubscribed(true);
    }
    if (publication.source === Track.Source.ScreenShare) {
      handlers?.onScreenSharePublished(participant.identity);
    }
  });

  nextRoom.on(RoomEvent.TrackUnpublished, (publication, participant) => {
    if (!(participant instanceof RemoteParticipant)) return;
    if (publication.source === Track.Source.ScreenShare) {
      handlers?.onScreenShareUnpublished(participant.identity);
    }
  });

  log("RTC", "LiveKit connected", auth.room);
  return nextRoom;
}

export async function disconnectLiveKitRoom() {
  const current = room;
  room = null;
  handlers = null;
  clearRemotePlayback();
  if (!current) return;
  try {
    await current.disconnect(true);
  } catch (err) {
    log("RTC", "LiveKit disconnect error", err);
  }
}

export async function setLiveKitMicrophoneEnabled(
  enabled: boolean,
  track?: MediaStreamTrack | null
) {
  if (!room) return;
  if (!enabled) {
    await room.localParticipant.setMicrophoneEnabled(false);
    return;
  }

  if (track) {
    const existing = room.localParticipant.getTrackPublication(
      Track.Source.Microphone
    );
    if (existing?.track) {
      await room.localParticipant.unpublishTrack(existing.track);
    }
    await room.localParticipant.publishTrack(track, {
      source: Track.Source.Microphone,
      name: "microphone",
      ...LIVEKIT_MIC_PUBLISH_OPTIONS
    });
    return;
  }

  await room.localParticipant.setMicrophoneEnabled(
    true,
    undefined,
    LIVEKIT_MIC_PUBLISH_OPTIONS
  );
}

export async function publishLiveKitScreenShare(stream: MediaStream) {
  if (!room) throw new Error("LiveKit room is not connected");

  await unpublishLiveKitScreenShare();

  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0];

  if (video) {
    await room.localParticipant.publishTrack(video, {
      source: Track.Source.ScreenShare,
      name: "screen_share",
      // Single layer — simulcast layer switches were blacking out remote viewers.
      simulcast: false,
      videoEncoding: ScreenSharePresets.h1080fps15.encoding,
      degradationPreference: "maintain-resolution"
    });
  }
  if (audio) {
    await room.localParticipant.publishTrack(audio, {
      source: Track.Source.ScreenShareAudio,
      name: "screen_share_audio",
      ...LIVEKIT_SCREEN_AUDIO_PUBLISH_OPTIONS
    });
  }
}

export async function unpublishLiveKitScreenShare() {
  if (!room) return;
  const pubs = [
    room.localParticipant.getTrackPublication(Track.Source.ScreenShare),
    room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)
  ].filter(Boolean) as LocalTrackPublication[];

  for (const pub of pubs) {
    if (pub.track) {
      await room.localParticipant.unpublishTrack(pub.track, true);
    }
  }
}

export function setLiveKitScreenShareSubscribed(
  userId: string,
  subscribed: boolean
) {
  if (!room) return;
  const participant = room.remoteParticipants.get(userId);
  if (!participant) return;

  for (const pub of participant.trackPublications.values()) {
    if (
      pub.source === Track.Source.ScreenShare ||
      pub.source === Track.Source.ScreenShareAudio
    ) {
      pub.setSubscribed(subscribed);
    }
  }
}

export function setLiveKitDeafened(nextDeafened: boolean) {
  deafened = nextDeafened;
  for (const key of remoteAudioTracks.keys()) {
    const sep = key.lastIndexOf(":");
    const source = Number(key.slice(sep + 1)) as Track.Source;
    if (source === Track.Source.Microphone) {
      applyVolume(key.slice(0, sep), source);
    }
  }
}

export type { ConnectionState };
