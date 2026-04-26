/**
 * Browserless API client.
 *
 * Wraps the two operations we need for source-page parsing:
 *   - render(): get the post-JavaScript DOM as HTML
 *   - screenshot(): get a full-page PNG
 *
 * Browserless is a hosted Chromium service. It exposes a JSON API that lets
 * us request "render this URL" without packaging a browser into our own
 * serverless functions. Free tier is fine for development; we can swap to
 * self-hosted Playwright later if costs matter.
 *
 * Docs: https://docs.browserless.io
 *
 * Configuration via env:
 *   BROWSERLESS_API_KEY        — required
 *   BROWSERLESS_BASE_URL       — optional, defaults to production
 */

const DEFAULT_BASE_URL = "https://production-sfo.browserless.io";

export type RenderOptions = {
  // Wait for an extra delay after the page loads, in ms.
  // Useful for pages that lazy-load content after window.load.
  waitAfterLoad?: number;
  // Viewport for rendering — defaults to a desktop size for marketing pages
  viewportWidth?: number;
  viewportHeight?: number;
  // Timeout for the entire render request, in ms
  timeout?: number;
};

const DEFAULTS: Required<RenderOptions> = {
  waitAfterLoad: 1500,
  viewportWidth: 1280,
  viewportHeight: 800,
  timeout: 30000,
};

function getApiConfig() {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) {
    throw new Error("BROWSERLESS_API_KEY is not set");
  }
  const baseUrl = process.env.BROWSERLESS_BASE_URL ?? DEFAULT_BASE_URL;
  return { apiKey, baseUrl };
}

/**
 * Fetch the rendered HTML of a URL.
 * Returns the post-JavaScript DOM serialized as a string.
 */
export async function renderHtml(
  url: string,
  options: RenderOptions = {}
): Promise<string> {
  const { apiKey, baseUrl } = getApiConfig();
  const opts = { ...DEFAULTS, ...options };

  const response = await fetch(`${baseUrl}/content?token=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      gotoOptions: {
        waitUntil: "networkidle2",
        timeout: opts.timeout,
      },
      waitForTimeout: opts.waitAfterLoad,
      viewport: {
        width: opts.viewportWidth,
        height: opts.viewportHeight,
      },
      // Block heavy resources we don't need for parsing structure
      bestAttempt: true,
    }),
    signal: AbortSignal.timeout(opts.timeout + 5000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Browserless render failed (${response.status}): ${errorText.slice(0, 500)}`
    );
  }

  return response.text();
}

/**
 * Capture a full-page screenshot of a URL.
 * Returns the raw PNG bytes as a Uint8Array.
 */
export async function screenshotPage(
  url: string,
  options: RenderOptions = {}
): Promise<Uint8Array> {
  const { apiKey, baseUrl } = getApiConfig();
  const opts = { ...DEFAULTS, ...options };

  const response = await fetch(`${baseUrl}/screenshot?token=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      options: {
        type: "png",
        fullPage: true,
      },
      gotoOptions: {
        waitUntil: "networkidle2",
        timeout: opts.timeout,
      },
      waitForTimeout: opts.waitAfterLoad,
      viewport: {
        width: opts.viewportWidth,
        height: opts.viewportHeight,
      },
      bestAttempt: true,
    }),
    signal: AbortSignal.timeout(opts.timeout + 5000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Browserless screenshot failed (${response.status}): ${errorText.slice(0, 500)}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}