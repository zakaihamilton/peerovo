import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PROJECT_ID_PATTERN } from "../config/config.js";

export const MAX_PEER_TOKEN_LENGTH = 2_048;
export const MAX_PEER_TICKET_TTL_SECONDS = 7 * 24 * 60 * 60;
export const PEER_TOKEN_AUDIENCE = "peerovo-peer-v1";

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PeerClaims {
  aud: typeof PEER_TOKEN_AUDIENCE;
  projectId: string;
  sessionId: string;
  peerId: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface IssuedPeerToken {
  token: string;
  claims: PeerClaims;
}

export function isValidResourceId(value: unknown): value is string {
  return typeof value === "string" && RESOURCE_ID_PATTERN.test(value);
}

function encodeBase64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return encodeBase64Url(decoded) === value ? decoded : null;
}

function signatureFor(payloadPart: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payloadPart).digest();
}

export function issuePeerToken({
  projectId,
  sessionId,
  peerId,
  ttlSeconds = MAX_PEER_TICKET_TTL_SECONDS,
  secret,
  now = Date.now(),
}: {
  projectId: string;
  sessionId: string;
  peerId: string;
  ttlSeconds?: number;
  secret: string;
  now?: number;
}): IssuedPeerToken {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("Invalid project ID.");
  if (!isValidResourceId(sessionId) || !isValidResourceId(peerId)) {
    throw new Error("Invalid session or peer ID.");
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > MAX_PEER_TICKET_TTL_SECONDS
  ) {
    throw new Error("Invalid peer ticket lifetime.");
  }

  const iat = Math.floor(now / 1_000);
  const claims: PeerClaims = {
    aud: PEER_TOKEN_AUDIENCE,
    projectId,
    sessionId,
    peerId,
    iat,
    exp: iat + ttlSeconds,
    jti: randomBytes(16).toString("hex"),
  };
  const payloadPart = encodeBase64Url(JSON.stringify(claims));
  const signaturePart = encodeBase64Url(signatureFor(payloadPart, secret));
  const token = `${payloadPart}.${signaturePart}`;
  if (token.length > MAX_PEER_TOKEN_LENGTH) {
    throw new Error("Peer ticket exceeds the supported size.");
  }
  return { token, claims };
}

export function verifyPeerToken(
  token: unknown,
  secret: string,
  now = Date.now(),
): PeerClaims | null {
  if (typeof token !== "string" || token.length > MAX_PEER_TOKEN_LENGTH) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payloadPart, signaturePart] = parts;
  const actualSignature = decodeBase64Url(signaturePart);
  const payload = decodeBase64Url(payloadPart);
  if (!actualSignature || !payload) return null;

  const expectedSignature = signatureFor(payloadPart, secret);
  if (
    expectedSignature.length !== actualSignature.length ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    return null;
  }

  let claims: unknown;
  try {
    claims = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;

  const parsed = claims as Partial<PeerClaims>;
  const nowSeconds = Math.floor(now / 1_000);
  if (
    parsed.aud !== PEER_TOKEN_AUDIENCE ||
    typeof parsed.projectId !== "string" ||
    !PROJECT_ID_PATTERN.test(parsed.projectId) ||
    !isValidResourceId(parsed.sessionId) ||
    !isValidResourceId(parsed.peerId) ||
    !Number.isInteger(parsed.iat) ||
    !Number.isInteger(parsed.exp) ||
    typeof parsed.jti !== "string" ||
    !/^[a-f0-9]{32}$/.test(parsed.jti) ||
    (parsed.iat as number) > nowSeconds + 60 ||
    (parsed.exp as number) <= nowSeconds ||
    (parsed.exp as number) <= (parsed.iat as number) ||
    (parsed.exp as number) - (parsed.iat as number) > MAX_PEER_TICKET_TTL_SECONDS
  ) {
    return null;
  }
  return parsed as PeerClaims;
}

export function isPeerAuthorizedForClaims(
  peerId: string,
  projectId: string,
  sessionId: string,
  claims: PeerClaims | null,
): claims is PeerClaims {
  return Boolean(
    claims &&
      claims.projectId === projectId &&
      claims.sessionId === sessionId &&
      claims.peerId === peerId,
  );
}
