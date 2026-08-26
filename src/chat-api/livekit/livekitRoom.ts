import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteAudioTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  LocalTrackPublication,
  ConnectionState
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
  remoteAudioTracks.clear();
  remoteAudioElements.clear();
  remoteStreams.clear();
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
    adaptiveStream: true,
    dynacast: true,
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
      red: true
    }
  });

  room = nextRoom;

  nextRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
    handlers?.onConnectionState(state);
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
      }

      handlers?.onRemoteTrack({
        userId: participant.identity,
        track: mediaTrack,
        stream: new MediaStream(stream.getTracks()),
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
    for (const pub of participant.trackPublications.values()) {
      if (pub.source === Track.Source.Microphone && !pub.isSubscribed) {
        pub.setSubscribed(true);
      }
    }
  }

  nextRoom.on(RoomEvent.TrackPublished, (publication, participant) => {
    if (!(participant instanceof RemoteParticipant)) return;
    if (publication.source === Track.Source.Microphone) {
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

  for (const participant of nextRoom.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) {
      if (pub.source === Track.Source.ScreenShare) {
        handlers?.onScreenSharePublished(participant.identity);
      }
    }
  }

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
      simulcast: true
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
