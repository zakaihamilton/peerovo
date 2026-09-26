import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApiApp } from "../src/http/app.js";
import { createPeerovoUsageTracker } from "../src/usage/metrics.js";
import { testConfig } from "./helpers.js";

async function withApi(
  run: (baseUrl: string) => Promise<void>,
  config = testConfig(),
  usage = createPeerovoUsageTracker(config.projects.keys()),
): Promise<void> {
  const server = createServer(createApiApp(config, undefined, usage));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("records authenticated ticket and ICE usage by project", async () => {
  const usage = createPeerovoUsageTracker(["sample"]);
  await withApi(
    async (baseUrl) => {
      const ticketResponse = await requestPeerTicket(baseUrl);
      const ticket = (await ticketResponse.json()) as PeerTicketResponse;
      assert.equal(ticketResponse.status, 201);
      assert.equal(
        (await requestPeerTicket(baseUrl, { peerId: "peer-second" })).status,
        429,
      );

      const iceUrl = `${baseUrl}/v1/projects/sample/sessions/session-123/peers/peer-456/ice-config`;
      const iceHeaders = { Authorization: `Bearer ${ticket.peerToken}` };
      assert.equal((await fetch(iceUrl, { headers: iceHeaders })).status, 200);
      assert.equal((await fetch(iceUrl, { headers: iceHeaders })).status, 429);
    },
    testConfig({ ticketRateLimit: 1, iceRateLimit: 1 }),
    usage,
  );

  const projectUsage = usage
    .flush()
    .projects.find(({ projectId }) => projectId === "sample");
  assert.equal(projectUsage?.ticketRequests, 2);
  assert.equal(projectUsage?.ticketsIssued, 1);
  assert.equal(projectUsage?.ticketRateLimited, 1);
  assert.equal(projectUsage?.iceConfigRequests, 2);
  assert.equal(projectUsage?.iceConfigsIssued, 1);
  assert.equal(projectUsage?.iceRateLimited, 1);
});

async function requestPeerTicket(
  baseUrl: string,
  {
    projectId = "sample",
    sessionId = "session-123",
    peerId = "peer-456",
    apiKey = "k".repeat(48),
    origin,
  }: {
    projectId?: string;
    sessionId?: string;
    peerId?: string;
    apiKey?: string;
    origin?: string;
  } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/projects/${projectId}/sessions/${sessionId}/peers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({ peerId, expiresInSeconds: 300 }),
  });
}

interface PeerTicketResponse {
  projectId: string;
  sessionId: string;
  peerId: string;
  peerToken: string;
  expiresAt: number;
}

interface IceResponse {
  iceServers: unknown[];
  expiresAt: number;
}

test("serves public PeerJS config and health endpoints without caching", async () => {
  await withApi(async (baseUrl) => {
    const [configResponse, healthResponse, readyResponse] = await Promise.all([
      fetch(`${baseUrl}/v1/config`),
      fetch(`${baseUrl}/healthz`),
      fetch(`${baseUrl}/readyz`),
    ]);
    const config = (await configResponse.json()) as {
      signalingAuthMode: string;
      peerJs: { host: string; key: string };
    };

    assert.equal(configResponse.status, 200);
    assert.equal(config.signalingAuthMode, "project-session-peerovo-v1");
    assert.equal(config.peerJs.host, "localhost");
    assert.equal(config.peerJs.key, "peerjs");
    assert.equal(configResponse.headers.get("cache-control"), "no-store");
    assert.equal(configResponse.headers.get("access-control-allow-origin"), "*");
    assert.equal(healthResponse.status, 200);
    assert.equal(readyResponse.status, 200);
  });
});

