/**
 * Pin screenshots, in the two forms providers ask for.
 *
 * The extension can only hand over binary as a data URL, so that is what
 * arrives. Cursor's API wants those bytes back as base64; the local agents
 * already have the same PNG on disk under ~/.pinnables/live/<messageId>/ and
 * would rather be given the path than re-read a megabyte of base64 through an
 * argv-sized hole. Carrying both costs one string and lets each provider take
 * the cheap route.
 */

import { join } from "node:path";
import type { AgentImage } from "./types.js";

/** Past a handful, screenshots stop informing the edit and start costing. */
export const MAX_IMAGES = 5;

/** Strip the data-URL prefix; the wire format wants raw base64 in `data`. */
export function imageFromDataUrl(dataUrl: string): AgentImage | null {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1] as AgentImage["mimeType"], data: match[2] };
}

/**
 * `dir` is the live-message directory whose PNGs writeLiveArtifacts already
 * wrote. Passing it lets local providers reference files instead of bytes;
 * omitting it just means no provider gets that option.
 */
export function imagesFromScreenshots(
  screenshots: Record<string, string>,
  pinIds: string[],
  dir?: string,
): AgentImage[] {
  const out: AgentImage[] = [];
  for (const pinId of pinIds) {
    if (out.length >= MAX_IMAGES) break;
    const url = screenshots[pinId];
    if (!url) continue;
    const image = imageFromDataUrl(url);
    if (!image) continue;
    out.push(dir ? { ...image, path: join(dir, `${pinId}.png`) } : image);
  }
  return out;
}
