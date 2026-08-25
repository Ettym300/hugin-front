import type SimplePeer from "simple-peer";
import { RawVoice } from "../RawData";
import useAccount from "../store/useAccount";
import useVoiceUsers from "../store/useVoiceUsers";
import { getCustomSound, playSound } from "@/common/Sound";

export function onVoiceUserJoined(payload: RawVoice) {
  const { createVoiceUser, currentUser } = useVoiceUsers();

  if (currentUser()?.channelId === payload.channelId) {
    playSound(getCustomSound("CALL_JOIN"));
  }

  createVoiceUser(payload);
}
export function onVoiceUserLeft(payload: {
  userId: string;
  channelId: string;
}) {
  const { removeVoiceUser, setCurrentChannelId, currentUser } = useVoiceUsers();
  const { user } = useAccount();

  const isSelf =
    user()?.id != null && String(user()!.id) === String(payload.userId);

  if (!isSelf && currentUser()?.channelId === payload.channelId) {
    playSound(getCustomSound("CALL_LEAVE"));
  }

  if (isSelf) {
    setCurrentChannelId(null);
    return;
  }

  removeVoiceUser(payload.channelId, payload.userId);
}

interface VoiceSignalReceivedPayload {
  fromUserId: string;
  channelId: string;
  signal: SimplePeer.SignalData;
}

export function onVoiceSignalReceived(payload: VoiceSignalReceivedPayload) {
  const voiceUsers = useVoiceUsers();
  if (voiceUsers.isLiveKitEnabled()) return;

  const voiceUser = voiceUsers.getVoiceUser(
    payload.channelId,
    payload.fromUserId
  );
  if (!voiceUser) return;

  if (!voiceUser.peer) {
    return voiceUsers.createPeer(voiceUser, payload.signal);
  }

  voiceUsers.signal(voiceUser, payload.signal);
}
