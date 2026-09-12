# Running your own relay

This is the long version. It ends with a relay on your own machine, reachable
from your phone, that the plugin points at — and with attachments syncing,
because a relay of your own is not metered by anyone.

Budget forty minutes the first time. Most of it is TLS.

---

## What you are actually running

One binary. It speaks two protocols on one port:

- a **small subset of Nostr** over WebSocket, which carries a ~250-byte pointer
  saying where your vault's current manifest lives, and
- **Blossom** over HTTP, which stores and serves the sealed blobs themselves.

It keeps one SQLite file and a directory of blobs. It never sees a filename, a
note, or a key — the manifest is encrypted and every blob is ciphertext
addressed by the hash of its own ciphertext. What it *can* see is how many
bytes an account stores and when it connected.

It is not a general Nostr relay. It refuses every event kind except the seven
it needs, which is what keeps it from becoming a free host for the whole
network at your expense.

---

## 1. Build it

The relay lives in the engine repository, beside this one:

```sh
git clone https://github.com/open-sync/opensync.git
cd opensync
cargo build --release -p opensync-relay
```

The binary is `target/release/opensync-relay`. It is self-contained; copy it
wherever you like.

```sh
./target/release/opensync-relay --help
```

## 2. Write a config

The relay runs with no config at all, on loopback, with defaults suited to a
machine you are sitting at. For anything with a hostname you want a file.

```toml
# relay.toml
bind         = "127.0.0.1:4848"
data_dir     = "/var/lib/opensync"
database_url = "sqlite:///var/lib/opensync/relay.db?mode=rwc"

name        = "my relay"
description = "vault sync for one household"

# Bytes per account. 5 GB is the default; a vault of notes is a few megabytes,
# so this number is really a ceiling for attachments.
quota_bytes    = 5368709120
max_blob_bytes = 268435456       # 256 MB, the largest single file

# Who may store anything here at all. See §4 — this is the gate that
# `require_auth` is often mistaken for.
admission = "roster"

# Something in front of this relay is terminating TLS and forwarding to it.
behind_a_reverse_proxy = true
```

Every field has a default; write down only what you are changing. The full set
is documented in `crates/opensync-relay/src/config.rs` in the engine repo, with
the reasoning for each.

**Bind to loopback and let a reverse proxy face the internet.** The relay
speaks plain HTTP; it has no TLS of its own, by design — terminating TLS is a
solved problem and every solution is better maintained than one written here
would be.

## 3. Put TLS in front of it

Your phone will refuse `ws://` from anything but localhost, and so should you:
without TLS, everyone between your phone and your relay sees which account is
syncing and how much. They still cannot read a note — that is sealed
separately — but that is not a reason to hand out the rest.

### Caddy, which is the short way

```caddyfile
relay.example.net {
    reverse_proxy 127.0.0.1:4848
}
```

```sh
sudo caddy run --config /etc/caddy/Caddyfile
```

Caddy gets a certificate from Let's Encrypt on first request and renews it. No
other configuration is needed: WebSocket upgrades are proxied by default.

### nginx, if you already run it

```nginx
server {
    server_name relay.example.net;

    location / {
        proxy_pass http://127.0.0.1:4848;
        proxy_http_version 1.1;

        # Without these three the pointer socket connects and then dies, and
        # the plugin reports a relay that is "up" and never answers.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Blobs are up to max_blob_bytes; nginx defaults to 1 MB and rejects
        # the rest with a 413 that looks exactly like a quota error.
        client_max_body_size 256m;
    }

    listen 80;
}
```

```sh
sudo certbot --nginx --redirect -d relay.example.net
```

> **If your domain is newly registered, delete the registrar's parking records
> first.** A fresh domain usually ships with a URL-forwarding record on the
> apex and a `www` CNAME to the registrar's parking page. Certbot then fails
> with a 404 on the ACME challenge, because the forwarder rewrote the challenge
> URL. The error does not mention parking.

### Check it before going further

```sh
curl -sS -H 'Accept: application/nostr+json' https://relay.example.net | head
```

You should get the relay's NIP-11 document: its name, the kinds it accepts, and
`"auth_required": true`. Anything else — a 502, a parking page, a certificate
warning — is a problem to solve now rather than from inside Obsidian, where it
will look like a plugin bug.

## 4. Decide who may store things

This is the setting that matters most, and the one whose name does not say so.

`require_auth = true` — the default — means a client must prove it holds the
private key for the pubkey it claims. It does **not** mean you know who that
is: a keypair takes a millisecond to generate and costs nothing. On a relay
with a public hostname, `require_auth` alone gets you an anonymous file host
with a Blossom API and a published address.

So there are two admission modes:

