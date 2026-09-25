import type { PeerovoConfig } from "../src/config/config.js";

export function testConfig(overrides: Partial<PeerovoConfig> = {}): PeerovoConfig {
  return {
    host: "127.0.0.1",
    port: 9_000,
    path: "/",
    key: "peerjs",
    proxied: false,
    trustProxy: false,
    publicHost: "localhost",
    publicPort: 9_000,
    publicSecure: false,
    signingSecret: "s".repeat(48),
    projects: new Map([
      [
        "sample",
        {
          apiKey: "k".repeat(48),
          allowedOrigins: ["https://app.example.test"],
        },
      ],
    ]),
    turnSecret: "t".repeat(48),
    turnDomain: "turn.example.test",
    turnPort: 443,
    turnsPort: 443,
    turnCredentialTtlSeconds: 120,
    maxPeersPerSession: 30,
    maxSignalingConnections: 5_000,
    ticketRateLimit: 120,
    iceRateLimit: 120,
    signalingRateLimit: 120,
    ...overrides,
  };
}
