import type { IncomingMessage } from "node:http";
import {
  isPeerAuthorizedForClaims,
  type PeerClaims,
  verifyPeerToken,
} from "../auth/peerToken.js";
import type { PeerovoConfig } from "../config/config.js";
import { type FixedWindowRateLimiter, getClientIp } from "../security/rateLimiter.js";

export interface Admission {
  claims: PeerClaims;
  ownerId: string;
}

export interface PeerovoIncomingMessage extends IncomingMessage {
  peerovoAdmission?: Admission;
}

export interface UpgradeInfo {
  req: PeerovoIncomingMessage;
}

export interface PeerCapacity {
  acquire(
    projectId: string,
    sessionId: string,
    peerId: string,
    ownerId: string,
  ): Promise<boolean>;
}

export type UpgradeCallback = (
  allowed: boolean,
  statusCode?: number,
  message?: string,
) => void;

export function createUpgradeAuthorizer({
  config,
  capacity,
  limiter,
  createOwnerId = (claims) => claims.jti,
  clock = Date.now,
}: {
  config: PeerovoConfig;
  capacity: PeerCapacity;
  limiter: FixedWindowRateLimiter;
  createOwnerId?: (claims: PeerClaims) => string;
  clock?: () => number;
}) {
  return (info: UpgradeInfo, callback: UpgradeCallback): void => {
    void (async () => {
      const request = info.req;
      const clientIp = getClientIp(
        request.socket.remoteAddress,
        request.headers["x-forwarded-for"],
        config.trustProxy,
      );
      const rate = limiter.consume(clientIp, clock());
      if (!rate.allowed) {
        callback(false, 429, "Too many signaling requests");
        return;
      }

      const requestUrl = request.url ?? "/";
      if (requestUrl.length > 8_192) {
        callback(false, 403, "Access denied");
        return;
      }

      let url: URL;
      try {
        url = new URL(requestUrl, "http://peerovo.local");
      } catch {
        callback(false, 403, "Access denied");
        return;
      }

      const peerIds = url.searchParams.getAll("id");
      const tokens = url.searchParams.getAll("token");
      const keys = url.searchParams.getAll("key");
      if (
        peerIds.length !== 1 ||
        tokens.length !== 1 ||
        keys.length !== 1 ||
        keys[0] !== config.key
      ) {
        callback(false, 403, "Access denied");
        return;
      }

      const peerId = peerIds[0];
      const claims = verifyPeerToken(tokens[0], config.signingSecret, clock());
      if (
        !peerId ||
        !claims ||
        !isPeerAuthorizedForClaims(peerId, claims.projectId, claims.sessionId, claims)
      ) {
        callback(false, 403, "Access denied");
        return;
      }

      // A PeerJS client reconnects with the same signed ticket. Reuse its
      // unique ticket ID as the admission owner so a short network drop can
      // reclaim the existing peer slot before the old socket times out.
      const ownerId = createOwnerId(claims);
      let admitted: boolean;
      try {
        admitted = await capacity.acquire(
          claims.projectId,
          claims.sessionId,
          peerId,
          ownerId,
        );
      } catch {
        callback(false, 503, "Session admission is unavailable");
        return;
      }
      if (!admitted) {
        callback(false, 429, "Session is at capacity");
        return;
      }

      request.peerovoAdmission = { claims, ownerId };
      callback(true, 200);
    })().catch(() => callback(false, 503, "Session admission is unavailable"));
  };
}