| `admission` | Who gets an allowance | Right for |
|---|---|---|
| `"anyone"` | every pubkey that completes AUTH | a relay on your own machine or inside your own network, where being able to reach it *is* the permission |
| `"roster"` | only pubkeys you have admitted | anything with a hostname |

**The relay refuses to start in the dangerous combination.** Bind somewhere
other than loopback with `admission = "anyone"` and it exits before opening a
socket, telling you what it would have been. If that is genuinely what you want
— an open relay, deliberately — say `anyone_may_store_here = true` and it will
believe you.

### Admitting accounts

Every account has a public key. The plugin shows it as an `npub1…` in the
recovery kit and the settings pane; the roster takes either that or the 64-hex
form.

```sh
opensync-relay relay.toml roster                    # who is served
opensync-relay relay.toml admit npub1abc… "my phone"
opensync-relay relay.toml admit npub1def… "a friend" --quota 21474836480
opensync-relay relay.toml revoke npub1abc…
```

`--quota` gives that one account a ceiling of its own, in bytes, instead of the
relay's default. This is how tiers are built: the default is the free
allowance, and a grant is a bigger one. A grant also admits — writing down how
much space somebody gets has already decided that they get some.

Changes take effect without a restart.

There is an HTTP equivalent at `/admin/roster`, which needs `operator_pubkey`
set and requests signed by that key. It exists for a signup page. If you are
the operator and you have a shell on the box, use the subcommands.

## 5. Keep it running

```ini
# /etc/systemd/system/opensync-relay.service
[Unit]
Description=OpenSync relay
After=network.target

[Service]
ExecStart=/usr/local/bin/opensync-relay /etc/opensync/relay.toml
User=opensync
Restart=on-failure
StateDirectory=opensync

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now opensync-relay
journalctl -u opensync-relay -f
```

On a Mac, the equivalent is a `launchd` plist in `~/Library/LaunchAgents`, or
simply leaving it running in a terminal while you try it.

## 6. Back it up

**This is the part people skip, and it is the part that matters.** If the relay
is where a device goes to fetch a vault it does not have, then losing the relay
means losing whatever only lived there.

Two things to copy:

```sh
sqlite3 /var/lib/opensync/relay.db ".backup '/backup/relay.db'"
rsync -a /var/lib/opensync/blobs/ /backup/blobs/
```

Take the SQLite backup with `.backup` rather than copying the file, or you will
eventually copy a database mid-write and discover it at the worst moment.

The blobs are ciphertext, so a backup can go anywhere — another machine,
another country, somebody else's cloud. Whoever holds it learns the size of
your vault and nothing else.

**Practise the restore.** A backup nobody has restored is a hypothesis.

## 7. Point the plugin at it

In Obsidian: **Settings → OpenSync**.

| Field | Value |
|---|---|
| Relay address | `wss://relay.example.net/` |
| Storage address | `https://relay.example.net` |

Then either **Generate** both keys, if this is your first device, or pair from
a device that already has the account.

Two things happen immediately:

- **Attachments unlock.** The plugin reads the relay's hostname, sees that it
  is not the hosted one, and stops metering. Images, PDFs and audio sync like
  everything else, up to whatever your disk holds. Turn on **Sync attachments**
  and they go.
- **The account is yours to admit.** If you set `admission = "roster"`, the
  first sync will fail until you admit the account's pubkey. That is not a
  bug, and it is the whole point of the setting.

### Household setup, in the order that works

1. Run the relay on a machine that stays on.
2. On that machine, open Obsidian, set the relay address, generate the keys.
3. Admit the pubkey with `opensync-relay relay.toml admit …`.
4. Sync. Confirm the relay's `data_dir` grows.
5. On the phone, install the plugin, and use **Add a device** on the desktop to
   show a QR. Scan it. The invitation carries the relay address, so nothing is
   typed.
6. Print the recovery kit and put it where the passports are.

---

## Things that go wrong here

**"nothing answered that code" when pairing.** The joining device could not
reach the relay. On a phone, the relay address must be one the phone can
resolve — a LAN address or a public hostname, never `127.0.0.1`, which on a
phone means the phone.

**The first sync fails with "quota exceeded" on an empty relay.** The account
is not admitted. `opensync-relay relay.toml roster` will show it is not there.

**The pointer socket connects and never answers.** A reverse proxy that is not
forwarding the WebSocket upgrade. See the three nginx headers above.

**A large attachment fails and small ones work.** `client_max_body_size`, or
the equivalent in whatever is in front. The relay's own limit is
`max_blob_bytes`.

**Everything works on the desktop and nothing works on the phone.** Almost
always TLS: a self-signed certificate, or a certificate that does not cover
the name. Check with `curl` from another machine before blaming the plugin.

More in [troubleshooting.md](troubleshooting.md).
