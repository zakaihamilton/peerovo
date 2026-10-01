# @peerovo/test

Playwright helpers for Peerovo applications that need multiple independent browser clients.

```ts
import { createPeerovoTest } from "@peerovo/test";

const peerovo = createPeerovoTest(browser, {
  baseURL: "http://127.0.0.1:3000",
});
const [host, participant] = await peerovo.clients(2);

await Promise.all([host.open("/"), participant.open("/")]);
```

Each client gets its own Playwright `BrowserContext`, so cookies and browser storage are isolated. Application-specific room creation, joining, authorization, and assertions stay in the consuming application's tests.

See `docs/testing.md` in the Peerovo repository for the full testing strategy, including deployed TURN smoke tests.
