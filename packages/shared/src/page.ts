/**
 * Where a pin came from, and what to call that place on screen.
 *
 * Two questions live here because they share one answer. "Is this page mine?"
 * decides whether a pin belongs on the page you are standing on, and it decides
 * whether its source line reads as a route or as a host — a route is a
 * coordinate the agent can act on, and only your own dev server has those.
 */

/** The origin, or "" when the url predates this field or was never valid. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".test", ".localdomain"];

/**
 * A development server, as opposed to somebody's website.
 *
 * Loopback and the reserved local TLDs are the obvious half. The private IPv4
 * ranges are the half that matters in practice: `vite --host` binds the LAN
 * address so a phone can reach the dev server, and a pin captured that way is
 * still a pin on your own app.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [first, second] = [Number(ipv4[1]), Number(ipv4[2])];
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  return false;
}

export function isLocalUrl(url: string): boolean {
  try {
    return isLocalHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** How much of a shortened url fits beside a pin's name in the label bar. */
export const SOURCE_LABEL_BUDGET = 28;

function clip(value: string, budget: number): string {
  return value.length <= budget ? value : `${value.slice(0, Math.max(1, budget - 1))}…`;
}

/**
 * A foreign url, cut in the middle rather than at the end.
 *
 * Both ends carry the meaning: the host says whose design this is, the last
 * segment says which page of it. Everything between is routing scaffolding, so
 * that is what goes. Cutting at the end — which is what `text-overflow` would
 * do on its own — throws away the informative half and leaves the scaffolding.
 *
 * The query string and fragment go entirely. A tracking parameter is never the
 * thing that identifies a component.
 */
export function shortenUrl(url: string, budget = SOURCE_LABEL_BUDGET): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }

  // `host` and not `hostname`, so a non-default port survives; the URL parser
  // has already dropped :80 and :443, which never told anyone anything.
  const host = parsed.host.replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return clip(host, budget);

  const whole = `${host}/${segments.join("/")}`;
  if (whole.length <= budget) return whole;

  const leaf = segments[segments.length - 1];
  if (segments.length > 1) {
    const elided = `${host}/…/${leaf}`;
    if (elided.length <= budget) return elided;
  }

  // The leaf alone overruns. Keep the host whole — a truncated host names the
  // wrong site — and cut into the leaf from its end.
  const prefix = segments.length > 1 ? `${host}/…/` : `${host}/`;
  const room = budget - prefix.length;
  return room >= 5 ? prefix + clip(leaf, room) : clip(host, budget);
}

/**
 * The line under a pin's name: where this came from, most actionable first.
 *
 * A file and line beats everything, because it is the thing the agent edits.
 * Failing that, your own dev server answers with its route, which is a place
 * the agent can navigate to and re-render. A site you do not own has no such
 * coordinate — its route is `/` and means nothing — so it answers with the host,
 * which at least says whose design you are borrowing.
 */
export function sourceLabel(
  pin: { sourceFile: string | null; route: string; url: string },
  budget = SOURCE_LABEL_BUDGET,
): string {
  if (pin.sourceFile) return pin.sourceFile;
  if (isLocalUrl(pin.url)) return pin.route;
  return shortenUrl(pin.url, budget) || pin.route;
}

export interface PagePlace {
  origin: string;
  route: string;
}

/**
 * A hash-router fragment (`#/catalogue`, `#!/vault`), not an in-page anchor.
 *
 * `#section-2` is a place on the same screen. `#/` and `#!/` are the whole
 * route, and are what split a hash-routed default view from its bare `/`.
 */
export function isHashRouterHash(hash: string): boolean {
  return hash.startsWith("#!/") || hash.startsWith("#/");
}

export function isHashRouterUrl(url: string): boolean {
  try {
    return isHashRouterHash(new URL(url).hash);
  } catch {
    return false;
  }
}

