# Frameleaf justified layout

Frozen local implementation based on `@immich/justified-layout-wasm` 0.4.3. Preserve the included AGPL license. The TypeScript wrapper and generated JavaScript with embedded WebAssembly are checked in; app builds require no package download or Rust toolchain.

Corresponding Rust source and build configuration are included from [upstream commit 9d6e06c36fb66ffed6c2e6bc3b89e0754c065505](https://github.com/immich-app/justified-layout/tree/9d6e06c36fb66ffed6c2e6bc3b89e0754c065505). To regenerate the payload, install the pinned Rust toolchain and wasm-pack, then run `bash build.sh`. Frameleaf owns subsequent changes here.
