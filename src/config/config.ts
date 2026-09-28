export interface ProjectConfig {
  apiKey: string;
  allowedOrigins: string[];
  maxPeers: number;
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
  maxPeersPerProject: number;
  maxSignalingConnections: number;
  usageLogIntervalSeconds: number;
  ticketRateLimit: number;
  iceRateLimit: number;
  signalingRateLimit: number;
  peerJsDebug?: number;
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

function parseProjectConfig(
  projectId: string,
  apiKey: string,
  allowedOriginsJson: string,
  maxPeersRaw: string | undefined,
  defaultMaxPeers: number,
): ProjectConfig {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`Invalid project ID: ${projectId}`);
  }
  if (Buffer.byteLength(apiKey) < 32 || apiKey.trim() !== apiKey) {
    throw new Error(
      `Project ${projectId} apiKey must contain at least 32 bytes without surrounding whitespace.`,
    );
  }

  let parsedOrigins: unknown;
  try {
    parsedOrigins = JSON.parse(allowedOriginsJson);
  } catch {
    throw new Error(
      `Project ${projectId} allowed origins must be a JSON array of exact HTTP origins.`,
    );
  }
  if (
    !Array.isArray(parsedOrigins) ||
    !parsedOrigins.every((origin) => typeof origin === "string")
  ) {
    throw new Error(
      `Project ${projectId} allowed origins must be a JSON array of exact HTTP origins.`,
    );
  }

  const allowedOrigins = parsedOrigins.map((origin: string) => {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error(`Project ${projectId} contains an invalid allowed origin.`);
    }
    if (
      !["http:", "https:"].includes(parsedOrigin.protocol) ||
      parsedOrigin.origin !== origin ||
      parsedOrigin.username ||
      parsedOrigin.password
    ) {
      throw new Error(
        `Project ${projectId} allowed origins must be exact HTTP origins.`,
      );
    }
    return parsedOrigin.origin;
  });

  const maxPeers = maxPeersRaw === undefined ? defaultMaxPeers : Number(maxPeersRaw);
  if (!Number.isInteger(maxPeers) || maxPeers < 1 || maxPeers > 500) {
    throw new Error(
      `Project ${projectId} maxPeers must be an integer from 1 to 500.`,
    );
  }

  return { apiKey, allowedOrigins, maxPeers };
}

interface ProjectEnvironmentVariables {
  slug: string;
  apiKey?: string;
  allowedOrigins?: string;
  maxPeers?: string;
}

function parseProjects(
  env: NodeJS.ProcessEnv,
  defaultMaxPeers: number,
): Map<string, ProjectConfig> {
  const variablesByProject = new Map<string, ProjectEnvironmentVariables>();
  const variablePattern =
    /^PEEROVO_PROJECT_([A-Z0-9]+(?:_[A-Z0-9]+)*)_(API_KEY|ALLOWED_ORIGINS|MAX_PEERS)$/;

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("PEEROVO_PROJECT_")) continue;

    const match = variablePattern.exec(name);
    if (!match) {
      throw new Error(
        "Invalid project variable name " +
          name +
          ". Use PEEROVO_PROJECT_<SLUG>_API_KEY, _ALLOWED_ORIGINS, or _MAX_PEERS.",
      );
    }
    const slug = match[1];
    const field = match[2];
    if (!slug || !field) {
      throw new Error(`Invalid project variable name: ${name}`);
    }
    if (value === undefined) {
      throw new Error(`${name} must be configured.`);
    }

    const projectId = slug.toLowerCase().replaceAll("_", "-");
    const projectVariables = variablesByProject.get(projectId) ?? { slug };
    if (field === "API_KEY") projectVariables.apiKey = value;
    else if (field === "ALLOWED_ORIGINS") projectVariables.allowedOrigins = value;
    else projectVariables.maxPeers = value;
    variablesByProject.set(projectId, projectVariables);
  }

  const projects = new Map<string, ProjectConfig>();
  for (const [projectId, variables] of variablesByProject) {
    const keyName = `PEEROVO_PROJECT_${variables.slug}_API_KEY`;
    const originsName = `PEEROVO_PROJECT_${variables.slug}_ALLOWED_ORIGINS`;
    if (!variables.apiKey || !variables.allowedOrigins) {
      throw new Error(
        "Project " +
          projectId +
          " must set both " +
          keyName +
          " and " +
          originsName +
          ".",
      );
    }
    projects.set(
      projectId,
      parseProjectConfig(
        projectId,
        variables.apiKey,
        variables.allowedOrigins,
        variables.maxPeers,
        defaultMaxPeers,
      ),
    );
  }

  if (projects.size === 0) {
    throw new Error(
      "Configure at least one project with a complete project-specific variable pair.",
    );
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
  const maxPeersPerProject = integerSetting(env, "PEEROVO_MAX_PEERS_PER_PROJECT", 60, {
    max: 500,
  });

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
    projects: parseProjects(env, maxPeersPerProject),
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
    maxPeersPerProject,
    maxSignalingConnections: integerSetting(
      env,
      "PEEROVO_MAX_SIGNALING_CONNECTIONS",
      5_000,
      { max: 100_000 },
    ),
    usageLogIntervalSeconds: integerSetting(
      env,
      "PEEROVO_USAGE_LOG_INTERVAL_SECONDS",
      300,
      { min: 60, max: 3_600 },
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
    peerJsDebug: integerSetting(env, "PEEROVO_PEERJS_DEBUG", 0, {
      min: 0,
      max: 3,
    }),
  };
}

export { PROJECT_ID_PATTERN };
