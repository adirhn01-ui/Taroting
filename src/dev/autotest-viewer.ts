// Viewer + open-with E2E blocks (Wave 2). DEV-only: imported lazily by
// autotest.ts, never part of a release bundle.

import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the Wave 1 blocks. */
export type ViewerCtx = Wave1Ctx;

export async function runViewerBlocks(_ctx: ViewerCtx): Promise<void> {}
