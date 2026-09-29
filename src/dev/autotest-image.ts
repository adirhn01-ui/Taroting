// Image-project E2E blocks. DEV-only: imported lazily by autotest.ts, never
// part of a release bundle.
//
// Not written yet: the entry point is fixed so the harness registers it with
// one line, beside runWave1Blocks and runViewerBlocks. Until then it runs no
// block, and the run's block count is unchanged.

import type { Wave1Ctx } from "./autotest-wave1";

/** Same harness surface as the Wave 1 and viewer blocks. */
export type ImageCtx = Wave1Ctx;

export async function runImageBlocks(ctx: ImageCtx): Promise<void> {
  void ctx;
}
