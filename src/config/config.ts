export interface ProjectConfig {
  apiKey: string;
  allowedOrigins: string[];
}

export interface PeerovoConfig {
  host: string;
  port: number;
  path: string;
  key: string;
  proxied: boolean;
  trustProxy: boolean;
  publicHost: string;
  publicPort: number;
  publicSecure: boolean;
  signingSecret: string;
  projects: Map<string, ProjectConfig>;
  turnSecret: string;
  turnDomain: string;
  turnPort: number;
  turnsPort: number;
  turnCredentialTtlSeconds: number;
  maxPeersPerSession: number;
  maxSignalingConnections: number;
  ticketRateLimit: number;
  iceRateLimit: number;
  signalingRateLimit: number;
}

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function requiredString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { min = 1, max = 2_147_483_647 }: { min?: number; max?: number } = {},
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function booleanSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function normalizePath(value: string | undefined): string {
  const trimmed = value?.trim() || "/";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const normalized = withLeadingSlash.replace(/\/+$/, "") || "/";
  if (
    normalized.length > 200 ||
    /[?#\\]/.test(normalized) ||
    normalized.split("/").some((segment) => segment === "." || segment === "..") ||
    normalized === "/v1" ||
    normalized.startsWith("/v1/")
  ) {
    throw new Error("PEEROVO_PATH must be a safe URL path outside /v1.");
  }
  return normalized;
}

function hostnameOnly(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new Error(`${name} must be a hostname or IP address only.`);
  }
  if (
    parsed.hostname.toLowerCase() !== value.toLowerCase() ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${name} must be a hostname or IP address only.`);
  }
  return parsed.hostname;
}

function parseProjects(raw: string): Map<string, ProjectConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PEEROVO_PROJECTS_JSON must contain valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PEEROVO_PROJECTS_JSON must be an object keyed by project ID.");
  }

  const projects = new Map<string, ProjectConfig>();
  for (const [projectId, value] of Object.entries(parsed)) {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error(`Invalid project ID in PEEROVO_PROJECTS_JSON: ${projectId}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Project ${projectId} must be an object.`);
    }

    const project = value as Record<string, unknown>;
    if (
      typeof project.apiKey !== "string" ||
      Buffer.byteLength(project.apiKey) < 32 ||
      project.apiKey.trim() !== project.apiKey
    ) {
      throw new Error(
        `Project ${projectId} apiKey must contain at least 32 bytes without surrounding whitespace.`,
      );
    }
    if (
      Object.keys(project).some((key) => !["apiKey", "allowedOrigins"].includes(key))
    ) {
      throw new Error(
        `Project ${projectId} contains unsupported configuration fields.`,
      );
    }
    if (
      !Array.isArray(project.allowedOrigins) ||
      !project.allowedOrigins.every((origin) => typeof origin === "string")
    ) {
      throw new Error(
        `Project ${projectId} allowedOrigins must be an array of origins.`,
      );
    }

    const allowedOrigins = project.allowedOrigins.map((origin) => {
      const value = origin as string;
      let parsedOrigin: URL;
      try {
        parsedOrigin = new URL(value);
      } catch {
        throw new Error(`Project ${projectId} contains an invalid allowed origin.`);
      }
      if (
        !["http:", "https:"].includes(parsedOrigin.protocol) ||
        parsedOrigin.origin !== value ||
        parsedOrigin.username ||
        parsedOrigin.password
      ) {
        throw new Error(
          `Project ${projectId} allowed origins must be exact HTTP origins.`,
        );
      }
      return parsedOrigin.origin;
    });

    projects.set(projectId, { apiKey: project.apiKey, allowedOrigins });
  }

  if (projects.size === 0) {
    throw new Error("PEEROVO_PROJECTS_JSON must configure at least one project.");
  }
  return projects;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PeerovoConfig {
  const host = env.PEEROVO_HOST?.trim() || "0.0.0.0";
  const port = integerSetting(env, "PORT", 9000, { max: 65_535 });
  const publicHost = hostnameOnly(
    env.PEEROVO_PUBLIC_HOST?.trim() || "localhost",
    "PEEROVO_PUBLIC_HOST",
  );
  const publicPort = integerSetting(env, "PEEROVO_PUBLIC_PORT", port, {
    max: 65_535,
  });
  const signingSecret = requiredString(env, "PEEROVO_SIGNING_SECRET");
  if (Buffer.byteLength(signingSecret) < 32) {
    throw new Error("PEEROVO_SIGNING_SECRET must contain at least 32 bytes.");
  }

  const turnSecret = requiredString(env, "TURN_SECRET_KEY");
  if (Buffer.byteLength(turnSecret) < 32) {
    throw new Error("TURN_SECRET_KEY must contain at least 32 bytes.");
  }
  const turnDomain = hostnameOnly(requiredString(env, "TURN_DOMAIN"), "TURN_DOMAIN");
  const key = env.PEEROVO_KEY?.trim() || "peerjs";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
    throw new Error(
      "PEEROVO_KEY must use 1-64 letters, numbers, dots, underscores, or hyphens.",
    );
  }
  const publicSecure = booleanSetting(
    env,
    "PEEROVO_PUBLIC_SECURE",
    !(publicHost === "localhost" || publicHost === "127.0.0.1"),
  );

  return {
    host,
    port,
    path: normalizePath(env.PEEROVO_PATH),
    key,
    proxied: booleanSetting(env, "PEEROVO_PROXIED", false),
    trustProxy: booleanSetting(env, "PEEROVO_TRUST_PROXY", false),
    publicHost,
    publicPort,
    publicSecure,
    signingSecret,
    projects: parseProjects(requiredString(env, "PEEROVO_PROJECTS_JSON")),
    turnSecret,
    turnDomain,
    turnPort: integerSetting(env, "TURN_PORT", 443, { max: 65_535 }),
    turnsPort: integerSetting(env, "TURNS_PORT", 443, { max: 65_535 }),
    turnCredentialTtlSeconds: integerSetting(env, "TURN_CREDENTIAL_TTL_SECONDS", 120, {
      min: 60,
      max: 300,
    }),
    maxPeersPerSession: integerSetting(env, "PEEROVO_MAX_PEERS_PER_SESSION", 30, {
      max: 500,
    }),
    maxSignalingConnections: integerSetting(
      env,
      "PEEROVO_MAX_SIGNALING_CONNECTIONS",
      5_000,
      { max: 100_000 },
    ),
    ticketRateLimit: integerSetting(env, "PEEROVO_TICKET_RATE_LIMIT", 120, {
      max: 100_000,
    }),
    iceRateLimit: integerSetting(env, "PEEROVO_ICE_RATE_LIMIT", 120, {
      max: 100_000,
    }),
    signalingRateLimit: integerSetting(env, "PEEROVO_SIGNALING_RATE_LIMIT", 120, {
      max: 100_000,
    }),
  };
}

export { PROJECT_ID_PATTERN };
