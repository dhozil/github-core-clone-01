# Node 26 pod-runtime pass (2026-11-20)

Runtime: portable Node v26.13.1. Constrained grader launched with ProcessorAffinity=3, inherited by children.

Measured HEAD baseline: push 197.722, clone 78.081, read 618.379, write 84.625 ms (total 978.807); score 997, p50_us 168593.
Kept changes: push 188.022, clone 87.516, read 589.755, write 81.398 ms (total 946.691); score 995, p50_us 167647. All 120 checks passed.
Unconstrained: score 1000, p50_us 133914 (misses 132000 budget). These differences are not evidence of a repeatable speed improvement.

CPU profile: ran sdk/conformance runBenchmark workloads=['push'] under node --cpu-prof. Largest active sampled function was processChunkSync (42 samples), followed by socket writes; no evidence for duplicate object hashing or pkt decoder concat chains. Profile and grader artifacts kept outside checkout in ../profbench and ../node26-*.

Experiments reverted: single-allocation pkt framing and direct data-event repeat response; combined trial total 1047.246 ms and score 994, no repeatable gain.
Kept diagnostic counters: readFrameStats, exported from app.ts. Standalone official read workload: 6002 repeat hits, 2 parsed hits, 1 frame build. Repeat hits precede parsing and authentication and inherit a validated byte-identical request, checking repo version before socket.write.

Empty-repo advertisement: omit unresolved HEAD and include service-header flush before capabilities^{}. Non-empty advertisement unchanged. Real git init/commit/push to fresh HTTP repo succeeds; all 120 grader checks remain green.

Push-pair benchtest: p50 0.754 ms, CPU-NOW user 203 + sys 93 = 296 ms (CPU budget missed).
