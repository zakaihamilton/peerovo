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
  assert.equal(config.maxPeersPerProject, 60);
  assert.equal(config.usageLogIntervalSeconds, 300);
  assert.equal(config.projects.get("sample")?.maxPeers, 60);
  assert.equal(config.turnCredentialTtlSeconds, 120);
  assert.equal(
    config.projects.get("sample")?.allowedOrigins[0],
    "https://app.example.test",
  );
});

test("adds projects with dedicated variables alongside the existing JSON", () => {
  const env = validEnvironment();
  env.PEEROVO_PROJECT_MY_NEW_APP_API_KEY = "n".repeat(48);
  env.PEEROVO_PROJECT_MY_NEW_APP_ALLOWED_ORIGINS = JSON.stringify([
    "https://app.example.test",
    "https://admin.example.test",
  ]);
  env.PEEROVO_PROJECT_MY_NEW_APP_MAX_PEERS = "24";

  const projects = loadConfig(env).projects;
  assert.equal(projects.size, 2);
  assert.equal(projects.get("my-new-app")?.apiKey, "n".repeat(48));
  assert.deepEqual(projects.get("my-new-app")?.allowedOrigins, [
    "https://app.example.test",
    "https://admin.example.test",
  ]);
  assert.equal(projects.get("my-new-app")?.maxPeers, 24);
  assert.ok(projects.has("sample"));
});

test("supports project-specific variables without the JSON registry", () => {
  const env = validEnvironment();
  delete env.PEEROVO_PROJECTS_JSON;
  env.PEEROVO_PROJECT_ANALYTICS_API_KEY = "a".repeat(48);
  env.PEEROVO_PROJECT_ANALYTICS_ALLOWED_ORIGINS = JSON.stringify([
    "https://analytics.example.test",
  ]);

  assert.deepEqual([...loadConfig(env).projects.keys()], ["analytics"]);
});

test("rejects incomplete, duplicate, and malformed project variables", () => {
  const incomplete = validEnvironment();
  incomplete.PEEROVO_PROJECT_EXTRA_API_KEY = "e".repeat(48);
  assert.throws(() => loadConfig(incomplete), /must set both/);

  const duplicate = validEnvironment();
  duplicate.PEEROVO_PROJECT_SAMPLE_API_KEY = "d".repeat(48);
  duplicate.PEEROVO_PROJECT_SAMPLE_ALLOWED_ORIGINS = JSON.stringify([
    "https://other.example.test",
  ]);
  assert.throws(() => loadConfig(duplicate), /configured both/);

  const malformedOrigins = validEnvironment();
  malformedOrigins.PEEROVO_PROJECT_EXTRA_API_KEY = "e".repeat(48);
  malformedOrigins.PEEROVO_PROJECT_EXTRA_ALLOWED_ORIGINS = "not-json";
  assert.throws(() => loadConfig(malformedOrigins), /JSON array/);
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

test("supports project-specific peer caps in the JSON registry", () => {
  const env = validEnvironment();
  env.PEEROVO_PROJECTS_JSON = JSON.stringify({
    sample: {
      apiKey: "k".repeat(48),
      allowedOrigins: ["https://app.example.test"],
      maxPeers: 18,
    },
  });
  assert.equal(loadConfig(env).projects.get("sample")?.maxPeers, 18);
});

test("rejects out-of-range project peer caps and usage log intervals", () => {
  const badProjectCap = validEnvironment();
  badProjectCap.PEEROVO_PROJECTS_JSON = JSON.stringify({
    sample: {
      apiKey: "k".repeat(48),
      allowedOrigins: ["https://app.example.test"],
      maxPeers: 501,
    },
  });
  assert.throws(() => loadConfig(badProjectCap), /maxPeers must be an integer/);

  const badLogInterval = validEnvironment();
  badLogInterval.PEEROVO_USAGE_LOG_INTERVAL_SECONDS = "10";
  assert.throws(() => loadConfig(badLogInterval), /PEEROVO_USAGE_LOG_INTERVAL_SECONDS/);
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
