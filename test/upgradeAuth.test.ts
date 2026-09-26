import assert from "node:assert/strict";
import test from "node:test";
import { issuePeerToken } from "../src/auth/peerToken.js";
import {
  createUpgradeAuthorizer,
  type PeerovoIncomingMessage,
} from "../src/peers/upgradeAuth.js";
import { FixedWindowRateLimiter } from "../src/security/rateLimiter.js";
import { createPeerovoUsageTracker } from "../src/usage/metrics.js";
import { testConfig } from "./helpers.js";

const now = 1_790_337_000_000;

function createInfo(
  query: string,
  remoteAddress = "127.0.0.1",
): { req: PeerovoIncomingMessage } {
  return {
    req: {
      url: `/peerjs?${query}`,
      headers: {},
      socket: { remoteAddress },
    } as PeerovoIncomingMessage,
  };
}

function signedToken(peerId = "peer-456", at = now): string {
  return issuePeerToken({
    projectId: "sample",
    sessionId: "session-123",
    peerId,
    secret: testConfig().signingSecret,
    now: at,
  }).token;
}

async function authorize(
  query: string,
  {
    allowed = true,
    rateLimit = 120,
    at = now,
  }: { allowed?: boolean; rateLimit?: number; at?: number } = {},
): Promise<{
  allowed: boolean;
  statusCode?: number;
  request: PeerovoIncomingMessage;
}> {
  const config = testConfig();
  const capacity = {
    acquire: async () => allowed,
  };
  const authorizer = createUpgradeAuthorizer({
    config,
    capacity,
    limiter: new FixedWindowRateLimiter(rateLimit),
    createOwnerId: () => "owner-1",
    clock: () => at,
  });
  const info = createInfo(query);
  return new Promise((resolve) => {
    authorizer(info, (result, statusCode) => {
      resolve({
        allowed: result,
        ...(statusCode === undefined ? {} : { statusCode }),
        request: info.req,
      });
    });
  });
}

test("admits a valid ticket and carries its lease owner to the socket", async () => {
  const peerId = "peer-456";
  const token = signedToken(peerId);
  const result = await authorize(
    new URLSearchParams({ id: peerId, token, key: "peerjs" }).toString(),
  );

  assert.equal(result.allowed, true);
  assert.deepEqual(result.request.peerovoAdmission, {
    claims: {
      aud: "peerovo-peer-v1",
      projectId: "sample",
      sessionId: "session-123",
      peerId,
      iat: Math.floor(now / 1_000),
      exp: Math.floor(now / 1_000) + 604_800,
      jti: result.request.peerovoAdmission?.claims.jti,
    },
    ownerId: "owner-1",
  });
});

test("records signaling attempts and session-capacity rejections by project", async () => {
  const config = testConfig();
  const usage = createPeerovoUsageTracker(config.projects.keys());
  const token = signedToken();
  const info = createInfo(
    new URLSearchParams({ id: "peer-456", token, key: "peerjs" }).toString(),
  );
  const authorizer = createUpgradeAuthorizer({
    config,
    capacity: { acquire: async () => false },
    limiter: new FixedWindowRateLimiter(120),
    usage,
    clock: () => now,
  });

  const result = await new Promise<{ allowed: boolean; statusCode?: number }>(
    (resolve) => {
      authorizer(info, (allowed, statusCode) =>
        resolve({ allowed, ...(statusCode === undefined ? {} : { statusCode }) }),
      );
    },
  );

  assert.deepEqual(result, { allowed: false, statusCode: 429 });
  const projectUsage = usage
    .flush()
    .projects.find(({ projectId }) => projectId === "sample");
  assert.equal(projectUsage?.signalingAttempts, 1);
  assert.equal(projectUsage?.signalingAdmissionRejected, 1);
  assert.equal(projectUsage?.signalingAdmitted, 0);
});

test("rejects duplicate or missing handshake parameters and invalid identity", async () => {
  const token = signedToken();
  const valid = `id=peer-456&token=${encodeURIComponent(token)}&key=peerjs`;

  assert.deepEqual(
    await authorize(`${valid}&id=peer-456`).then((x) => x.allowed),
    false,
  );
  assert.equal((await authorize("id=peer-456&key=peerjs")).allowed, false);
  assert.equal(
    (await authorize(`id=other-peer&token=${encodeURIComponent(token)}&key=peerjs`))
      .allowed,
    false,
  );
  assert.equal(
    (await authorize(`id=peer-456&token=${encodeURIComponent(token)}&key=wrong`))
      .allowed,
    false,
  );
});

test("rejects expired tickets, full sessions, and excessive upgrade rates", async () => {
  const expired = signedToken("peer-456", now - 604_801_000);
  assert.equal(
    (await authorize(`id=peer-456&token=${encodeURIComponent(expired)}&key=peerjs`))
      .allowed,
    false,
  );

  const token = signedToken();
  const query = `id=peer-456&token=${encodeURIComponent(token)}&key=peerjs`;
  const full = await authorize(query, { allowed: false });
  assert.equal(full.allowed, false);
  assert.equal(full.statusCode, 429);

  const limiter = new FixedWindowRateLimiter(1);
  const config = testConfig();
  const authorizer = createUpgradeAuthorizer({
    config,
    capacity: { acquire: async () => true },
    limiter,
    clock: () => now,
  });
  const first = createInfo(query);
  const firstResult = await new Promise<boolean>((resolve) => {
    authorizer(first, (allowed) => resolve(allowed));
  });
  const second = createInfo(query);
  const secondResult = await new Promise<{ allowed: boolean; statusCode?: number }>(
    (resolve) => {
      authorizer(second, (allowed, statusCode) =>
        resolve({ allowed, ...(statusCode === undefined ? {} : { statusCode }) }),
      );
    },
  );
  assert.equal(firstResult, true);
  assert.equal(secondResult.allowed, false);
  assert.equal(secondResult.statusCode, 429);
});
