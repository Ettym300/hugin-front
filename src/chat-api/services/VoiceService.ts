import env from "../../common/env";
import { request } from "./Request";
import Endpoints from "./ServiceEndpoints";

export const postJoinVoice = async (channelId: string, socketId: string) => {
  const data = await request({
    method: "POST",
    url: env.SERVER_URL + "/api" + Endpoints.channel(channelId) + "/voice/join",
    body: {
      socketId
    },
    useToken: true
  });
  return data;
};
export const postLeaveVoice = async (channelId: string) => {
  const data = await request({
    method: "POST",
    url:
      env.SERVER_URL + "/api" + Endpoints.channel(channelId) + "/voice/leave",
    useToken: true,
    skipQueue: true
  });
  return data;
};

export type LiveKitTokenResponse = {
  url: string;
  token: string;
  room: string;
};

export const postLiveKitToken = async (channelId: string) => {
  const data = await request<LiveKitTokenResponse>({
    method: "POST",
    url:
      env.SERVER_URL + "/api" + Endpoints.channel(channelId) + "/voice/livekit",
    useToken: true
  });
  return data;
};

const lastCredentials = {
  generatedAt: null as null | number,
  result: null as null | any,
  failedAt: null as null | number
};

export const getCachedCredentials = () => lastCredentials.result;
export const postGenerateCredential = async () => {
  if (lastCredentials.generatedAt) {
    const diff = Date.now() - lastCredentials.generatedAt;
    // 1 hour after last generated
    if (diff < 60 * 60 * 1000) {
      return lastCredentials as { result: any };
    }
  }
  // Cloudflare TURN not configured → 403. Don't spam join with generate.
  if (lastCredentials.failedAt && Date.now() - lastCredentials.failedAt < 60 * 60 * 1000) {
    return lastCredentials as { result: any };
  }
  try {
    const data = await request<{ result: any }>({
      method: "POST",
      url: env.SERVER_URL + "/api/voice/generate",
      useToken: true
    });

    lastCredentials.generatedAt = Date.now();
    lastCredentials.failedAt = null;
    lastCredentials.result = data.result;

    return data;
  } catch (err) {
    lastCredentials.failedAt = Date.now();
    throw err;
  }
};
