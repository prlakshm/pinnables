import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Board, Capture, Pin, PinVersion } from "@pinnables/shared";
import { send } from "../lib/messages";
import { GripIcon } from "../ui/icons";

/**
 * Version keys — the rail, the captures, and every gesture between them.
 *
 * Every completed run earns a numeral; the numeral sits on the chat row that
 * produced it and on this floating rail beside the component, and pressing it
 * puts the working tree back. Keys can also be lifted off the rail and set
 * down as captures — static pictures of a state, each with a rail of its own —
 * so several states can be compared side by side.
 *
 * The one structural rule everything below leans on: every key lives in
 * exactly one rail. The main rail is the remainder — whatever no capture
 * holds — so a numeral never needs a notion of focus to be unambiguous, and
 * ⌥N can answer from any rail at once.
 *
 * Ported from mocks/toggle-redesign.html, which is the spec for every
 * behaviour here. Drag is imperative (window listeners, a fixed-position
 * ghost, direct style writes) exactly as the mock does it, because a drop
 * re-renders every rail and React state per pointer-move would fight the
 * gesture; React owns what exists, the gesture owns where it is.
 */

/* Timing, from the mock. */
const DONE_FLASH_MS = 1200;
const FLIGHT_MS = 430;
/** How long a fresh key stays collapsed while its chat row flashes Done and
    the copy flies over: flash + row-grow beat + flight, with a little slack. */
const ENTER_HOLD_MS = DONE_FLASH_MS + 220 + FLIGHT_MS + 400;
/** A press is a switch; movement past this is a carry. */
const DRAG_THRESHOLD = 5;
/** Gap between a card and its seated rail, and inside the composer scoot. */
const SEAT_GAP = 10;
const SCOOT_GAP = 8;

export interface RailBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One routine seats every rail, the main one and each capture's alike.
 *
 * A rail that has been dragged has a position of its own and only gets
 * clamped. One that has not walks a ring around its card — right edge on the
 * bottom, then underneath right-aligned, then the left edge — so a component
 * pushed against a screen edge takes its rail round with it instead of
 * letting it be cut off.
 */
export function seatRail(
  rail: { width: number; height: number },
  card: RailBox,
  foot: RailBox | null,
  manual: { x: number; y: number } | null,
  viewport: { width: number; height: number },
): { x: number; y: number; placed: string } {
  const { width: w, height: h } = rail;
  const vw = viewport.width;
  const vh = viewport.height;

  if (manual) {
    return {
      x: Math.max(4, Math.min(manual.x, vw - w - 4)),
      y: Math.max(4, Math.min(manual.y, vh - h - 4)),
      placed: "moved",
    };
  }

  /* The foot is whatever the rail must clear when it drops underneath —
     the composer for the live pin, the card itself for a capture. */
  const footBox = foot ?? card;
  const spots: Record<string, { x: number; y: number }> = {
    "card-right": { x: card.x + card.width + SEAT_GAP, y: card.y + card.height - h },
    below: { x: card.x + card.width - w, y: footBox.y + footBox.height + SEAT_GAP },
    "card-left": { x: card.x - SEAT_GAP - w, y: card.y + card.height - h },
  };
  const fits = (where: string) => {
    const s = spots[where];
    return s.x > 4 && s.x + w < vw - 4 && s.y > 4 && s.y + h < vh - 4;
  };
  const order = ["card-right", "below", "card-left"];
  const chosen = order.find(fits) ?? order[order.length - 1];
  const at = spots[chosen];
  /* Clamped as a last resort, so it is crowded rather than gone. */
  return {
    x: Math.max(4, Math.min(at.x, vw - w - 4)),
    y: Math.max(4, Math.min(at.y, vh - h - 4)),
    placed: chosen,
  };
}

/**
 * The composer gets out of the rail's way, and no further.
 *
 * Dragged down the card's bottom edge the rail lands on top of the composer,
 * so the composer steps down just far enough to sit under it, keeping the gap
 * below the rail equal to the gap above it. Capped at the layout the rail
 * actually needs — gap, rail, gap — because uncapped it tracked the rail down
 * the page and dragging far enough pulled the composer off the pin entirely.
 */
export function composerScoot(rail: RailBox, card: RailBox, note: RailBox): number {
  const hangs = rail.y + rail.height - (card.y + card.height);
  const overlapsAcross = rail.x < note.x + note.width && rail.x + rail.width > note.x;
  if (hangs <= 0 || !overlapsAcross) return 0;
  const ceiling = SCOOT_GAP + rail.height + SCOOT_GAP;
  const above = Math.max(0, rail.y - (card.y + card.height));
  return Math.min(ceiling, Math.max(SCOOT_GAP, hangs + above));
}

/* ------------------------------------------------------------------ flight */

/**
 * The key flies out of the chat row and into the rail.
 *
 * Without it the two keycaps just appear in two places a beat apart, and
 * nothing says they are the same key. Exported for SelectionDialog, whose
 * settled row is where the flight begins; the rail key is found by number so
 * neither component needs a ref into the other.
 */
