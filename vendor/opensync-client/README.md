# Vendored: the OpenSync browser client

**Generated. Do not edit anything in this directory.**

These files are copied verbatim from the engine's `packages/client/src` by
`scripts/vendor-client.mjs`. They are here so that this repository builds on
its own — a reviewer, a CI runner or the community directory's build check
clones one repository and runs `npm run build`, and none of them has the
engine beside them.

`wasm/inline.ts` is the compiled Rust core as base64. Its source is the
`opensync-*` crates in the engine repository; it is not written by hand and
cannot be read usefully here.

To refresh, with the engine checked out beside this repository:

    npm run vendor        # copy again
    npm run vendor:check  # fail if the copy has drifted

`vendor:check` runs in the test suite. Where the engine is absent it passes
quietly, because most clones will never have it.
