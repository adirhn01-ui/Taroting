// Tiny navigation indirection so screens can request route changes without
// importing the boot module (avoids circular imports).

/** `returnTo` = the media path the viewer was showing when it opened this
 *  project; every editor exit goes back there instead of home. Legal now,
 *  honoured once the viewer route exists. */
export type EditorRoute = { view: "editor"; projectPath: string; temp?: true; returnTo?: string };
export type Route = { view: "home" } | EditorRoute | { view: "settings" };

type Navigate = (route: Route) => void;

let impl: Navigate = () => {};

export function setNavigator(nav: Navigate): void {
  impl = nav;
}

export function navigate(route: Route): void {
  impl(route);
}
