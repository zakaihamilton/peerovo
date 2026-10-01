import type { Browser, BrowserContext, Page } from "@playwright/test";

export interface PeerovoClient {
  readonly context: BrowserContext;
  readonly page: Page;
  open(path?: string): Promise<void>;
  close(): Promise<void>;
}
export interface PeerovoTestOptions { baseURL: string; }
export interface CreateClientsOptions {
  context?: Parameters<Browser["newContext"]>[0];
}
export declare function createPeerovoTest(
  browser: Browser,
  options: PeerovoTestOptions,
): {
  client(options?: CreateClientsOptions): Promise<PeerovoClient>;
  clients(count: number, options?: CreateClientsOptions): Promise<PeerovoClient[]>;
  closeAll(items: readonly PeerovoClient[]): Promise<void>;
};
