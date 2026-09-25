import assert from "node:assert/strict";
import test from "node:test";
import {
  isPeerAuthorizedForClaims,
  issuePeerToken,
  MAX_PEER_TICKET_TTL_SECONDS,
  verifyPeerToken,
} from "../src/auth/peerToken.js";

const secret = "peerovo-test-signing-secret-".padEnd(48, "x");
const issuedAt = 1_790_337_000_000;

test("issues a signed ticket bound to project, session, and exact peer", () => {
  const issued = issuePeerToken({
    projectId: "sample",
    sessionId: "session-123",
    peerId: "peer-456",
    ttlSeconds: 300,
    secret,
    now: issuedAt,
  });
  const claims = verifyPeerToken(issued.token, secret, issuedAt);

  assert.deepEqual(claims, issued.claims);
  assert.equal(claims?.aud, "peerovo-peer-v1");
  assert.equal(claims?.exp - claims?.iat, 300);
  assert.equal(
    isPeerAuthorizedForClaims("peer-456", "sample", "session-123", claims),
    true,
  );
  assert.equal(
    isPeerAuthorizedForClaims("other-peer", "sample", "session-123", claims),
    false,
  );
  assert.equal(
    isPeerAuthorizedForClaims("peer-456", "other-project", "session-123", claims),
    false,
  );
});

test("rejects tampered, extra-segment, and expired tickets", () => {
  const issued = issuePeerToken({
    projectId: "sample",
    sessionId: "session-123",
    peerId: "peer-456",
    ttlSeconds: 60,
    secret,
    now: issuedAt,
  });
  const [payload, signature] = issued.token.split(".");
  const tampered = `${payload?.slice(0, -1)}A.${signature}`;

  assert.equal(verifyPeerToken(tampered, secret, issuedAt), null);
  assert.equal(verifyPeerToken(`${issued.token}.extra`, secret, issuedAt), null);
  assert.equal(verifyPeerToken(issued.token, "wrong-secret", issuedAt), null);
  assert.equal(verifyPeerToken(issued.token, secret, issuedAt + 61_000), null);
  assert.equal(verifyPeerToken("x".repeat(2_049), secret, issuedAt), null);
});

test("caps ticket lifetime at seven days", () => {
  assert.throws(
    () =>
      issuePeerToken({
        projectId: "sample",
        sessionId: "session-123",
        peerId: "peer-456",
        ttlSeconds: MAX_PEER_TICKET_TTL_SECONDS + 1,
        secret,
        now: issuedAt,
      }),
    /lifetime/,
  );
});
