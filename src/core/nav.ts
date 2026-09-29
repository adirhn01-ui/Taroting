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