export function flyKeyToRail(fromKey: HTMLElement, no: number): void {
  const root = fromKey.getRootNode() as ShadowRoot | Document;
  const railKey = root.querySelector<HTMLElement>(
    `.pin-versions[data-rail="main"] .pin-key[data-no="${no}"]`,
  );
  const done = () => {
    root.dispatchEvent(new CustomEvent("pin:key-landed", { detail: { no } }));
  };
  if (!railKey || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    done();
    return;
  }

  /* Where the key will sit once the rail has made room. Measured with the
     transition off so the answer is the settled position, not a frame of it. */
  railKey.style.transition = "none";
  railKey.style.visibility = "hidden";
  railKey.dataset.entering = "false";
  void railKey.offsetWidth;
  const to = railKey.getBoundingClientRect();
  railKey.dataset.entering = "true";
  void railKey.offsetWidth;
  railKey.style.transition = "";

  const from = fromKey.getBoundingClientRect();
  const ghost = fromKey.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("data-no");
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.cssText =
    "position:fixed;margin:0;z-index:9999;pointer-events:none;" +
    `left:${from.left}px;top:${from.top}px;` +
    `width:${from.width}px;height:${from.height}px;max-width:none;` +
    "transition:transform 420ms var(--ease), width 420ms var(--ease);";
  /*
   * The two rails write a key differently: a chat row carries its own ⌥
   * because it stands alone, while the rail has one at its head for all of
   * them. So the copy sheds its modifier on the way over and arrives in the
   * form the rail uses — the same key, in the local dialect.
   */
  const ghostMod = ghost.querySelector<HTMLElement>(".pin-key__mod");
  if (ghostMod) {
    ghostMod.style.cssText =
      "overflow:hidden;max-width:20px;" +
      "transition:max-width 300ms var(--ease), margin-right 300ms var(--ease), opacity 200ms ease;";
  }
  (railKey.closest(".pin-overlay") ?? fromKey.parentElement ?? document.body).appendChild(ghost);

  /* The gap opens now, over the same time the copy spends travelling. */
  railKey.dataset.entering = "false";

  let kicked = false;
  const kick = () => {
    if (kicked) return;
    kicked = true;
    ghost.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px)`;
    ghost.style.width = `${to.width}px`;
    if (ghostMod) {
      ghostMod.style.maxWidth = "0px";
      ghostMod.style.marginRight = "0px";
      ghostMod.style.opacity = "0";
    }
  };
  requestAnimationFrame(kick);
  window.setTimeout(kick, 24);

  window.setTimeout(() => {
    ghost.remove();
    railKey.style.visibility = "";
    railKey.dataset.landed = "true";
    window.setTimeout(() => railKey.removeAttribute("data-landed"), 560);
    done();
  }, FLIGHT_MS);
}

/* ------------------------------------------------------------------- layer */

type RailId = "main" | string;

interface DragKey {
  kind: "key";
  version: PinVersion;
  from: RailId;
  ghost: HTMLElement;
  dx: number;
  dy: number;
  slotIn: HTMLElement | null;
}

interface DragRail {
  kind: "rail";
  from: RailId;
  carrying: PinVersion[];
  el: HTMLElement;
  restorePointer: string;
  dx: number;
  dy: number;
  moved: boolean;
  at: { x: number; y: number } | null;
  slotIn: HTMLElement | null;
}

interface DragCapture {
  kind: "capture";
  capture: Capture;
  wrap: HTMLElement;
  railEl: HTMLElement | null;
  dx: number;
  dy: number;
  pos: { x: number; y: number };
  railPos: { x: number; y: number } | null;
}

type Drag = DragKey | DragRail | DragCapture;

export interface VersionLayerProps {
  board: Board;
  pin: Pin;
  /** The live element's box, for seating the main rail. */
  liveRect: DOMRect | null;
  /** Whether the selection chrome is up at all — Escape and deselect hide
      the rail and every capture with it. */
  visible: boolean;
  versionsOk: boolean;
  /**
   * The open chapter. Keys stamped with an earlier head were absorbed by a
   * commit — their patches describe a tree that no longer exists — so they
   * leave the rail, the captures, and the chord. Null tolerates old data:
   * everything stays pressable and the service is the backstop.
   */
  projectHead?: string | null;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  /** The composer steps down to clear a rail dropped onto it. */
  onScoot: (px: number) => void;
  /**
   * The scoot currently applied, fed back so seating re-runs once the
   * composer has moved — the mock re-placed every frame; here the changed
   * margin is the signal. The formula's cap makes the loop converge.
   */
  scoot: number;
}

/** The version's picture, from storage — falls back to the pin's own shot. */
function useVersionShot(pinId: string, version: PinVersion | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const key = version?.screenshotKey ?? null;
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    const keys = [key, `shot:${pinId}`].filter((k): k is string => k !== null);
    void chrome.storage.local.get(keys).then((bag) => {
      if (cancelled) return;
      setSrc((key && (bag[key] as string | undefined)) ?? (bag[`shot:${pinId}`] as string) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [pinId, key]);
  return src;
}

function sortByNo(list: PinVersion[]): PinVersion[] {
  return [...list].sort((a, b) => a.no - b.no);
}

export function VersionLayer({
  board,
  pin,
  liveRect,
  visible,
  versionsOk,
  projectHead = null,
  busy,
  onBusy,
  onScoot,
  scoot,
}: VersionLayerProps) {
  /*
   * Only the open chapter's keys exist here. A stale key filtered at the
   * top vanishes everywhere at once — rail, captures, ⌥N — because every
   * lookup below starts from this list.
   */
  const versions = useMemo(
    () =>
      (pin.versions ?? []).filter(
        (v) => v.head === null || projectHead === null || v.head === projectHead,
      ),
    [pin.versions, projectHead],
  );
  const captures = useMemo(
    () =>
      (board.captures ?? []).filter(
        (cap) => cap.pinId === pin.id && cap.keys.some((k) => versions.some((v) => v.no === k)),
      ),
    [board.captures, pin.id, versions],
  );

  /*
   * The partition. Every key lives in exactly one rail: captures hold what
   * they hold, the main rail is the remainder.
   */
  const held = useMemo(() => new Set(captures.flatMap((cap) => cap.keys)), [captures]);
  const mainKeys = useMemo(
    () => sortByNo(versions.filter((v) => !held.has(v.no))),
    [versions, held],
  );
  const homeOf = useCallback(
    (no: number): RailId => captures.find((cap) => cap.keys.includes(no))?.id ?? "main",
    [captures],
  );

  const layerRef = useRef<HTMLDivElement>(null);
  const mainRailRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  /** ⌥ held — the rail's mod glyph inks, saying the chord is armed. */
  const [armed, setArmed] = useState(false);
  /** The key still in the air from the chat row; collapsed until it lands. */
  const [enteringNo, setEnteringNo] = useState<number | null>(null);
  const seenVersions = useRef<Set<string>>(new Set());
  const shotTried = useRef<Set<string>>(new Set());
  /** Main-rail position while dragging, before it is persisted on release. */
  const [railDragPos, setRailDragPos] = useState<{ x: number; y: number } | null>(null);

  const showMain = visible && versionsOk && versions.length >= 2 && liveRect !== null;

  /* ------------------------------------------------------------ helpers */

  const root = () =>
    (layerRef.current?.getRootNode() ?? document) as ShadowRoot | Document;

  const overlayEl = () => layerRef.current?.closest(".pin-overlay") ?? document.body;

  const railUnder = (ev: PointerEvent): HTMLElement | null => {
    const el = root().elementFromPoint?.(ev.clientX, ev.clientY) ?? null;
    return (el?.closest(".pin-versions") as HTMLElement | null) ?? null;
  };

  const clearSlots = useCallback(() => {
    root().querySelectorAll?.(".pin-key--slot").forEach((n) => n.remove());
  }, []);

  /*
   * Opened in the seat the key would actually take, found by number, so the
   * rail shows where it is going and not merely that it will take it. One
   * placeholder per key on its way in — a whole rail dropping in opens one
   * per key it carries, which a ring around the pill could never say.
   */
  const openSlots = useCallback(
    (railEl: HTMLElement, incoming: PinVersion[]) => {
      clearSlots();
      incoming.forEach((o) => {
        const slot = document.createElement("span");
        slot.className = "pin-key pin-key--slot";
        let after: HTMLElement | null = null;
        railEl.querySelectorAll<HTMLElement>(".pin-key").forEach((k) => {
          if (after || !k.dataset.no) return;
          if (Number(k.dataset.no) > o.no) after = k;
        });
        railEl.insertBefore(slot, after);
        /* Grown rather than popped, on the same transition every key uses. */
        slot.dataset.entering = "true";
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            slot.dataset.entering = "false";
          });
        });
        window.setTimeout(() => {
          slot.dataset.entering = "false";
        }, 60);
      });
    },
    [clearSlots],
  );

  /* Whatever happens, no ghost survives the gesture that made it. */
  const sweepGhosts = useCallback(() => {
    clearSlots();
    root()
      .querySelectorAll?.(".pin-key--ghost")
      .forEach((g) => g.remove());
    root()
      .querySelectorAll?.('.pin-key[data-dragging="true"]')
      .forEach((k) => {
        (k as HTMLElement).dataset.dragging = "false";
      });
  }, [clearSlots]);

  /* ------------------------------------------------------------- actions */

  const saveCaptures = useCallback(
    (next: Capture[]) => {
      void send("capture/save", { boardId: board.id, captures: next }).catch(() => {});
    },
    [board.id],
  );

  const restore = useCallback(
    (no: number) => {
      if (busy || pin.currentVersionNo === no) return;
      onBusy(true);
      void send("version/restore", { pinId: pin.id, no })
        .catch(() => {})
        .finally(() => onBusy(false));
    },
    [busy, pin.currentVersionNo, pin.id, onBusy],
  );

  /** What a rail shows after this key leaves it, and who answers live. */
  const detachFromMain = useCallback(
    (o: PinVersion) => {
      if (pin.currentVersionNo !== o.no) return;
      /*
       * The one before it, or the one after if it was first — read before
       * the key has moved, so the row it steps back through is the row you
       * saw. The live component is the expensive thing here: falling back is
       * a real restore, files and all.
       */
      const row = mainKeys;
      const i = row.findIndex((x) => x.no === o.no);
      const heir = row[i - 1] ?? row[i + 1];
      if (heir) restore(heir.no);
    },
    [pin.currentVersionNo, mainKeys, restore],
  );

  /** Lay a carried key down as a fresh capture where it was dropped. */
  const layDown = useCallback(
    (o: PinVersion, from: RailId, x: number, y: number) => {
      let next = captures;
      if (from !== "main") {
        next = next
          .map((cap) =>
            cap.id === from ? { ...cap, keys: cap.keys.filter((k) => k !== o.no) } : cap,
          )
          .filter((cap) => cap.keys.length > 0)
          .map((cap) =>
            cap.keys.includes(cap.current) ? cap : { ...cap, current: sortByNo(cap.keys.map((k) => versions.find((v) => v.no === k)!).filter(Boolean))[0]?.no ?? cap.keys[0] },
          );
      } else {
        detachFromMain(o);
      }
      /*
       * The key is what you were carrying, so the key is what lands under
       * the pointer. The picture attaches above it — anchoring the card's
       * corner to the cursor instead put a full-size card wherever a 19px
       * key had been, which reads as the drop having missed.
       */
      const lift = (pin.elementSize?.height || 200) + 8;
      saveCaptures([
        ...next,
        {
          id: `cap-${Date.now().toString(36)}`,
          pinId: pin.id,
          keys: [o.no],
          current: o.no,
          pos: { x: Math.max(4, x), y: Math.max(4, y - lift) },
          railPos: null,
        },
      ]);
    },
    [captures, versions, detachFromMain, saveCaptures, pin.id, pin.elementSize],
  );

  /** Move one key between rails. Coming home is putting it away, not choosing it. */
  const moveKey = useCallback(
    (o: PinVersion, from: RailId, to: RailId) => {
      let next = captures;
      if (from !== "main") {
        next = next
          .map((cap) =>
            cap.id === from ? { ...cap, keys: cap.keys.filter((k) => k !== o.no) } : cap,
          )
          .filter((cap) => cap.keys.length > 0);
      } else {
        detachFromMain(o);
      }
      if (to !== "main") {
        next = next.map((cap) =>
          cap.id === to && !cap.keys.includes(o.no)
            ? { ...cap, keys: [...cap.keys, o.no], current: o.no }
            : cap,
        );
      }
      /* Emptied-by-departure captures fix their lit key server-side too. */
      next = next.map((cap) =>
        cap.keys.includes(cap.current) ? cap : { ...cap, current: cap.keys[0] },
      );
      saveCaptures(next);
    },
    [captures, detachFromMain, saveCaptures],
  );

  /*
   * Merging always deletes a secondary rail, whichever way it was dragged.
   * The main rail is the remainder, so keys returning to it need no move —
   * the secondary simply ceases to hold them. The target keeps the version
   * it was already showing, because the target is the thing that stays.
   */
  const absorb = useCallback(
    (sourceId: string, targetId: RailId) => {
      const source = captures.find((cap) => cap.id === sourceId);
      if (!source) return;
      let next = captures.filter((cap) => cap.id !== sourceId);
      if (targetId !== "main") {
        next = next.map((cap) =>
          cap.id === targetId
            ? {
                ...cap,
                keys: [...cap.keys, ...source.keys.filter((k) => !cap.keys.includes(k))],
              }
            : cap,
        );
      }
      saveCaptures(next);
    },
    [captures, saveCaptures],
  );

  /* -------------------------------------------------------------- drags */

  const keyDown = useCallback(
    (e: React.PointerEvent, o: PinVersion, railId: RailId, el: HTMLElement) => {
      if (e.button !== 0 || busy) return;
      /*
       * Any key may be set down, the lit one included — the live component
       * just falls back to its neighbour. The only thing held back is the
       * main rail's last key: the files are always in some state, so the
       * rail that names that state can never be empty. A capture has no such
       * duty and may be emptied, which is how it gets dismissed.
       */
      const pinned = railId === "main" && mainKeys.length <= 1;
      const sx = e.clientX;
      const sy = e.clientY;
      let started = false;
      e.preventDefault();

      /*
       * On the window, not on the key. A drop re-renders every rail, so the
       * button these listeners were attached to is gone by the time the
       * pointer comes up — and with it the only code that removes the ghost.
       * That is what left a numeral stranded on the page with no rail behind
       * it.
       */
      const move = (ev: PointerEvent) => {
        if (pinned) return;
        if (!started) {
          if (Math.abs(ev.clientX - sx) < DRAG_THRESHOLD && Math.abs(ev.clientY - sy) < DRAG_THRESHOLD) return;
          started = true;
          const box = el.getBoundingClientRect();
          const ghost = el.cloneNode(true) as HTMLElement;
          ghost.className = "pin-key pin-key--ghost";
          ghost.removeAttribute("data-no");
          ghost.dataset.on = "true";
          ghost.setAttribute("aria-hidden", "true");
          ghost.style.width = `${box.width}px`;
          ghost.style.height = `${box.height}px`;
          ghost.style.maxWidth = "none";
          overlayEl().appendChild(ghost);
          el.dataset.dragging = "true";
          drag.current = {
            kind: "key",
            version: o,
            from: railId,
            ghost,
            dx: ev.clientX - box.left,
            dy: ev.clientY - box.top,
            slotIn: null,
          };
        }
        const d = drag.current;
        if (!d || d.kind !== "key") return;
        d.ghost.style.left = `${ev.clientX - d.dx}px`;
        d.ghost.style.top = `${ev.clientY - d.dy}px`;
        const over = railUnder(ev);
        const target = over && over.dataset.rail !== d.from ? over : null;
        if (target !== d.slotIn) {
          d.slotIn = target;
          if (target) openSlots(target, [o]);
          else clearSlots();
        }
      };
      const done = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      };
      const up = (ev: PointerEvent) => {
        done();
        if (!started) {
          /* A click, not a carry: the rail changes what it shows. */
          if (railId === "main") restore(o.no);
          else {
            const next = captures.map((cap) =>
              cap.id === railId ? { ...cap, current: o.no } : cap,
            );
            saveCaptures(next);
          }
          return;
        }
        const d = drag.current;
        drag.current = null;
        if (!d || d.kind !== "key") {
          sweepGhosts();
          return;
        }
        d.ghost.remove();
        const over = railUnder(ev);
        sweepGhosts();
        const to = over ? (over.dataset.rail as RailId) : null;
        if (to === d.from) return;
        if (to) moveKey(o, d.from, to);
        else layDown(o, d.from, ev.clientX - d.dx, ev.clientY - d.dy);
      };
      /*
       * Cancel is the browser taking the gesture away — a scroll claiming
       * it, the window losing focus. Nothing was decided, so nothing is
       * committed: the key goes back where it came from.
       */
      const cancel = () => {
        done();
        drag.current = null;
        sweepGhosts();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
    [busy, mainKeys, captures, restore, saveCaptures, moveKey, layDown, openSlots, clearSlots, sweepGhosts],
  );

  /*
   * Carrying a rail rather than a key. Dropped on another rail the two
   * combine; dropped anywhere else the rail simply moves. The primary can
   * never be absorbed, so dragging it onto a secondary reverses the merge
   * and brings that capture home instead — the gesture always resolves
   * toward the rail that cannot disappear.
   */
  const railDown = useCallback(
    (e: React.PointerEvent, railId: RailId, capture: Capture | null) => {
      if (e.button !== 0 || busy) return;
      e.preventDefault();
      e.stopPropagation();
      const railEl =
        railId === "main"
          ? mainRailRef.current
          : ((root().querySelector?.(`.pin-versions[data-rail="${railId}"]`) as HTMLElement | null) ?? null);
      if (!railEl) return;
      const box = railEl.getBoundingClientRect();
      const cargo =
        railId === "main"
          ? mainKeys
          : sortByNo((capture?.keys ?? []).map((k) => versions.find((v) => v.no === k)!).filter(Boolean));

      /*
       * The thing being carried travels under the cursor, so it is the first
       * thing elementFromPoint finds — and the rail you are aiming at is
       * never seen. Made transparent to hit-testing for the length of the
       * drag, the way the key's ghost already is.
       */
      const restorePointer = railEl.style.pointerEvents;
      railEl.style.pointerEvents = "none";
      railEl.dataset.dragging = "true";

      const d: DragRail = {
        kind: "rail",
        from: railId,
        carrying: cargo,
        el: railEl,
        restorePointer,
        dx: e.clientX - box.left,
        dy: e.clientY - box.top,
        moved: false,
        at: null,
        slotIn: null,
      };
      drag.current = d;

      const move = (ev: PointerEvent) => {
        d.moved = true;
        const over = railUnder(ev);
        const target = over && over.dataset.rail !== railId ? over : null;
        /* One placeholder per key on its way in, each in its own seat. */
        if (target !== d.slotIn) {
          d.slotIn = target;
          if (target) openSlots(target, cargo);
          else clearSlots();
        }
        /* The rail moves on its own. It is not welded to its card. */
        d.at = { x: ev.clientX - d.dx, y: ev.clientY - d.dy };
        railEl.style.left = `${d.at.x}px`;
        railEl.style.top = `${d.at.y}px`;
        railEl.dataset.placed = "moved";
        if (railId === "main") {
          setRailDragPos(d.at);
        }
      };
      const finish = (ev: PointerEvent, commit: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancelled);
        /* Read the drop while the carried rail is still transparent.
           Restoring first put it back under the cursor and it answered for
           itself. */
        const over = commit && d.moved ? railUnder(ev) : null;
        railEl.style.pointerEvents = d.restorePointer;
        railEl.dataset.dragging = "false";
        drag.current = null;
        clearSlots();

        if (!commit || !d.moved) return;
        const to = over ? (over.dataset.rail as RailId) : null;
        if (to && to !== railId) {
          /* A merge — position never changes hands, only keys do. */
          if (railId === "main") absorb(to, "main");
          else absorb(railId, to);
          if (railId === "main") setRailDragPos(null);
          return;
        }
        /* A move. The main rail's seat persists on the pin; a capture's on
           the board. */
        if (railId === "main") {
          setRailDragPos(null);
          if (d.at) {
            void send("pin/update", { pinId: pin.id, patch: { railPos: d.at } }).catch(() => {});
          }
        } else if (capture && d.at) {
          saveCaptures(
            captures.map((cap) => (cap.id === capture.id ? { ...cap, railPos: d.at } : cap)),
          );
        }
      };
      const up = (ev: PointerEvent) => finish(ev, true);
      const cancelled = (ev: PointerEvent) => finish(ev, false);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancelled);
    },
    [busy, mainKeys, versions, captures, absorb, saveCaptures, openSlots, clearSlots, pin.id],
  );

  /* The card only ever moves the capture. Dropping one next to another can
     never swallow it, because merging is the rail's gesture, not the card's. */
  const captureDown = useCallback(
    (e: React.PointerEvent, capture: Capture, wrap: HTMLElement) => {
      if (e.button !== 0) return;
      const target = e.target as Element;
      if (target.closest(".pin-key, .pin-versions")) return;
      e.preventDefault();
      e.stopPropagation();
      const railEl =
        (root().querySelector?.(`.pin-versions[data-rail="${capture.id}"]`) as HTMLElement | null) ??
        null;
      const d: DragCapture = {
        kind: "capture",
        capture,
        wrap,
        railEl,
        dx: e.clientX - capture.pos.x,
        dy: e.clientY - capture.pos.y,
        pos: capture.pos,
        railPos: capture.railPos,
      };
      drag.current = d;
      wrap.dataset.moving = "true";

      const move = (ev: PointerEvent) => {
        const was = d.pos;
        d.pos = { x: Math.max(4, ev.clientX - d.dx), y: Math.max(4, ev.clientY - d.dy) };
        wrap.style.left = `${d.pos.x}px`;
        wrap.style.top = `${d.pos.y}px`;
        /*
         * The rail goes where the card goes. One that is still auto-seated
         * finds its own way there, and one that was placed by hand keeps the
         * offset it was given — either way the pair travels together,
         * because a version and the key that names it are one object.
         */
        if (d.railPos) {
          d.railPos = {
            x: d.railPos.x + (d.pos.x - was.x),
            y: d.railPos.y + (d.pos.y - was.y),
          };
          if (d.railEl) {
            d.railEl.style.left = `${d.railPos.x}px`;
            d.railEl.style.top = `${d.railPos.y}px`;
          }
        } else if (d.railEl) {
          const seat = seatRail(
            { width: d.railEl.offsetWidth, height: d.railEl.offsetHeight },
            { x: d.pos.x, y: d.pos.y, width: wrap.offsetWidth, height: wrap.offsetHeight },
            null,
            null,
            { width: window.innerWidth, height: window.innerHeight },
          );
          d.railEl.style.left = `${seat.x}px`;
          d.railEl.style.top = `${seat.y}px`;
          d.railEl.dataset.placed = seat.placed;
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        wrap.dataset.moving = "false";
        drag.current = null;
        saveCaptures(
          captures.map((cap) =>
            cap.id === capture.id ? { ...cap, pos: d.pos, railPos: d.railPos } : cap,
          ),
        );
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [captures, saveCaptures],
  );

  /* ------------------------------------------------------------ keyboard */

  useEffect(() => {
    if (!showMain) {
      setArmed(false);
      return;
    }
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt") setArmed(true);
      /*
       * By code, not key: on a Mac ⌥2 types "™", and only the physical code
       * still says which numeral was pressed. Synthetic drivers (tests,
       * automation) send no code at all, so a bare digit key stands in then.
       */
      const digit =
        /^Digit([1-9])$/.exec(e.code)?.[1] ??
        (e.code === "" && /^[1-9]$/.test(e.key) ? e.key : null);
      if (e.altKey && digit) {
        const want = Number(digit);
        const hit = versions.find((v) => v.no === want);
        if (!hit || busy) return;
        e.preventDefault();
        e.stopPropagation();
        /*
         * No focus to track. Each numeral lives in exactly one rail, so the
         * number already says which rail answers. The partition is the
         * disambiguation, which is why every rail can stay live at once.
         */
        const home = homeOf(hit.no);
        if (home === "main") restore(hit.no);
        else {
          saveCaptures(
            captures.map((cap) => (cap.id === home ? { ...cap, current: hit.no } : cap)),
          );
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt") setArmed(false);
    };
    const blur = () => setArmed(false);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, [showMain, versions, busy, homeOf, restore, captures, saveCaptures]);

  /* ------------------------------------------------- arrival choreography */

  /*
   * A fresh key stays collapsed while its chat row flashes Done and the
   * copy flies over — the rail must not already show what is still in the
   * air. The dialog's flight ends by dispatching pin:key-landed; the timer
   * is the backstop for a flight that never happens (dialog closed).
   */
  useEffect(() => {
    const fresh = versions.filter(
      (v) => v.messageId !== null && !seenVersions.current.has(`${v.no}:${v.messageId}`),
    );
    versions.forEach((v) => seenVersions.current.add(`${v.no}:${v.messageId}`));
    if (fresh.length === 0) return;
    const newest = fresh[fresh.length - 1];
    /* Only choreograph a key minted moments ago — a board loaded cold shows
       its keys settled, not arriving. */
    if (Date.now() - Date.parse(newest.at) > 10_000) return;
    setEnteringNo(newest.no);
    const timer = window.setTimeout(() => setEnteringNo(null), ENTER_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [versions]);

  useEffect(() => {
    const node = layerRef.current?.getRootNode();
    if (!node) return;
    const landed = () => setEnteringNo(null);
    node.addEventListener("pin:key-landed", landed);
    return () => node.removeEventListener("pin:key-landed", landed);
  }, []);

  /* --------------------------------------------------------------- shots */

  /*
   * Photograph the state the element is wearing right now, once, when its
   * version lacks a picture. Delayed so the dev server's reload lands
   * first; masked so our own chrome does not photobomb the capture.
   */
  useEffect(() => {
    if (!visible || !liveRect || document.visibilityState !== "visible") return;
    const current = versions.find((v) => v.no === pin.currentVersionNo);
    if (!current || current.screenshotKey !== null) return;
    const tag = `${pin.id}:${current.no}:${current.messageId}`;
    if (shotTried.current.has(tag)) return;
    shotTried.current.add(tag);
    const timer = window.setTimeout(() => {
      const live = liveRect;
      const rect = { x: live.x, y: live.y, width: live.width, height: live.height };
      void send("version/shot", {
        pinId: pin.id,
        no: current.no,
        rect,
        devicePixelRatio: window.devicePixelRatio,
      }).catch(() => {});
    }, 700);
    return () => window.clearTimeout(timer);
  }, [visible, liveRect, versions, pin.currentVersionNo, pin.id]);

  /* ----------------------------------------------------------- placement */

  const [mainSeat, setMainSeat] = useState<{ x: number; y: number; placed: string } | null>(null);

  useLayoutEffect(() => {
    if (!showMain || !liveRect) {
      onScoot(0);
      return;
    }
    const railEl = mainRailRef.current;
    if (!railEl) return;
    const manual = railDragPos ?? pin.railPos;
    const noteEl = root().querySelector?.(".pin-live-note") as HTMLElement | null;
    const noteBox = noteEl?.getBoundingClientRect() ?? null;
    const card: RailBox = {
      x: liveRect.x,
      y: liveRect.y,
      width: liveRect.width,
      height: liveRect.height,
    };
    const seat = seatRail(
      { width: railEl.offsetWidth || 140, height: railEl.offsetHeight || 27 },
      card,
      noteBox
        ? { x: noteBox.x, y: noteBox.y, width: noteBox.width, height: noteBox.height }
        : null,
      manual,
      { width: window.innerWidth, height: window.innerHeight },
    );
    setMainSeat((prev) =>
      prev && prev.x === seat.x && prev.y === seat.y && prev.placed === seat.placed ? prev : seat,
    );
    /* The composer steps down only for the rail that overhangs it. */
    if (noteBox) {
      const railBox: RailBox = {
        x: seat.x,
        y: seat.y,
        width: railEl.offsetWidth || 140,
        height: railEl.offsetHeight || 27,
      };
      onScoot(
        composerScoot(railBox, card, {
          x: noteBox.x,
          y: noteBox.y,
          width: noteBox.width,
          height: noteBox.height,
        }),
      );
    } else {
      onScoot(0);
    }
  }, [showMain, liveRect, railDragPos, pin.railPos, mainKeys.length, enteringNo, onScoot, scoot]);

  useEffect(() => {
    if (!showMain) onScoot(0);
  }, [showMain, onScoot]);

  /* ------------------------------------------------------------- render */

  if (!visible || !versionsOk || versions.length < 2) return null;

  const lit = pin.currentVersionNo;

  const renderKeys = (keys: PinVersion[], railId: RailId, litNo: number | null) =>
    keys.map((o) => (
      <button
        key={o.no}
        type="button"
        className="pin-key"
        data-no={o.no}
        data-on={litNo === o.no ? "true" : "false"}
        data-entering={railId === "main" && enteringNo === o.no ? "true" : undefined}
        style={railId === "main" && enteringNo === o.no ? { visibility: "hidden" } : undefined}
        aria-pressed={litNo === o.no}
        aria-label={`Version ${o.no}, ${o.label}`}
        onPointerDown={(e) => keyDown(e, o, railId, e.currentTarget)}
      >
        <span className="pin-key__num">{o.no}</span>
        <span className="pin-tip">{o.label}</span>
      </button>
    ));

  const grip = (railId: RailId, capture: Capture | null) => (
    <span
      className="pin-versions__grip"
      title={railId === "main" ? "Drag to move the rail" : "Drag to move this version"}
      onPointerDown={(e) => railDown(e, railId, capture)}
    >
      <GripIcon size={15} />
    </span>
  );

  return (
    <div ref={layerRef} style={{ display: "contents" }}>
      {showMain && (
        <div
          ref={mainRailRef}
          className="pin-versions"
          data-rail="main"
          data-armed={armed ? "true" : "false"}
          data-busy={busy ? "true" : "false"}
          data-placed={mainSeat?.placed ?? "card-right"}
          role="group"
          aria-label="Versions"
          style={{
            left: mainSeat?.x ?? -9999,
            top: mainSeat?.y ?? -9999,
          }}
        >
          {grip("main", null)}
          <span className="pin-versions__mod" title="hold ⌥ and press a number to jump">
            ⌥
          </span>
          {renderKeys(mainKeys, "main", lit)}
        </div>
      )}
      {visible &&
        versionsOk &&
        captures.map((cap) => (
          <CaptureCard
            key={cap.id}
            capture={cap}
            pin={pin}
            versions={versions}
            armed={armed}
            grip={grip}
            renderKeys={renderKeys}
            onPointerDown={captureDown}
          />
        ))}
    </div>
  );
}

/* ----------------------------------------------------------- the capture */

/**
 * A version set down beside the component.
 *
 * No identity plate and no composer: it sits next to the thing it came from,
 * so its name would only repeat what you can already see. The rail under it
 * is the whole of what it needs to say — which is also what distinguishes it
 * at a glance from the live component.
 */
function CaptureCard({
  capture,
  pin,
  versions,
  armed,
  grip,
  renderKeys,
  onPointerDown,
}: {
  capture: Capture;
  pin: Pin;
  versions: PinVersion[];
  armed: boolean;
  grip: (railId: string, capture: Capture) => React.ReactNode;
  renderKeys: (keys: PinVersion[], railId: string, litNo: number | null) => React.ReactNode;
  onPointerDown: (e: React.PointerEvent, capture: Capture, wrap: HTMLElement) => void;
}) {
  const shown = versions.find((v) => v.no === capture.current) ?? null;
  const src = useVersionShot(pin.id, shown);
  const wrapRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [seat, setSeat] = useState<{ x: number; y: number; placed: string } | null>(null);

  const keys = sortByNo(
    capture.keys
      .map((k) => versions.find((v) => v.no === k))
      .filter((v): v is PinVersion => v !== undefined),
  );

  /* Seated by the same routine as the main rail, from its own card. */
  useLayoutEffect(() => {
    const railEl = railRef.current;
    const wrap = wrapRef.current;
    if (!railEl || !wrap) return;
    const box = wrap.getBoundingClientRect();
    const placed = seatRail(
      { width: railEl.offsetWidth || 100, height: railEl.offsetHeight || 27 },
      { x: box.x, y: box.y, width: box.width, height: box.height },
      null,
      capture.railPos,
      { width: window.innerWidth, height: window.innerHeight },
    );
    setSeat((prev) =>
      prev && prev.x === placed.x && prev.y === placed.y ? prev : placed,
    );
  }, [capture.pos.x, capture.pos.y, capture.railPos, keys.length, src]);

  /*
   * Life size, like the pin card: the stored PNG is device pixels, the
   * element was CSS pixels, and the capture should be the size of the thing
   * it pictures.
   */
  const width = pin.elementSize?.width || undefined;
  const radius = pin.computedStyles?.["border-radius"];

  return (
    <>
      <div
        ref={wrapRef}
        className="pin-capture"
        data-cap={capture.id}
        style={{ left: capture.pos.x, top: capture.pos.y }}
        onPointerDown={(e) => wrapRef.current && onPointerDown(e, capture, wrapRef.current)}
      >
        {src ? (
          <img
            src={src}
            alt={shown ? `Version ${shown.no}, ${shown.label}` : "A set-down version"}
            style={{ width, borderRadius: radius, display: "block" }}
            draggable={false}
          />
        ) : (
          <div
            className="pin-capture__blank"
            style={{ width: width ?? 200, height: pin.elementSize?.height || 120, borderRadius: radius }}
          />
        )}
      </div>
      <div
        ref={railRef}
        className="pin-versions pin-versions--own"
        data-rail={capture.id}
        data-armed={armed ? "true" : "false"}
        data-placed={seat?.placed ?? "card-right"}
        role="group"
        aria-label="Versions set down beside the component"
        style={{ left: seat?.x ?? -9999, top: seat?.y ?? -9999 }}
      >
        {grip(capture.id, capture)}
        <span className="pin-versions__mod" title="hold ⌥ and press a number to jump">
          ⌥
        </span>
        {renderKeys(keys, capture.id, capture.current)}
      </div>
    </>
  );
}
