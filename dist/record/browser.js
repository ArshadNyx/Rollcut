import { chromium } from '@playwright/test';
import { egressArgs } from './egress.js';
/** Every browser Rollcut opens goes through here, so public-only mode (see
    egress.ts) applies to recording, planning, capture and repair alike. */
export async function launchBrowser(options = {}) {
    return chromium.launch({ ...options, args: [...(options.args ?? []), ...(await egressArgs())] });
}
//# sourceMappingURL=browser.js.map