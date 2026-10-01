export function createPeerovoTest(browser, options) {
  const baseURL = new URL(options.baseURL);

  async function client(createOptions = {}) {
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

  async function clients(count, createOptions = {}) {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError("Peerovo test client count must be a positive integer");
    }
    return Promise.all(Array.from({ length: count }, () => client(createOptions)));
  }

  async function closeAll(items) {
    await Promise.all(items.map((item) => item.close()));
  }

  return { client, clients, closeAll };
}