test("issues a server-side peer ticket and returns session-scoped ICE config", async () => {
  await withApi(async (baseUrl) => {
    const ticketResponse = await requestPeerTicket(baseUrl);
    const ticket = (await ticketResponse.json()) as PeerTicketResponse;
    assert.equal(ticketResponse.status, 201);
    assert.equal(ticket.projectId, "sample");
    assert.equal(ticket.sessionId, "session-123");
    assert.equal(ticket.peerId, "peer-456");
    assert.equal(typeof ticket.peerToken, "string");
    assert.equal(ticketResponse.headers.get("x-content-type-options"), "nosniff");

    const iceResponse = await fetch(
      `${baseUrl}/v1/projects/sample/sessions/session-123/peers/peer-456/ice-config`,
      {
        headers: {
          Authorization: `Bearer ${ticket.peerToken}`,
          Origin: "https://app.example.test",
        },
      },
    );
    const ice = (await iceResponse.json()) as IceResponse;
    assert.equal(iceResponse.status, 200);
    assert.equal(ice.iceServers.length, 3);
    assert.equal(ice.expiresAt - Math.floor(Date.now() / 1_000), 120);
    assert.equal(
      iceResponse.headers.get("access-control-allow-origin"),
      "https://app.example.test",
    );
    assert.equal(iceResponse.headers.get("cache-control"), "no-store");
  });
});

test("rejects invalid project keys, mismatched paths, and query-string credentials", async () => {
  await withApi(async (baseUrl) => {
    const badKey = await requestPeerTicket(baseUrl, { apiKey: "wrong" });
    assert.equal(badKey.status, 403);

    const unexpectedField = await fetch(
      `${baseUrl}/v1/projects/sample/sessions/session-123/peers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${"k".repeat(48)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ peerId: "peer-1", role: "host" }),
      },
    );
    assert.equal(unexpectedField.status, 400);

    const ticketResponse = await requestPeerTicket(baseUrl);
    const ticket = (await ticketResponse.json()) as PeerTicketResponse;
    const wrongPeer = await fetch(
      `${baseUrl}/v1/projects/sample/sessions/session-123/peers/another-peer/ice-config`,
      { headers: { Authorization: `Bearer ${ticket.peerToken}` } },
    );
    assert.equal(wrongPeer.status, 403);

    const wrongSession = await fetch(
      `${baseUrl}/v1/projects/sample/sessions/another-session/peers/peer-456/ice-config`,
      { headers: { Authorization: `Bearer ${ticket.peerToken}` } },
    );
    assert.equal(wrongSession.status, 403);

    const queryToken = await fetch(
      `${baseUrl}/v1/projects/sample/sessions/session-123/peers/peer-456/ice-config?token=${encodeURIComponent(ticket.peerToken)}`,
    );
    assert.equal(queryToken.status, 403);

    const disallowedOrigin = await fetch(
      `${baseUrl}/v1/projects/sample/sessions/session-123/peers/peer-456/ice-config`,
      {
        headers: {
          Authorization: `Bearer ${ticket.peerToken}`,
          Origin: "https://unlisted.example.test",
        },
      },
    );
    assert.equal(disallowedOrigin.status, 403);
    assert.equal(disallowedOrigin.headers.get("access-control-allow-origin"), null);
  });
});

test("enforces JSON size, content type, and request rate limits", async () => {
  await withApi(
    async (baseUrl) => {
      const wrongContentType = await fetch(
        `${baseUrl}/v1/projects/sample/sessions/session-123/peers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${"k".repeat(48)}`,
            "Content-Type": "text/plain",
          },
          body: "{}",
        },
      );
      assert.equal(wrongContentType.status, 415);

      const oversized = await fetch(
        `${baseUrl}/v1/projects/sample/sessions/session-123/peers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${"k".repeat(48)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ peerId: "p", padding: "x".repeat(3_000) }),
        },
      );
      assert.equal(oversized.status, 413);

      assert.equal((await requestPeerTicket(baseUrl)).status, 201);
      const rateLimited = await requestPeerTicket(baseUrl, { peerId: "peer-789" });
      assert.equal(rateLimited.status, 429);
      assert.equal(rateLimited.headers.get("retry-after"), "60");
    },
    testConfig({ ticketRateLimit: 1 }),
  );
});

test("allows ICE preflight only from a configured project origin", async () => {
  await withApi(async (baseUrl) => {
    const allowed = await fetch(
      `${baseUrl}/v1/projects/sample/sessions/session-123/peers/peer-456/ice-config`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example.test",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      },
    );
    const denied = await fetch(
      `${baseUrl}/v1/projects/sample/sessions/session-123/peers/peer-456/ice-config`,
      {
        method: "OPTIONS",
        headers: { Origin: "https://unknown.example.test" },
      },
    );
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-methods"), "GET, OPTIONS");
    assert.equal(denied.status, 403);
  });
});
