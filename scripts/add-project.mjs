import { randomBytes } from "node:crypto";

function fail(message) {
  console.error(message);
  console.error(
    "Usage: npm run project:add -- --id my-new-app --origin https://app.example.com [--origin https://admin.example.com] [--max-peers 60]",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let projectId;
let maxPeers;
const origins = [];

for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  const value = args[index + 1];
  if (flag !== "--id" && flag !== "--origin" && flag !== "--max-peers") {
    fail(`Unknown option: ${flag}`);
  }
  if (!value || value.startsWith("--")) {
    fail(`Missing value for ${flag}.`);
  }
  index += 1;

  if (flag === "--id") {
    if (projectId !== undefined) fail("Specify --id only once.");
    projectId = value;
  } else if (flag === "--max-peers") {
    if (maxPeers !== undefined) fail("Specify --max-peers only once.");
    maxPeers = Number(value);
    if (!Number.isInteger(maxPeers) || maxPeers < 1 || maxPeers > 500) {
      fail("--max-peers must be an integer from 1 to 500.");
    }
  } else {
    origins.push(value);
  }
}

if (
  !projectId ||
  projectId.length > 64 ||
  !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId)
) {
  fail("Project ID must be a lowercase kebab-case slug.");
}
if (origins.length === 0 || new Set(origins).size !== origins.length) {
  fail("Provide one or more unique --origin values.");
}

for (const origin of origins) {
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    fail(`Invalid origin: ${origin}`);
  }
  if (
    !["http:", "https:"].includes(parsedOrigin.protocol) ||
    parsedOrigin.origin !== origin ||
    parsedOrigin.username ||
    parsedOrigin.password
  ) {
    fail(`Origins must be exact HTTP origins without a path: ${origin}`);
  }
}

const slug = projectId.toUpperCase().replaceAll("-", "_");
const apiKey = randomBytes(32).toString("base64url");

console.log(
  "The generated API key is secret. Do not commit it or expose it in browser code.",
);
console.log("Add these variables to the Peerovo service:");
console.log(`PEEROVO_PROJECT_${slug}_API_KEY=${apiKey}`);
console.log(`PEEROVO_PROJECT_${slug}_ALLOWED_ORIGINS=${JSON.stringify(origins)}`);
if (maxPeers !== undefined) {
  console.log(`PEEROVO_PROJECT_${slug}_MAX_PEERS=${maxPeers}`);
}
console.log("");
console.log("Store the same API key in the project's backend secret store.");
