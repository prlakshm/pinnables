import { useCallback, useEffect, useState } from "react";

export interface SiteAccess {
  /** The active tab's origin, or null when it is one we can never annotate. */
  origin: string | null;
  granted: boolean;
  /** Extension pages, chrome://, the Web Store — no permission will help. */
  annotatable: boolean;
  request: () => Promise<void>;
}

/**
 * Whether the overlay is allowed to run on whatever tab is in front.
 *
 * The manifest ships with content scripts matched to localhost only, because an
 * annotation tool that reads every page you visit by default is not one anyone
 * should install. Everywhere else is an optional host permission, and until it
 * is granted there is no content script — so capture mode turns on, the panel
 * says "Capturing", and no toolbar ever appears. That gap is the bug; the fix
 * is that the panel can see it and offer the grant.
 *
 * `chrome.permissions.request` needs a user gesture, which is why this returns
 * a callback for a button to own rather than asking on mount.
 */
export function useSiteAccess(): SiteAccess {
  const [origin, setOrigin] = useState<string | null>(null);
  const [granted, setGranted] = useState(true);
  const [annotatable, setAnnotatable] = useState(true);

  const check = useCallback(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let url: URL | null = null;
    try {
      url = tab?.url ? new URL(tab.url) : null;
    } catch {
      url = null;
    }

    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      setOrigin(null);
      setAnnotatable(false);
      setGranted(false);
      return;
    }

    setOrigin(url.origin);
    setAnnotatable(true);
    setGranted(await chrome.permissions.contains({ origins: [`${url.origin}/*`] }));
  }, []);

  useEffect(() => {
    void check();
    // The front tab changes under the panel without the panel re-rendering, so
    // both the switch and the navigation have to be watched.
    const onActivated = () => void check();
    const onUpdated = (_id: number, info: chrome.tabs.TabChangeInfo) => {
      if (info.status === "complete" || info.url) void check();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [check]);

  const request = useCallback(async () => {
    if (!origin) return;
    await chrome.permissions.request({ origins: [`${origin}/*`] });
    await check();
  }, [origin, check]);

  return { origin, granted, annotatable, request };
}
