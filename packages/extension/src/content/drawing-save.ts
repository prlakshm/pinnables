import type { DrawShape } from "@pinnables/shared";

/**
 * Chrome allows only a small number of visible-tab captures per second. A
 * stroke still saves immediately, but the expensive screenshot waits for a
 * quiet beat and represents the newest complete shape list.
 */
export const DRAWING_SCREENSHOT_DELAY_MS = 700;

interface DrawingSaveScheduler {
  schedule(callback: () => void, delay: number): number;
  cancel(timer: number): void;
}

const browserScheduler: DrawingSaveScheduler = {
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  cancel: (timer) => window.clearTimeout(timer),
};

export interface DrawingSaveCoordinator {
  /** Persist one exact edit now, then move the screenshot deadline. */
  update(shapes: DrawShape[]): void;
  /** Take the latest pending screenshot at the next place in the write queue. */
  flushScreenshot(): void;
  /** Wait for work that has already entered the serial queue. */
  whenIdle(): Promise<void>;
  /** Cancel only the pending screenshot; already-enqueued shape writes finish. */
  dispose(): void;
}

/**
 * Keep board writes ordered while coalescing screenshot work.
 *
 * Every edit is sent because dropping an intermediate list can resurrect an
 * erased stroke if an older request reaches the worker last. Only screenshots
 * are coalesced: they are visual cache, while the shape list is user data.
 */
export function createDrawingSaveCoordinator(
  persist: (shapes: DrawShape[], includeScreenshot: boolean) => Promise<void>,
  scheduler: DrawingSaveScheduler = browserScheduler,
): DrawingSaveCoordinator {
  let latest: DrawShape[] = [];
  let timer: number | null = null;
  let tail = Promise.resolve();
  let disposed = false;

  const enqueue = (shapes: DrawShape[], includeScreenshot: boolean) => {
    const snapshot = [...shapes];
    // A failed write must not permanently poison the queue. `persist` owns the
    // user-facing error, so the next real edit can still be attempted.
    tail = tail.catch(() => {}).then(() => persist(snapshot, includeScreenshot));
  };

  const cancelTimer = () => {
    if (timer === null) return;
    scheduler.cancel(timer);
    timer = null;
  };

  const flushScreenshot = () => {
    // No timer means this quiet state has already entered the queue (or there
    // has not been an edit), so flushing again would spend a capture for the
    // same pixels.
    if (timer === null) return;
    cancelTimer();
    if (disposed || latest.length === 0) return;
    enqueue(latest, true);
  };

  return {
    update(shapes) {
      if (disposed) return;
      latest = [...shapes];
      enqueue(latest, false);
      cancelTimer();
      if (latest.length === 0) return;
      timer = scheduler.schedule(() => {
        timer = null;
        if (!disposed) enqueue(latest, true);
      }, DRAWING_SCREENSHOT_DELAY_MS);
    },
    flushScreenshot,
    whenIdle: () => tail,
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}
