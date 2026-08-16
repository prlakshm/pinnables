import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceLiveSendState,
  liveSendNeedsPoll,
  pendingLiveSendIds,
  recordableLiveSendState,
} from "../packages/extension/src/lib/live-send.ts";

test("queued is not recordable; everything after it is", () => {
  assert.equal(recordableLiveSendState("queued"), null);
  assert.equal(recordableLiveSendState("starting"), "starting");
  assert.equal(recordableLiveSendState("working"), "working");
  assert.equal(recordableLiveSendState("done"), "done");
  assert.equal(recordableLiveSendState("failed"), "failed");
});

test("done and failed stay terminal against a later Working poll", () => {
  assert.equal(advanceLiveSendState("done", "working"), "done");
  assert.equal(advanceLiveSendState("done", "starting"), "done");
  assert.equal(advanceLiveSendState("failed", "working"), "failed");
  assert.equal(advanceLiveSendState("failed", "done"), "failed");
});

test("a run only moves forward, and can fail from any non-terminal state", () => {
  assert.equal(advanceLiveSendState("queued", "starting"), "starting");
  assert.equal(advanceLiveSendState("starting", "working"), "working");
  assert.equal(advanceLiveSendState("working", "done"), "done");
  assert.equal(advanceLiveSendState("working", "starting"), "working");
  assert.equal(advanceLiveSendState("starting", "failed"), "failed");
  assert.equal(advanceLiveSendState("working", "working"), "working");
});

test("in-flight ids stay listed when a later send starts", () => {
  assert.deepEqual(
    pendingLiveSendIds([
      {
        liveSends: [
          { messageId: "msg-1", state: "working" },
          { messageId: "msg-2", state: "starting" },
          { messageId: "msg-3", state: "done" },
        ],
      },
    ]),
    ["msg-1", "msg-2"],
  );
  assert.equal(liveSendNeedsPoll("working"), true);
  assert.equal(liveSendNeedsPoll("done"), false);
});
