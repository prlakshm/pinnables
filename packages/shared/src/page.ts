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
 */
export function isPinOnPage(
  pin: { url: string; route: string },
  here: PagePlace,
): boolean {
  if (pin.route !== here.route) return false;
  const origin = originOf(pin.url);
  return origin === "" || origin === here.origin;
}
