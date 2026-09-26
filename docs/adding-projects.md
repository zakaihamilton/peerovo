# Adding a project

Peerovo can serve multiple applications. Each project gets its own API key and exact browser-origin allowlist. An application backend uses its key to request peer tickets; browsers receive only the short-lived peer ticket.

## Generate the project settings

Run this from the Peerovo repository. Repeat --origin for each exact browser origin. Optionally set a per-project concurrent-peer limit from 1 to 500:

    npm run project:add -- --id my-new-app --origin https://app.example.com --origin https://admin.example.com --max-peers 60

The command generates a separate 32-byte API key and prints the project variables:

- **PEEROVO_PROJECT_MY_NEW_APP_API_KEY**
- **PEEROVO_PROJECT_MY_NEW_APP_ALLOWED_ORIGINS**
- **PEEROVO_PROJECT_MY_NEW_APP_MAX_PEERS** (when `--max-peers` is supplied)

The slug becomes a lowercase kebab-case project ID. The origins variable is a JSON array, such as ["https://app.example.com","https://admin.example.com"]. Origins include the scheme and host only; do not include a path or trailing slash. Without a project-specific peer cap, the service-wide per-project default is 60.

## Deploy support first

The service must be running a Peerovo version that supports dedicated project variables before you add them. Deploy this code first; earlier versions only read the combined project JSON value.

## Add the variables

In Railway, open the Peerovo service's Variables page and add the generated variables. Keep the existing PEEROVO_PROJECTS_JSON value as-is; the dedicated variables are merged with it at startup. Railway will restart the service after you apply the changes.

Store the same API key as a server-only secret in the new project's backend. Never expose it in browser code, client bundles, logs, or source control. The allowed-origins value is public configuration, but it must list only the application's exact production and development origins that need ICE access.

The project backend requests tickets from:

    POST /v1/projects/{projectId}/sessions/{sessionId}/peers
    Authorization: Bearer {project API key}

For my-new-app, use my-new-app as the project ID in the URL. The project backend remains responsible for authenticating its users and deciding which session and peer ID each user may use.

## Local configuration

For local development, the two variables can be placed in an ignored .env file. Keep .env out of Git; .env.example contains placeholders only. The same project may also be represented in PEEROVO_PROJECTS_JSON, but do not configure one project in both sources.
