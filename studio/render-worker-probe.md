# Studio hardware compositor preflight (FL-145)

This executable dependency slice checks the actual prepared Freecut compositor on the
Chromium-selected GPU. It is not yet a render worker and does not call admission or claim work.

On the intended GPU runner, use the pinned Node/npm versions in `engine-build.json`:

```sh
node studio/tools/engine.mjs prepare
npm --prefix studio/engine ci --ignore-scripts --no-audit --no-fund
cd studio/engine
npx --no-install playwright install --with-deps chromium
cd ../..
node studio/tools/render-worker-probe.mjs > hardware-compositor.json
```

The prepared engine's `FREECUT_CHROME_ARGS` / `FREECUT_CHROME_ARGS_REPLACE` settings
select the platform backend; they cannot bypass evidence checks. Provisioning a GPU and
its driver is the runner owner's responsibility. No provider account or enrollment secret is
needed for this probe. The command starts and closes its own loopback source server and
browser. It verifies the prepared source bytes before and after measurement and blocks
external browser requests.

The specimen composites two signed, extended-range half-float pixels with fractional alpha,
then compares real GPU readback with the expected values. Fallback adapters, unknown
fallback status, missing device identity, known software devices, lost devices, validation
errors, mismatched pixels and a timed-out measurement fail with a nonzero exit. A successful
JSON report contains the measured pixels, adapter identity, browser version, timestamps,
source digest and tolerance. It explicitly retains `workerAdmissionReady: false`.

Hosted CPU CI exercises actual SwiftShader rendering and requires the command to refuse
hardware evidence; that is rejection-path evidence only. Unit fixtures do not qualify hardware.
Retain an exact-commit successful report from the intended physical GPU separately.

## Next executable dependency

Implement the Frameleaf adapter around Freecut's `headless/lib/render-core.mjs`: consume
the immutable claim graph/settings, resolve only claim-bound input grants into the engine
workspace, obey heartbeat/cancel/lease loss and resource limits, and stage a real output
through the existing validation/completion protocol. Measure supported encoders/containers
and their output before advertising any capabilities. Only then combine fresh measured
conformance with the actual enrollment/admission API. This probe alone is insufficient to
set `gpuWorker` / `renderWorker`, run production-editor autosave, or close FL-144/FL-145.