/**
 * Strict route identity, plus the one pair a hash-routed default view needs.
 *
 * `/` is never a wildcard. It matches `rootAlias` and nothing else — so
 * `/catalogue` still does not match `/vault`, and a path-routed homepage
 * still does not match `/dashboard`.
 */
export function routesMatch(
  a: string,
  b: string,
  rootAlias: string | null | undefined,
): boolean {
  if (a === b) return true;
  if (!rootAlias) return false;
  return (a === "/" && b === rootAlias) || (b === "/" && a === rootAlias);
}

export interface RootAliasPin {
  url: string;
  route: string;
  kind?: string;
}

function uniqueRouteWinner(votes: Map<string, number>): string | null {
  let winner: string | null = null;
  let max = 0;
  let tied = false;
  for (const [route, count] of votes) {
    if (count > max) {
      winner = route;
      max = count;
      tied = false;
    } else if (count === max && count > 0) {
      tied = true;
    }
  }
  if (!winner || max === 0 || tied || winner === "/") return null;
  return winner;
}

function isLocalOrigin(origin: string): boolean {
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * When a local hash-routed app serves its default view at both `/` and
 * `#/thing`, name the concrete route `/` stands for — or stay strict.
 *
 * A real path (`/dashboard`) is a different page. This never guesses from
 * an empty URL alone: the origin must be local, and a stored pin URL (or
 * the current hash) must already carry `#/` or `#!/`. `/` is never the
 * alias, and never matches every route.
 */
export function inferRootAlias<T extends RootAliasPin>(
  here: PagePlace,
  locationHash: string,
  pins: readonly T[],
  present: (pin: T) => boolean,
): string | null {
  if (!isLocalOrigin(here.origin)) return null;

  const sameOrigin = pins.filter((pin) => {
    const origin = originOf(pin.url);
    return origin === "" || origin === here.origin;
  });
  const hashRoutedOrigin =
    isHashRouterHash(locationHash) || sameOrigin.some((pin) => isHashRouterUrl(pin.url));
  if (!hashRoutedOrigin) return null;

  const elementPins = sameOrigin.filter((pin) => pin.kind == null || pin.kind === "element");

  if (here.route === "/" && !isHashRouterHash(locationHash)) {
    const votes = new Map<string, number>();
    for (const pin of elementPins) {
      if (!isHashRouterUrl(pin.url) || !present(pin) || pin.route === "/") continue;
      votes.set(pin.route, (votes.get(pin.route) ?? 0) + 1);
    }
    return uniqueRouteWinner(votes);
  }

  if (isHashRouterHash(locationHash) && here.route !== "/") {
    const rootPresent = elementPins.some(
      (pin) => pin.route === "/" && !isHashRouterUrl(pin.url) && present(pin),
    );
    if (!rootPresent) return null;
    const otherHashPresent = elementPins.some(
      (pin) => isHashRouterUrl(pin.url) && pin.route !== here.route && present(pin),
    );
    if (otherHashPresent) return null;
    return here.route;
  }

  return null;
}

/**
 * Whether a pin belongs to the page in front of you.
 *
 * Route alone used to answer this, which held only while every page was your
 * own dev server. A capture from vercel.com has route `/`, and so does the root
 * of every other site in the world — matching on the path alone seats somebody
 * else's banner on your homepage. Origin is what separates two pages that
 * happen to share a path.
 *
 * Pins written before origins were recorded have a url to derive one from; the
 * empty origin left by an unparseable url falls back to the old behaviour
 * rather than making an old pin unreachable.
 *
 * `rootAlias` is the one extra pair a hash-routed default view needs: `/`
 * and `#/catalogue` are the same page when the overlay has proven it. Omit
 * it and the check stays exact.
 */
export function isPinOnPage(
  pin: { url: string; route: string },
  here: PagePlace,
  rootAlias?: string | null,
): boolean {
  if (!routesMatch(pin.route, here.route, rootAlias)) return false;
  const origin = originOf(pin.url);
  return origin === "" || origin === here.origin;
}
