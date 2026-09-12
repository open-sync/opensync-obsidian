# Troubleshooting

Ordered by how often each one happens, not by how interesting it is. Every
entry says what the message *means*, because several of them name the wrong
thing.

---

## Pairing

### "nothing answered that code"

The joining device could not reach the relay, or the code was already spent.

A code is good for **one device and one attempt**. Answering it consumes it
whether the answer was right or wrong — that is deliberate, and it is what lets
ten characters be safe. Show a new one.

If it is not that, it is the relay address. On a phone, the address must be one
the phone can resolve: a LAN address (`ws://192.168.1.20:4848/`) or a public
hostname. **`127.0.0.1` on a phone means the phone.** The pane warns about this
when it sees a loopback address, and the warning is there because this is the
commonest pairing failure by a distance.

### "Fill in the relay address from the other device, or paste the whole opensync://pair… line"

You typed ten characters on a device that does not know which relay to ask. The
ten characters identify a conversation; they do not say where it is happening.

Either fill in *Relay address* first, or go back to the other device and copy
the whole `opensync://pair…` line, which carries the address with it. On a
phone, scan the QR — same thing, fewer keystrokes.

### The QR will not scan

The plugin draws a QR; it does not read one. Use your phone's camera app, which
will offer to open the link, or copy the `opensync://pair…` line instead.

---

## Syncing

### The status bar says "error"

Open the developer console — **Ctrl/Cmd+Shift+I** → Console — and look for a
line beginning `OpenSync`. The status bar has one line to work with; the
console has the actual failure.

### "quota exceeded"

Either the account has genuinely filled its allowance, or — far more often on a
relay you just set up — **the account is not admitted**.

A relay with `admission = "roster"` serves only pubkeys its operator has
admitted, and an unadmitted account has no allowance at all, which surfaces the
same way as a full one. On your own relay:

```sh
opensync-relay relay.toml roster          # is the account listed?
opensync-relay relay.toml admit npub1…    # admit it
```

See [self-hosting.md](self-hosting.md#4-decide-who-may-store-things).

### "the relay is advertising a manifest it does not hold"

The pointer on the relay names a manifest blob that is not there. Either the
blob store lost data, or something was deleted out from under it — a manual
cleanup of `data_dir`, or a restore that brought back the database but not the
blobs.

Recovery: sync from a device that still has the vault. It republishes
everything the relay is missing, because publishing checks what the relay holds
before uploading.

### "the store is missing a chunk of *note.md*"

The same thing, one level down: the manifest names a chunk the store does not
have. The same fix works, from a device that still holds that file.

### Sync is stuck on "syncing…"

The plugin syncs when a vault opens and refuses to start a second sync while
one is running, so a stalled network call leaves it there. There is no timeout
on a relay request today — a known gap. Reload Obsidian
(**Ctrl/Cmd+R**) and check the relay is answering:

```sh
curl -sS -H 'Accept: application/nostr+json' https://relay.example.net | head
```

### Nothing syncs, and there is no error

Check *Sync automatically* is on. It syncs on a timer — every two minutes by
default — rather than on every keystroke, because publishing per keystroke
would lose a race with itself. **Sync now** is in the command palette if you
want it immediately.

---

## Files

### An attachment is not syncing

Expected on the free plan, which carries the file types a vault is *written*
in and not the ones it accumulates. The settings pane lists what is being held
back, by name.

Three ways forward: turn on *Sync attachments* with a Supporter plan, point the
plugin at [a relay of your own](self-hosting.md), where nothing is metered, or
leave it — the file is not deleted, it simply stays where it is.

### A file with no extension does not sync

Correct on the free plan. `LICENSE`, `Makefile` and similar have no extension
to match against the carried list. They sync on a relay of your own.

### A conflict copy appeared

Two devices changed the same file before either had seen the other's change.
Both versions are kept: yours keeps the original name, and the incoming one
becomes `note (conflict 2026-09-12 from Laptop).md`.

**The name is the device whose text is inside the copy**, not the device that
made it. Open both, keep what you want, delete the other — deleting a conflict
copy is an ordinary deletion and propagates like one.

### Files disappeared after I changed a setting

They should not, and this is worth reporting. A plan or a scope changes what a
device *publishes*, never what any device keeps — a manifest now declares which
file types it covers, so a device that carries only notes cannot tell another
device that its images were deleted.

Anything trashed by the plugin goes to Obsidian's trash rather than being
destroyed. Check **Settings → Files and links → Deleted files** for where that
is, and recover from there.

---

## Keys and recovery

### "keys are not usable"

A key was pasted into the wrong field. The vault key starts `ovault1` and the
account key starts `nsec1`; each field refuses the other, which is the only
place that mistake gets caught.

### I rotated and now another device cannot sync

That is what rotation does. Every device you keep must be paired again — use
**Add a device** on the rotated device and join from the other one. There is
deliberately no announcement, because a notice that reached your devices would
also reach the device you were rotating away from.

### I lost every device

The printed recovery kit is the only way back. Type both keys into a fresh
install's *Vault key* and *Account key* fields, set the relay address, and
sync.

If there is no kit, the vault is unrecoverable. Nobody holds a copy of your
key — not us, not the relay operator. That is the bargain the encryption makes,
and it is why the pane asks you to print the kit on the first day.

---

## Reporting something

Include: what the status bar said, what the developer console said, whether the
relay is ours or yours, and whether the other device was on the same plan. The
last one matters more than it sounds — several failure modes only appear when
two devices disagree about what they are carrying.
