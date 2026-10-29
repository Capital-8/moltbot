# Retained-repair regression entrypoints

Run from this controller directory with the repository-supported Node version:

```sh
node --import ./test-environment.mjs --test --test-concurrency=1 \
  retained-repair-composition.test.mjs \
  retained-repair-startup.test.mjs \
  retained-repair-acceptance.test.mjs \
  retained-repair-runtime.test.mjs \
  retained-controller-adoption.test.mjs
```

- **Composition/P1:** real four-file adoption, public build finish/seal/check, canonical transaction/lifecycle through START_INTENT and one-start dispatch. Rejects tampered adoption. Reuses `retained-repair-test-support.mjs`; native service/process IO is synthetic. It never adds a private native-claim entry or changes production source. The pinned installed suspension-contract read is mapped to the exact fixture copy; no procfs namespace/admission override is used.
- **Native suspension contract:** invokes the exact production shell response bridge and lifecycle step with schema-valid READY status (and DRAINING prepare → READY status). Keeps the real PREPARE and STATUS objects distinct, proves exact lease/expiry/deadline retention, and rejects malformed/held/missing custody, fabricated prepare fields, lease drift, Boolean readiness and deadline expiry. Transport/native observations are synthetic; the bridge and pinned validators are real.
- **Startup/P2:** exact current shell functions and SDK classifier with controlled transport, native observation and clock boundaries. Retries only classified startup transport/absent listener within the same absolute deadline and process/RPC identity; drift, unclassified errors, late results and missing process data fail. No native lifecycle authorization is claimed.
- **Acceptance:** exact production registry/checkout functions against real read-only SQLite and filesystem observations, plus the actual terminal-receipt shell function. Keeps original `openclaw`/`roboclaw` RPC, rejects missing/mismatched/failed proof, accepts a dirty project at a non-C commit, and preserves profile/database/workspace bytes. These are focused contract tests, not a substitute for full native lifecycle/model/channel qualification.
- **Runtime/ownership:** real public `gateway-runtime current/check/process` calls against a canonical v2 `REPAIR_STARTED` journal built by production lifecycle transitions, with real flock. Proves default-Node and managed-runtime acceptance, exact admitted executable, strict v2 shape/build/lifecycle/transition evidence, and legacy v1/no-journal behavior. Service/process IO and the upstream native claim receipt are explicitly synthetic; the test does not run or bypass the root/PID1 native claim gate. The legacy rollback-to-`/usr/bin/node` sibling is explicitly skipped where that executable is absent. Frozen-R3 red contrast uses this same test without changing production bytes.
- **Bootstrap/adoption:** repo-relative old-reader fixtures, four-file archive/adoption and crash/replay regression coverage. Root-dependent reader retirement tests require genuine host procfs and are explicitly skipped when that boundary is unavailable; no private `/proc/1/ns/pid` bypass is used. Root/native qualification must run those tests rather than count skips as passes.

All new tests discover production files and reusable fixtures relative to this directory. There are no private scratch paths or frozen-version dependencies. Test files are not part of the deployed four-file closure. Native qualification and real live provider/channel acceptance remain separate gates.
