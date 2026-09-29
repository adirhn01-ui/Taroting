// Tiny navigation indirection so screens can request route changes without
// importing the boot module (avoids circular imports).

/** `returnTo` = the media path the viewer was showing when it opened this
 *  project; every editor exit goes back there instead of home. */
export type EditorRoute = { view: "editor"; projectPath: string; temp?: true; returnTo?: string };
/** The folder viewer showing `path` (no project, no session). */
export type ViewerRoute = { view: "viewer"; path: string };
export type Route = { view: "home" } | EditorRoute | { view: "settings" } | ViewerRoute;

type Navigate = (route: Route) => void;

let impl: Navigate = () => {};

export function setNavigator(nav: Navigate): void {
  impl = nav;
}

export function navigate(route: Route): void {
  impl(route);
}

/**
 * Where every exit from a project editor lands: Back/Ctrl+W, the keep/discard
 * outcomes, and a failed load. An editor opened from the viewer ("Open as
 * project") goes back to the viewer on the same file; everything else goes
 * home. One function, so no exit can honour `returnTo` while another forgets it
 * (the guard-applied-to-three-of-four-exits shape this repo keeps finding). The
 * gear is deliberately NOT an exit here: it goes to Settings, whose Back goes
 * home.
 *
 * It lives here rather than in either editor because the video editor and the
 * image editor are separate lazy chunks: both must share this one rule, and an
 * import from one editor into the other would pull a whole editor into the
 * wrong chunk.
 */
export function exitDest(route: EditorRoute): Route {
  return route.returnTo ? { view: "viewer", path: route.returnTo } : { view: "home" };
}
