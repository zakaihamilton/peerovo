import { createHmac } from "node:crypto";
import type { PeerClaims } from "../auth/peerToken.js";
import type { PeerovoConfig } from "../config/config.js";

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export interface IceConfigResponse {
  iceServers: IceServer[];
  expiresAt: number;
}

export function createIceConfig(
  claims: PeerClaims,
  config: Pick<
    PeerovoConfig,
    "turnSecret" | "turnDomain" | "turnPort" | "turnsPort" | "turnCredentialTtlSeconds"
  >,
  now = Date.now(),
): IceConfigResponse {
  const expiresAt = Math.floor(now / 1_000) + config.turnCredentialTtlSeconds;
  const username = `${expiresAt}:${claims.projectId}:${claims.sessionId}`;
  const credential = createHmac("sha1", config.turnSecret)
    .update(username)
    .digest("base64");

  return {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: `turn:${config.turnDomain}:${config.turnPort}?transport=udp`,
        username,
        credential,
      },
      {
        urls: `turns:${config.turnDomain}:${config.turnsPort}?transport=tcp`,
        username,
        credential,
      },
    ],
    expiresAt,
  };
}
