import express, { type NextFunction, type Request, type Response } from "express";
import {
  issuePeerToken,
  isValidResourceId,
  verifyPeerToken,
} from "../auth/peerToken.js";
import type { PeerovoConfig } from "../config/config.js";
import { extractBearerToken, matchesProjectKey } from "../security/projectKey.js";
import { FixedWindowRateLimiter, getClientIp } from "../security/rateLimiter.js";
import { createIceConfig } from "../turn/credentials.js";
import {
  createPeerovoUsageTracker,
  type PeerovoUsageTracker,
} from "../usage/metrics.js";

interface RateLimiters {
  tickets: FixedWindowRateLimiter;
  ice: FixedWindowRateLimiter;
}

const MAX_JSON_BODY_BYTES = 2_048;
const GENERIC_FORBIDDEN = { error: "Access denied." };

function securityHeaders(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  next();
}

function sendError(response: Response, status: number, error: string): void {
  response.status(status).json({ error });
}

function requireJsonBody(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const rawLength = request.header("content-length");
  const contentLength = rawLength === undefined ? null : Number(rawLength);
  if (
    contentLength !== null &&
    (!Number.isFinite(contentLength) || contentLength < 0)
  ) {
    sendError(response, 400, "Invalid Content-Length.");
    return;
  }
  if (contentLength !== null && contentLength > MAX_JSON_BODY_BYTES) {
    sendError(response, 413, "Request body too large.");
    return;
  }
  if (!(request.header("content-type") ?? "").includes("application/json")) {
    sendError(response, 415, "Content-Type must be application/json.");
    return;
  }
  next();
}

function corsForProject(config: PeerovoConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.header("origin");
    if (!origin) {
      next();
      return;
    }

    response.vary("Origin");
    const projectId = request.params.projectId;
    const project = projectId ? config.projects.get(projectId) : undefined;
    if (!project?.allowedOrigins.includes(origin)) {
      sendError(response, 403, GENERIC_FORBIDDEN.error);
      return;
    }

    response.set("Access-Control-Allow-Origin", origin);
    response.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.set("Access-Control-Max-Age", "600");

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  };
}

function validateSessionParams(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (
    !request.params.projectId ||
    !request.params.sessionId ||
    !isValidResourceId(request.params.sessionId)
  ) {
    sendError(response, 400, "Invalid project or session identifier.");
    return;
  }
  next();
}

function validateProjectKey(config: PeerovoConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const projectId = request.params.projectId;
    const project = projectId ? config.projects.get(projectId) : undefined;
    const presentedKey = extractBearerToken(request.header("authorization"));
    if (!project || !matchesProjectKey(presentedKey, project.apiKey)) {
      sendError(response, 403, GENERIC_FORBIDDEN.error);
      return;
    }
    next();
  };
}

function applyRateLimit(
  limiter: FixedWindowRateLimiter,
  config: PeerovoConfig,
  request: Request,
  response: Response,
  scope: string,
): boolean {
  const ip = getClientIp(
    request.socket.remoteAddress,
    request.header("x-forwarded-for"),
    config.trustProxy,
  );
  const result = limiter.consume(`${scope}:${ip}`);
  if (result.allowed) return true;
  response.set("Retry-After", String(result.retryAfterSeconds));
  sendError(response, 429, "Too many requests.");
  return false;
}

function parseTicketLifetime(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["peerId", "expiresInSeconds"].includes(key))
  ) {
    return null;
  }
  const ttl = record.expiresInSeconds ?? 7 * 24 * 60 * 60;
  if (!Number.isInteger(ttl) || (ttl as number) < 1 || (ttl as number) > 604_800) {
    return null;
  }
  return ttl as number;
}

