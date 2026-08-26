import { getStorageBoolean, StorageKeys } from "@/common/localStorage";
import { getCachedCredentials } from "./services/VoiceService";

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: "stun:stun.relay.metered.ca:80" },
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

/** STUN/TURN list for voice — mesh P2P and LiveKit when direct UDP to SFU fails. */
export function getVoiceIceServers(): RTCIceServer[] {
  const extra = getStorageBoolean(StorageKeys.voiceUseTurnServers, true)
    ? asIceServerList(getCachedCredentials())
    : [];
  return [...extra, ...FALLBACK_ICE_SERVERS];
}
