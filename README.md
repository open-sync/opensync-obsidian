# OpenSync for Obsidian

End-to-end encrypted sync for your Obsidian vault.

**The plugin is called OpenSync**, and the manifest keeps that name: Obsidian's
community guidance discourages putting "Obsidian" in a plugin's name or id, and
the id is permanent once a plugin is listed. "OpenSync for Obsidian" is what the
product is called everywhere a person reads prose — this file, the site, the
listing description — which is the half that does the work anyway.

## What is free, and what is not

| | Free | Supporter |
|---|---|---|
| Notes, canvases, Bases, Excalidraw, CSV, SVG — what a vault is *written* in | ✅ unlimited | ✅ unlimited |
| Images, PDFs, audio, video — what a vault *accumulates* | on the device they are on | ✅ synced |
| Devices, pairing, rotation, recovery kit, conflict handling | ✅ | ✅ |
| **A relay you run yourself** | ✅ **everything unlocked** | — |

The last row is the point. What is being sold is *not running a server*, so a
device pointed at somebody's own relay is not metered at all: its storage is
already theirs, and charging for it would be charging for the one thing we are
not doing. The plan only ever applies to the relay we pay for.

Attachments are the only part of a vault that costs real money to keep — a
504-note vault measures 4.7 MB on a relay, database included — which is why
they are the line, and why the line is drawn by file type on the client and by
bytes on the server. The relay cannot see a file type at all: filenames live
inside the sealed manifest and every blob is ciphertext.

## The engine is a separate repository

This plugin is built on **OpenSync**, an end-to-end encrypted sync engine that
lives in its own repository, checked out **beside** this one, not inside it:

```text
.
├── opensync/            the engine
└── opensync-obsidian/   this repository
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

## The hosted relay

The plugin ships pointing at `wss://relay.opensync.network/`, and a build can
name a different one — or none:

```sh
npm run build                                                  # the hosted relay
OPENSYNC_HOSTED_RELAY=wss://relay.example.net/ npm run build   # somebody else's
OPENSYNC_HOSTED_RELAY= npm run build                           # none
```

With a relay named, a fresh install already has the address and its blob
endpoint filled in, and the plan applies. With it empty the desktop default is
a relay on this machine, the mobile default is nothing, and no device is
metered, because every user is running their own.

The hosted relay **serves only accounts its operator has admitted**, so a fresh
install that has not asked for access gets a refusal rather than a sync. That
is a sentence the plugin shows — "this relay does not serve your account" — not
a connection error, because the two need different answers.

`npm run check:hosted` tests that path without a domain or a certificate
authority: it stands TLS in front of the relay with a self-signed certificate,
maps the hostname inside Obsidian's own resolver, and drives a real pairing and
sync over `wss://` and `https://`. It is the only check that exercises TLS at
all.

**Name the relay for what it is, not for which one it is.** A device keeps the
address that worked, so the hostname in a build is effectively permanent for
every install made from it — a `relay01` would bake today's topology into
installs that can never be told otherwise. `relay.opensync.network` is one
stable name with whatever you like behind it, which is the version that lets
you move.

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

Four of the things this repository does differently were found by running it:

- **Rotation reported into a box its own re-render emptied.** The pane
  rebuilds at the end so the new key appears in its field, and that erased
  "published 3 files", "swept 4 blobs" and "pair your devices again" a
  millisecond after they were written — on the one operation here that cannot
  be undone. The report is now handed to the next render instead.
- **A conflict copy said `from This device`.** Both devices shipped the same
  default label, so both sides of a fork were named the same thing. The
  default is now the vault's own name.
- **And then it named the wrong device.** The copy holds the *incoming*
  version — the local side keeps the path — but the only device name a
  merging device knows is its own, so every copy was labelled with the machine
  the reader was already sitting at. Fixed in the engine rather than here: a
  manifest now carries the name of the device that published it, sealed with
  everything else, and the copy is named from that. A manifest that names no
  device produces `from another device`, which is vague and true, rather than
  a name that is specific and wrong.
- **A conflict copy made this morning was dated yesterday.** `toISOString` is
  UTC, and this date goes in a filename someone reads to work out which of two
  files is newer. It is now the date on this device's own clock.

## Screenshots

```sh
npm run shots          # docs/screenshots, plus the log and the numbers
```

`checks/capture.mjs` photographs thirteen states of the running app — the same
harness, driven to each state and asked to hold still. It also writes what it
measured (`capture.json`) and, at the end, searches the relay's own storage for
words from the notes, the vault paths, and a token generated for that run: a
relay holding plaintext would be holding that exact string.

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