export function createApiApp(
  config: PeerovoConfig,
  rateLimiters: RateLimiters = {
    tickets: new FixedWindowRateLimiter(config.ticketRateLimit),
    ice: new FixedWindowRateLimiter(config.iceRateLimit),
  },
  usage: PeerovoUsageTracker = createPeerovoUsageTracker(config.projects.keys()),
): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy ? 1 : false);
  app.use(securityHeaders);
  app.use(
    express.json({
      limit: MAX_JSON_BODY_BYTES,
      strict: true,
      type: "application/json",
    }),
  );

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });
  app.get("/readyz", (_request, response) => {
    response.status(200).json({ status: "ready" });
  });

  app.get("/v1/config", (_request, response) => {
    response.set("Access-Control-Allow-Origin", "*");
    response.json({
      signaling: "webrtc-peerjs",
      signalingAuthMode: "project-session-peerovo-v1",
      peerJs: {
        host: config.publicHost,
        port: config.publicPort,
        path: config.path,
        key: config.key,
        secure: config.publicSecure,
        debug: config.peerJsDebug ?? 0,
      },
    });
  });

  const peerTicketPath = "/v1/projects/:projectId/sessions/:sessionId/peers";
  const iceConfigPath =
    "/v1/projects/:projectId/sessions/:sessionId/peers/:peerId/ice-config";
  app.options(iceConfigPath, corsForProject(config));

  app.post(
    peerTicketPath,
    validateSessionParams,
    requireJsonBody,
    validateProjectKey(config),
    (request, response) => {
      const projectId = request.params.projectId;
      if (projectId) usage.recordTicketRequest(projectId);
      if (
        !applyRateLimit(
          rateLimiters.tickets,
          config,
          request,
          response,
          `ticket:${request.params.projectId}`,
        )
      ) {
        if (projectId) usage.recordRateLimited("ticket", projectId);
        return;
      }

      const sessionId = request.params.sessionId;
      const peerId = (request.body as Record<string, unknown> | undefined)?.peerId;
      const ttlSeconds = parseTicketLifetime(request.body);
      if (
        !projectId ||
        !sessionId ||
        !isValidResourceId(sessionId) ||
        !isValidResourceId(peerId) ||
        ttlSeconds === null
      ) {
        sendError(response, 400, "Invalid peer ticket request.");
        return;
      }

      try {
        const issued = issuePeerToken({
          projectId,
          sessionId,
          peerId,
          ttlSeconds,
          secret: config.signingSecret,
        });
        usage.recordTicketIssued(projectId);
        response.status(201).json({
          projectId,
          sessionId,
          peerId,
          peerToken: issued.token,
          expiresAt: issued.claims.exp,
        });
      } catch {
        sendError(response, 400, "Invalid peer ticket request.");
      }
    },
  );

  app.get(
    iceConfigPath,
    corsForProject(config),
    validateSessionParams,
    (request, response) => {
      const projectId = request.params.projectId;
      const sessionId = request.params.sessionId;
      const peerId = request.params.peerId;
      const token = extractBearerToken(request.header("authorization"));
      const claims = verifyPeerToken(token, config.signingSecret);
      if (
        !projectId ||
        !sessionId ||
        !peerId ||
        !isValidResourceId(peerId) ||
        !claims ||
        claims.projectId !== projectId ||
        claims.sessionId !== sessionId ||
        claims.peerId !== peerId
      ) {
        sendError(response, 403, GENERIC_FORBIDDEN.error);
        return;
      }
      usage.recordIceConfigRequest(projectId);
      if (!applyRateLimit(rateLimiters.ice, config, request, response, "ice")) {
        usage.recordRateLimited("ice", projectId);
        return;
      }

      const iceConfig = createIceConfig(claims, config);
      usage.recordIceConfigIssued(projectId);
      response.json(iceConfig);
    },
  );

  app.use("/v1", (_request, response) => {
    sendError(response, 404, "Peerovo API route not found.");
  });

  app.use(
    (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      const maybeError = error as { type?: string; status?: number };
      if (maybeError?.type === "entity.too.large" || maybeError?.status === 413) {
        sendError(response, 413, "Request body too large.");
        return;
      }
      if (error instanceof SyntaxError) {
        sendError(response, 400, "Invalid JSON body.");
        return;
      }
      sendError(response, 500, "Peerovo request failed.");
    },
  );

  return app;
}
