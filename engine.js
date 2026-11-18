// Runs each room's mixer inside a headless Chromium on the server.
//
// The mixer is browser code (Web Audio and WebRTC), so the quickest sound way
// to host it on a server is to give it a browser. One Chromium process is
// shared; each room gets its own isolated page.

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: [
          // start audio without a click, and never wait on a permission prompt
          '--autoplay-policy=no-user-gesture-required',
          '--use-fake-ui-for-media-stream',
          // a server has no sound card; this supplies a null output device
          '--use-fake-device-for-media-stream',
          // publish real addresses in ICE candidates instead of .local names,
          // which clients outside this machine could not resolve
          '--disable-features=WebRtcHideLocalIpsWithMdns',
        ],
      });
      browser.on('disconnected', () => { browserPromise = null; });
      return browser;
    })();
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

/** Opens the mixer page at url. Resolves to a handle with close(). */
export async function launchEngine(url) {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('[mixer]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[mixer]', msg.text());
  });
  await page.goto(url);
  return {
    close: async () => {
      try { await context.close(); } catch { /* already gone */ }
    },
  };
}

export async function shutdownEngines() {
  if (!browserPromise) return;
  try { await (await browserPromise).close(); } catch { /* already gone */ }
  browserPromise = null;
}
