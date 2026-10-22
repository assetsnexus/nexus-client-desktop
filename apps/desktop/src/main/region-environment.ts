/**
 * Read the connected region's environment for the sandbox badge.
 *
 * Uses the same public command the portal's header badge uses
 * (`anx.config.environment`), so the desktop and the portal agree on which
 * instance is a sandbox. This is a best-effort, signed-out-safe lookup: any
 * failure (offline region, non-public response, malformed payload) resolves to
 * `null` so the caller fails closed and never blocks the login screen.
 */

import { sendCommand, type AuthClientOptions } from '@nexus/node-core';
import {
  environmentFromConfigResponse,
  type RegionEnvironment,
} from '../shared/sandbox-environment.js';

export async function readRegionEnvironment(
  options: AuthClientOptions,
): Promise<RegionEnvironment | null> {
  try {
    const res = await sendCommand(options, 'anx.config.environment', {});
    return environmentFromConfigResponse({
      responseCode: res.responseCode,
      responseObject: res.responseObject,
    });
  } catch {
    // A region outage must not lock the user out or falsely claim sandbox.
    return null;
  }
}
