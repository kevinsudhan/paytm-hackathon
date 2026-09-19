/**
 * Where this app is served: "/" when it has its own port, "/apps/<build>/" when a hosted
 * builder serves it. The server writes it into <base href>, so one built bundle works in
 * both places — the API calls, the router and the asset paths all follow it.
 */
export const BASE = new URL(document.baseURI).pathname.replace(/\/?$/, "/");

/** "/api/app" -> "/apps/dental-4796c5/api/app" under a builder; unchanged on its own port. */
export const apiUrl = (path: string) => BASE.replace(/\/$/, "") + path;

/** The router's basename: the base without its trailing slash. */
export const ROUTER_BASE = BASE === "/" ? "/" : BASE.replace(/\/$/, "");
