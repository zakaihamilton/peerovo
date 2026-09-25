import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { issuePeerToken } from "../src/auth/peerToken.js";
import { createIceConfig } from "../src/turn/credentials.js";
import { testConfig } from "./helpers.js";

test("returns STUN and short-lived UDP/TLS coturn REST credentials", () => {
  const now = 1_790_337_000_000;
  const claims = issuePeerToken({
    projectId: "sample",
    sessionId: "session-123",
    peerId: "peer-456",
    secret: "s".repeat(48),
    now,
  }).claims;
  const config = testConfig();
  const result = createIceConfig(claims, config, now);

  assert.equal(result.expiresAt - Math.floor(now / 1_000), 120);
  assert.equal(result.iceServers.length, 3);
  assert.equal(result.iceServers[0]?.urls, "stun:stun.l.google.com:19302");

  const turn = result.iceServers[1];
  const tlsTurn = result.iceServers[2];
  assert.equal(turn?.urls, "turn:turn.example.test:443?transport=udp");
  assert.equal(tlsTurn?.urls, "turns:turn.example.test:443?transport=tcp");
  assert.equal(turn?.username, `${result.expiresAt}:sample:session-123`);
  assert.equal(turn?.username, tlsTurn?.username);

  const expectedCredential = createHmac("sha1", config.turnSecret)
    .update(turn?.username ?? "")
    .digest("base64");
  assert.equal(turn?.credential, expectedCredential);
  assert.equal(tlsTurn?.credential, expectedCredential);
});
