import { chromium, type BrowserContext } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const DIST_DIR = resolve(here, '../../../dist');
export const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * A real, unpacked MV3 extension loaded into a real (headless) Chromium
 * profile — not a mock. Extensions require Chrome's persistent-context API;
 * there is no incognito/ephemeral-context way to load one.
 */
export async function launchWithExtension(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: [
      '--headless=new',
      `--disable-extensions-except=${DIST_DIR}`,
      `--load-extension=${DIST_DIR}`,
    ],
  });
}
