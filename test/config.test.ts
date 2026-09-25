import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config/config.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    PEEROVO_SIGNING_SECRET: "s".repeat(48),
    PEEROVO_PROJECTS_JSON: JSON.stringify({
      sample: {
        apiKey: "k".repeat(48),
        allowedOrigins: ["https://app.example.test"],
      },
    }),
    TURN_SECRET_KEY: "t".repeat(48),
    TURN_DOMAIN: "turn.example.test",
  };
}

test("loads safe service and project defaults", () => {
  const config = loadConfig(validEnvironment());
  assert.equal(config.port, 9_000);
  assert.equal(config.publicHost, "localhost");
  assert.equal(config.publicSecure, false);
  assert.equal(config.path, "/");
  assert.equal(config.maxPeersPerSession, 30);
  assert.equal(config.turnCredentialTtlSeconds, 120);
  assert.equal(
    config.projects.get("sample")?.allowedOrigins[0],
    "https://app.example.test",
  );
});

test("rejects weak secrets and invalid project configuration", () => {
  const shortSigningSecret = validEnvironment();
  shortSigningSecret.PEEROVO_SIGNING_SECRET = "short";
  assert.throws(() => loadConfig(shortSigningSecret), /PEEROVO_SIGNING_SECRET/);

  const shortTurnSecret = validEnvironment();
  shortTurnSecret.TURN_SECRET_KEY = "short";
  assert.throws(() => loadConfig(shortTurnSecret), /TURN_SECRET_KEY/);

  const badOrigins = validEnvironment();
  badOrigins.PEEROVO_PROJECTS_JSON = JSON.stringify({
    sample: {
      apiKey: "k".repeat(48),
      allowedOrigins: ["https://app.example.test/path"],
    },
  });
  assert.throws(() => loadConfig(badOrigins), /exact HTTP origins/);
});

test("rejects unsafe PeerJS paths, keys, and TURN host values", () => {
  const badPath = validEnvironment();
  badPath.PEEROVO_PATH = "/peer/../escape";
  assert.throws(() => loadConfig(badPath), /PEEROVO_PATH/);

  const reservedPath = validEnvironment();
  reservedPath.PEEROVO_PATH = "/v1/peerjs";
  assert.throws(() => loadConfig(reservedPath), /outside \/v1/);

  const badKey = validEnvironment();
  badKey.PEEROVO_KEY = "peerjs?token=secret";
  assert.throws(() => loadConfig(badKey), /PEEROVO_KEY/);

  const badTurnHost = validEnvironment();
  badTurnHost.TURN_DOMAIN = "turn.example.test:443";
  assert.throws(() => loadConfig(badTurnHost), /TURN_DOMAIN/);
});
