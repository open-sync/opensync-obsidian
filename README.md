# OpenObsidian

Free, end-to-end encrypted sync for Obsidian vaults. Unlimited markdown, no
subscription, and you can point it at a relay you run yourself.

## The engine is a separate repository

This product is built on **OpenSync**, an end-to-end encrypted sync engine
that lives in `openapps/opensync` — checked out **beside** this repository,
not inside it:

```text
openapps/
├── opensync/       the engine
└── openobsidian/   this repository
```

Every path into it is relative, so both have to be present to build. That is
deliberate, and the alternative was worse: a copy of the engine per product
drifts silently, and a disagreement between two copies of a wire format does
not present as a compile error — it presents as lost data.

## Build

```sh
npm install
npm run build          # compiles the wasm core, then bundles src/ into main.js
npm run typecheck
```

`main.js` is the built plugin and is not in version control. To try it, copy
`main.js`, `manifest.json` and `styles.css` into
`<your vault>/.obsidian/plugins/opensync/`, then enable OpenSync under
Settings → Community plugins.

## Verify

```sh
cargo build --release -p opensync-relay --manifest-path ../opensync/Cargo.toml
npm run build
npm run check:obsidian
```

`checks/obsidiancheck.mjs` drives **the real application**: it starts a relay
on a port the OS hands out, builds two vaults with this plugin installed,
launches two isolated copies of Obsidian, and works the settings pane the way
a person does — press the button, read what the screen says. It never touches
the Obsidian you use; each copy gets its own `--user-data-dir`, so running it
while yours is open is fine.

Everything else about this product is proved by a test that stands in for the
application. `opensync/checks/plugincheck.ts` mirrors `runSync()` line for
line against a real relay, and the Rust suite proves the protocol underneath
it. What none of them can say is whether Obsidian loads the plugin, whether
the settings pane renders, whether a QR appears on a canvas, or whether the
vault API writes a file where the manifest says it goes.

Two of the things this repository does differently were found by running it:

- **Rotation reported into a box its own re-render emptied.** The pane
  rebuilds at the end so the new key appears in its field, and that erased
  "published 3 files", "swept 4 blobs" and "pair your devices again" a
  millisecond after they were written — on the one operation here that cannot
  be undone. The report is now handed to the next render instead.
- **A conflict copy said `from This device`.** Both devices shipped the same
  default label, so both sides of a fork were named the same thing. The
  default is now the vault's own name.

## What is covered

Loading in Obsidian, the settings pane, generating keys, publishing a vault,
pairing over a ten-character code and over a pasted `opensync://pair…` line,
the QR that carries it, reading a note written before this device had any
keys, edits, binary attachments, deletes, a genuine fork resolving to a
conflict copy with neither side lost, repeat syncs being inert, the recovery
kit rendering and parsing back, the pointer and merge base surviving a
restart, and a rotation: two presses, a re-sealed vault, a swept relay, a
locked-out device that loses nothing, and re-pairing it afterwards.

## License

Dual-licensed under MIT or Apache-2.0, at your option.
