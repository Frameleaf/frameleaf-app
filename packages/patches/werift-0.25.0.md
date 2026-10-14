# werift 0.25.0 inbound reassembly bound

The upstream SCTP receiver advertises a 1 MiB receive window but does not reject
DATA chunks that overrun it. A malicious sender can keep an incomplete message
in memory before the application's 64 KiB message validation runs.

This pinned patch refuses a DATA chunk before allocation when it exceeds the
remaining receive window, has no bytes, or would exceed 4096 outstanding gaps or
reassembly fragments. It closes the association through the existing stop path.
Both the CommonJS implementation and the bundled ESM entry points are patched.
Normal ordered 64 KiB upload frames remain unchanged.

`server/src/utils/asset-upload-direct-sctp.spec.ts` exercises the actual installed
package in overflow cases; real-peer and native publication tests exercise normal
traffic. Remove the patch only after an upstream version enforces and tests these
same inbound bounds. Upstream: <https://github.com/shinyoshiaki/werift-webrtc>.
