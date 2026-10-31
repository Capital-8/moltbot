// Throughput regression check over a direct loopback path (needs a release build). Opt-in with
// IROH_NODE_BENCH=1. The floor is deliberately far below fsn1 numbers (~400-480 MB/s per stream) so
// slow CI runners pass, yet far above the per-byte marshalling cap (~10 MB/s) that this binding
// exists to remove.
//   IROH_NODE_MIN_MBPS   download floor, MB/s (default 100)
"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { measure } = require("./support/measure.cjs");

const MIN_MBPS = Number(process.env.IROH_NODE_MIN_MBPS || 100);

test(
  "download throughput stays above the floor",
  { skip: process.env.IROH_NODE_BENCH === "1" ? false : "set IROH_NODE_BENCH=1" },
  async () => {
    const summary = await measure({
      cases: [
        { test: "down", mb: 256 },
        { test: "streams8", mb: 512 },
      ],
      n: 3,
    });
    for (const [k, v] of Object.entries(summary)) {
      console.log(
        `${k}: ${v.mbps.median.toFixed(0)} MB/s, peak RSS ${v.maxRssMB.max.toFixed(0)} MB`,
      );
    }
    assert.ok(summary["down:256"].mbps.median >= MIN_MBPS, "single-stream download MB/s");
    assert.ok(summary["streams8:512"].mbps.median >= MIN_MBPS, "8-stream download MB/s");
  },
);
