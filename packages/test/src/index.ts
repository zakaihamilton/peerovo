import type { Browser, BrowserContext, Page } from "@playwright/test";

export interface PeerovoClient {
  readonly context: BrowserContext;
  readonly page: Page;
  open(path?: string): Promise<void>;
  close(): Promise<void>;
}

export interface PeerovoTestOptions {
  baseURL: string;
}

export interface CreateClientsOptions {
  context?: Parameters<Browser["newContext"]>[0];
}

export function createPeerovoTest(browser: Browser, options: PeerovoTestOptions) {
  const baseURL = new URL(options.baseURL);

  async function client(createOptions: CreateClientsOptions = {}): Promise<PeerovoClient> {
    const context = await browser.newContext(createOptions.context);
    const page = await context.newPage();

    return {
      context,
      page,
      async open(path = "/") {
        await page.goto(new URL(path, baseURL).toString());
      },
      async close() {
        await context.close();
      },
    };
  }

  async function clients(
    count: number,
    createOptions: CreateClientsOptions = {},
  ): Promise<PeerovoClient[]> {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError("Peerovo test client count must be a positive integer");
    }

    return Promise.all(Array.from({ length: count }, () => client(createOptions)));
  }

  async function closeAll(items: readonly PeerovoClient[]): Promise<void> {
    await Promise.all(items.map((item) => item.close()));
  }

  return { client, clients, closeAll };
}
