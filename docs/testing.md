# Testing Peerovo applications

Peerovo applications often need two or more independent browser clients before a useful end-to-end assertion can be made. The `@peerovo/test` helper creates isolated Playwright browser contexts so tests can model a host and multiple participants without sharing cookies, storage, or application state.

## Setup

Install Playwright in the consuming application:

```sh
npm install -D @playwright/test
```

Until `@peerovo/test` is published separately, consume the package from this repository/workspace.

## Multi-client example

```ts
import { expect, test } from "@playwright/test";
import { createPeerovoTest } from "@peerovo/test";

test("host and two players share a session", async ({ browser }) => {
  const peerovo = createPeerovoTest(browser, {
    baseURL: "http://localhost:3000",
  });
  const [host, player1, player2] = await peerovo.clients(3);

  try {
    await Promise.all([
      host.open("/"),
      player1.open("/"),
      player2.open("/"),
    ]);

    await host.page.getByRole("button", { name: "Create session" }).click();
    const session = await host.page.getByTestId("session-code").textContent();

    await player1.page.getByTestId("session-code-input").fill(session!);
    await player1.page.getByRole("button", { name: "Join" }).click();

    await player2.page.getByTestId("session-code-input").fill(session!);
    await player2.page.getByRole("button", { name: "Join" }).click();

    await expect(host.page.getByTestId("peer-count")).toHaveText("3");
  } finally {
    await peerovo.closeAll([host, player1, player2]);
  }
});
```

The helper deliberately does not know an application's UI, session-code format, or authorization rules. Those remain application responsibilities; the helper only supplies independent browser clients.

## Test layers

Keep three layers separate:

1. Run Peerovo's normal unit/integration tests with `npm test`. These should remain fast and deterministic.
2. Run application multi-client Playwright tests against local Peerovo signaling and normal WebRTC. These exercise the real browser integration.
3. Run a smaller deployed TURN smoke suite separately. Configure those tests to force relay candidates (`iceTransportPolicy: "relay"`) and assert that the WebRTC connection succeeds. This verifies deployed Peerovo credentials, ICE configuration, coturn reachability, and relay behavior without making every CI test depend on external infrastructure.

Do not put TURN secrets or project API keys in Playwright browser code. The application backend should issue Peerovo peer tickets exactly as it does in production.
