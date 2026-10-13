import type { Browser } from "playwright";

// Headless Chromium advertises "HeadlessChrome" in its UA, an obvious bot tell.
// Derive a normal desktop Chrome UA from the real browser version.
export function normalUserAgent(browser: Browser): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
}
