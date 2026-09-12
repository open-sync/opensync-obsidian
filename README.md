# OpenSync for Obsidian

End-to-end encrypted sync for your Obsidian vault. Your notes are sealed on
your own device before they leave it, so the server stores ciphertext and
cannot read a note, a filename, or a folder. Notes sync free and unlimited.
Attachments are the paid tier — or free forever on a relay you run yourself.

> **Status: not yet in the community plugin directory.** It is verified working
> inside Obsidian 1.13.7 by 91 automated assertions that drive the real
> application, but it has not been reviewed by Obsidian staff and has not been
> tested on a phone. See [Status](#status).

---

## What syncs, and what it costs

| | Free | Supporter | Your own relay |
|---|---|---|---|
| Notes, canvases, Bases, Excalidraw, CSV, SVG — what a vault is *written* in | unlimited | unlimited | unlimited |
| Images, PDFs, audio, video — what a vault *accumulates* | stay on the device they are on | synced | synced |
| Devices, pairing, key rotation, recovery kit, conflict handling | ✅ | ✅ | ✅ |
| Runs against a relay you control | ✅ | ✅ | ✅ |

**Why that line and not another one.** A vault of five hundred notes weighs
about five megabytes. A vault with a year of screenshots in it weighs
gigabytes. Text costs so little to carry that charging for it would be theatre;
attachments are the only part that costs real money to keep, so they are the
part that is paid for.

**Running your own relay unlocks everything, free.** What is being sold is *not
running a server*. If you run one, the storage is already yours and there is
nothing to charge you for — so the plugin stops metering the moment it is
pointed somewhere that is not our relay. That is not an honour system: it reads
the relay's hostname. See [docs/self-hosting.md](docs/self-hosting.md).

The file types the free plan carries are `md`, `canvas`, `base`, `excalidraw`,
`json`, `csv`, `txt`, `svg`, `css`, `yaml`, `yml`, `bib`, `drawio`. An
Excalidraw drawing is a markdown file, so it syncs. **Nothing is ever deleted
by a plan**: a file the plan does not carry simply stays on the device it is
on, and the settings pane lists them by name so you are never guessing.

## Install

**From the community directory** — not yet; see [Status](#status).

**Beta, from this repository.** Install [BRAT][brat], then *Add beta plugin*
and give it `open-sync/opensync-obsidian`.

**By hand.** Download `main.js`, `manifest.json` and `styles.css` from
[the latest release][releases] into
`<your vault>/.obsidian/plugins/opensync/`, then enable **OpenSync** under
Settings → Community plugins.

[brat]: https://github.com/TfTHacker/obsidian42-brat
[releases]: https://github.com/open-sync/opensync-obsidian/releases

## Start syncing

### The first device

1. **Settings → OpenSync.**
2. Press **Generate** beside *Vault key*, then beside *Account key*. The relay
   address is already filled in.
3. Press **Recovery kit → Show it**, and print the page. Do this now rather
   than later — see [If you lose everything](#if-you-lose-everything).

That is the whole setup. The status bar reads *OpenSync: up to date* when the
vault has been published.

### The second device

On the device that already has the account: **Add a device → Show a code.**

You get three ways to carry the same pairing, and they are for different
situations:

- **Scan the QR** — for a phone, which is the worst thing to type on.
- **Copy the `opensync://pair…` line** — for a second computer, which cannot
  point a camera at the first one's screen.
- **Read the ten characters aloud** — for anything else. The relay address has
  to be typed too in that case, which is the half people get wrong.

On the new device, paste or type it into *Join from a code* and press **Join**.

**Your vault key is never shown and never typed.** It travels sealed under a
key derived from those ten characters by a SPAKE2 exchange, so the relay in the
middle carries ciphertext and somebody watching the wire at that exact moment
gets one guess. A code is spent when it is answered — right or wrong — which is
what lets it be short enough to read down a phone line.

## What happens when two devices disagree

Nothing is lost. Ever. That is the one rule everything else bends around.

Two devices that edit the same note produce two files: yours keeps its name,
and the other becomes `note (conflict 2026-09-12 from Laptop).md` — named after
the device whose version is *inside* it, so you can tell which is which before
deciding. A notice tells you it happened.

A deletion never beats an edit. If one device removes a file while another
changes it, the change wins; an unwanted file is a nuisance you fix in a
second, and a lost edit is gone.

## If you lose everything

There is no password reset, because there is no password and we hold no key.
If every device is lost, the only way back into the vault is the **recovery
kit** — a page you print, carrying both keys grouped for typing, each with a
checksum, and bound together by a fingerprint so two pages cannot be mixed into
an account that owns nothing.

Print it. Put it where the passports are. Not in the vault it unlocks, and not
in a photo library that syncs to somebody else's server.

## If a device is lost or stolen

**Rotate the vault key.** It re-seals everything under a new key and sweeps
what the old one addressed, after which anything left on a relay is ciphertext
nobody holds a key for. This is the only real delete a system like this has: a
relay may ignore a deletion request, and anything ever fetched was ever copied.

It costs pairing every device you are keeping, and it always costs that. There
is no announcement, because a notice that reached your devices would reach the
one you are rotating away from.

One warning the pane also gives you: one key covers every namespace on the
account. If the same account also syncs a clipboard or a password store, rotate
those from their own apps first — afterwards nothing can.

## What this plugin reads

**Every file in your vault.** It has to: syncing a vault means knowing what is
in it. The plugin enumerates the vault on each sync, reads the files it is
carrying, and seals them before anything leaves the device. It reads nothing
outside the vault, and on the free plan it reads only the file types listed
above.

**One remote service, and only the one you name.** The relay in *Settings →
OpenSync*, which is `relay.opensync.network` unless you change it. Nothing else
is contacted: no analytics, no update check, no telemetry of any kind. Point it
at your own relay and this plugin talks to nobody else at all.

**An account is needed for the hosted relay**, because a relay that serves
anonymous keys is a free file host. None is needed to use the plugin against
your own.

## What the server knows

| It sees | It does not see |
|---|---|
| that an account connected, and when | any note, ever |
| how many bytes that account stores | any filename or folder name |
| the size and hash of each sealed blob | which files changed, or how many |

Two hashes make that hold. A blob's *address* is the SHA-256 of its
**ciphertext**; the integrity check inside the sealed manifest is a BLAKE3 of
the **plaintext**. Addressing by the plaintext hash would deduplicate across
accounts and hand anyone with a copy of a suspected file a way to ask the
server whether you have it.

More in [docs/security.md](docs/security.md).

## Documentation

- **[Testing on real devices](docs/testing.md)** — getting a build onto a Mac,
  an iPad and a phone over a tailnet, and what to try once it is there.
- **[Running your own relay](docs/self-hosting.md)** — the long version:
  build, TLS, admission, backups, and pointing the plugin at it.
- **[Troubleshooting](docs/troubleshooting.md)** — what each failure actually
  means, including the ones that look like something else.
- **[Security model](docs/security.md)** — what is protected, what is not, and
  the decisions behind both.

## Status

Verified inside **Obsidian 1.13.7** on macOS by 91 automated assertions that
drive two real copies of the application over the remote debugger — pairing,
rotation, the recovery kit, conflict handling, 504 files published in 2.8 s and
fetched in 1.5 s, and zero plaintext in the relay's own storage.

Not yet done, and honest about it:

- **Not tested on a phone.** The manifest claims mobile support and the code
  has mobile-specific paths, but nothing has run there yet.
- **Not reviewed by Obsidian staff**, and not in the community directory.
- **No version history.** A superseded version of a note is not kept.
- **A rename is a delete and a create**, so moving a large folder republishes
  everything in it. Correct, and expensive.
- **The merge is whole-file.** Two people editing different paragraphs of one
  note produce a conflict copy, not a merged note.

## Building from source

```sh
git clone https://github.com/open-sync/opensync-obsidian.git
cd opensync-obsidian
npm install
npm run build
npm run typecheck
```

That is the whole thing — one repository, no toolchain beyond Node. The
build is reproducible: a clean checkout produces a `main.js` byte-identical
to the one attached to the release.

The plugin is built on **OpenSync**, an end-to-end encrypted sync engine that
lives in its own repository. Its browser client is **vendored** here, under
[`vendor/opensync-client/`](vendor/opensync-client/), copied verbatim by
`npm run vendor`. That copy is why this repository builds alone, and
`npm run vendor:check` — which the test suite runs — fails if it has drifted
from the engine.

`vendor/opensync-client/wasm/inline.ts` is the compiled Rust core as base64.
It is generated, not written, and its source is the `opensync-*` crates in the
engine repository. To rebuild it you need the engine checked out beside this
repository and a Rust toolchain:

```sh
npm run wasm         # recompile the core to wasm, then re-vendor
```

`main.js` is the built plugin and is not in version control. To build one that
points at your own relay, or at none:

```sh
OPENSYNC_HOSTED_RELAY=wss://relay.example.net/ npm run build
OPENSYNC_HOSTED_RELAY= npm run build
```

### Running the checks

```sh
cargo build --release -p opensync-relay --manifest-path ../opensync/Cargo.toml
npm run check:all
```

Three suites, all of which drive the real application rather than standing in
for it. Each starts its own relay on a port the OS hands out, builds vaults
under a temporary directory, and gives each Obsidian its own
`--user-data-dir` — so they never touch the Obsidian you use, and running them
while it is open is fine.

| Check | What it covers |
|---|---|
| `check:obsidian` | loading, the settings pane, pairing, edits, attachments, deletes, conflicts, restart persistence, rotation |
| `check:tiers` | the free and paid plans, and every path where one could delete the other's files |
| `check:hosted` | the shipping default over real TLS, with the hostname mapped inside the browser |

## License

MIT. See [LICENSE](LICENSE).

The engine this is built on is dual-licensed under MIT or Apache-2.0; MIT is
the option taken here, so the two agree.
