// Tiny navigation indirection so screens can request route changes without
// importing the boot module (avoids circular imports).

export type Route = { view: "home" } | { view: "editor"; projectPath: string };

type Navigate = (route: Route) => void;

let impl: Navigate = () => {};

export function setNavigator(nav: Navigate): void {
  impl = nav;
}

export function navigate(route: Route): void {
  impl(route);
}
