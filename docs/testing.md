# Testing on real devices

How to get a build onto a Mac, an iPad and an Android phone, and what to try
once it is there. Written for a tailnet, because that solves the two hard parts
at once: reaching a relay from a phone, and reaching it over TLS.

**There is no app to download.** This is a plugin. Obsidian comes from the App
Store or Play Store; the plugin is three files in the vault. Everything below
is about getting those three files onto three devices with the least fuss.

---

## The short version

On the Mac:

```sh
# 1. a relay, on loopback — Tailscale will be what faces the other devices
opensync-relay ~/opensync-test/relay.toml

# 2. build, package and serve the plugin plus the instructions
node scripts/serve-for-devices.mjs

# 3. put both in front of the tailnet, once, with real certificates
tailscale serve --bg --https=8444 http://127.0.0.1:4849   # the page
tailscale serve --bg --https=8443 http://127.0.0.1:4848   # the relay
```

Then open `https://<your-machine>.<tailnet>.ts.net:8444/` on any device signed
into the tailnet. That page has the download and the per-device steps, and it
is the thing to read while holding the iPad.

To take it down afterwards: `tailscale serve --https=8444 off` (and `8443`).

## Why a tailnet rather than a LAN address

Mobile Obsidian runs in a webview served from a secure origin, so it will
refuse a plain `ws://` relay the way a browser refuses mixed content. That
leaves three options: buy a domain and run certbot, use a self-signed
certificate and fight every device about trusting it, or let Tailscale issue a
real certificate for a name it already controls.

The third takes one command and is the only one that works the same on iOS and
Android. It also means the relay is not exposed to the internet at all, so
`admission = "anyone"` is defensible while testing — the tailnet is the
perimeter.

## The relay config used for testing

```toml
bind         = "127.0.0.1:4848"
data_dir     = "~/opensync-test/data"
database_url = "sqlite://~/opensync-test/data/relay.db?mode=rwc"

behind_a_reverse_proxy = true      # tailscale serve terminates TLS
admission              = "anyone"  # the tailnet is the perimeter
anyone_may_store_here  = true      # said out loud, because the relay refuses to assume it
```

In production that last pair becomes `admission = "roster"` and accounts are
admitted by hand — see [self-hosting.md](self-hosting.md#4-decide-who-may-store-things).

## What the test build does differently

`scripts/serve-for-devices.mjs` builds with two flags a release never has:

| | Release | Test build |
|---|---|---|
| `OPENSYNC_HOSTED_RELAY` | `wss://relay.opensync.network/` | your machine on the tailnet |
| `OPENSYNC_TEST_BUILD` | unset | `1` — adds a **Plan** control to the settings pane |

The Plan control is the only way to be on both tiers, since the account server
that will decide it does not exist yet. It changes what the device offers to
upload and nothing else: the relay meters bytes either way, which is why a
control like this can exist at all without being a hole.

Because the relay is *the hosted one* as far as this build is concerned, the
free tier behaves exactly as it will in production — attachments are held back
rather than unlocked by self-hosting.

## Installing on each device

The served page has this with screenshots-worth of detail. In short:

| Device | How |
|---|---|
| **Mac** | `curl` the zip, `unzip` into `<vault>/.obsidian/plugins/` |
| **iPad** | Safari → Files → tap the zip to unzip → drag `opensync` into `On My iPad/Obsidian/<vault>/.obsidian/plugins/` |
| **Android** | download → extract → move `opensync` into `<vault>/.obsidian/plugins/`, with hidden files shown |

Then **Settings → Community plugins**, turn off Restricted mode, enable
**OpenSync**.

> Once the repository is public, all three become the same three taps: install
> [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the community
> directory and give it `open-sync/opensync-obsidian`. That is the better path
> and this one exists because the repository is not public yet.

## Pairing the three

Set up the Mac first: **Generate** both keys, print the recovery kit, make a
note, watch the status bar reach *up to date*.

Then on the Mac, **Add a device → Show a code**, and on the iPad scan the QR
with the camera. Repeat for the phone — **one code, one device, one attempt**,
so show a new one each time.

The invitation carries the relay address, which is the half people mistype.

## What to try

The served page carries this as a checklist that remembers its ticks per
device. The ones that matter most, in order:

1. **A note typed on one device reaches the other two.** The base case.
2. **Two devices edit the same note while one is offline.** Both versions must
   survive — one keeps the name, the other becomes a conflict copy named after
   the device whose text is inside it.
3. **On Free, add an image.** It must not sync, and the pane must list it by
   name as held back. Nothing may be deleted anywhere.
4. **Switch to Supporter, sync, switch back to Free.** Nothing may disappear on
   any device at any point in that sequence.
5. **Mismatch the tiers deliberately** — iPad on Supporter, phone on Free. This
   is the case that used to delete files, and it is the reason the manifest now
   declares what it covers.
6. **Aeroplane mode, edit, reconnect.**
7. **Close Obsidian mid-sync and reopen.** No half-written files, no conflict
   copies invented out of nothing.
8. **Leave all three running for a day.** The thing no scripted test can do.

Items 3 to 5 are the tier logic, and they are covered by
`npm run check:tiers` on the desktop — 23 assertions, every one about a file
*not* disappearing. Running them on real devices is checking that mobile
behaves the same, which nothing has yet confirmed.

## What is already known

- **Nothing here has run on a phone before.** The manifest claims mobile
  support and the code has mobile-specific paths; this is the first time they
  execute.
- A rename is a delete and a create, so moving a large folder republishes
  everything in it.
- There is no version history; a superseded note is not kept.
- A sync with no network can sit on "syncing…" until Obsidian is reloaded —
  there is no request timeout yet.

## Reporting what happens

Worth capturing for anything odd: what the status bar said, what the developer
console said (**Ctrl/Cmd+Shift+I** on desktop), which plan each device was on,
and whether the other device was on the same one. The last matters more than it
sounds — several failure modes only appear when two devices disagree about what
they are carrying.
