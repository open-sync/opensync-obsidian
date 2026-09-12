# Security model

What is protected, what is not, and why each decision was made that way. Read
the second half before trusting the first.

---

## The short version

Your vault is sealed on your own device with a key that never leaves it. The
relay stores ciphertext addressed by the hash of that ciphertext, and knows
your account's public key, its byte count, and when it connected. It cannot
read a note, a filename, or a folder, and neither can anyone who steals its
disk.

Nobody holds a copy of your key, including us. There is no reset.

---

## The keys

Two, with different jobs, which is why they look different and live in
different fields.

| | Looks like | What it does | If it leaks |
|---|---|---|---|
| **Vault key** | `ovault1…` | encrypts everything before it leaves the device | everything you have ever synced is readable |
| **Account key** | `nsec1…` | identifies you to the relay | somebody can publish and use quota as you, but reads nothing |

The vault key is the one that matters. It never travels in a form the relay can
read, it is never displayed to enrol a device, and losing it is unrecoverable.

Everything under it is derived rather than stored separately: the manifest key,
the chunk keys, and the nonces all come from one root by HKDF.

## What the relay sees

| It sees | It does not see |
|---|---|
| an account's public key | any note |
| when that account connected | any filename or folder name |
| how many bytes it stores | how many files there are, or which changed |
| the size and hash of each sealed blob | the plaintext hash of anything |

Two hashes make that last row hold, and the distinction is the whole reason the
storage is not an oracle:

- **`ContentHash`** is BLAKE3 of the **plaintext**, and lives only inside the
  sealed manifest. It is what proves a chunk came back intact.
- **`BlobId`** is SHA-256 of the **ciphertext**, and is the storage address.

Addressing by the plaintext hash would deduplicate identical files across
accounts, which sounds like a feature and is an attack: anyone holding a copy
of a file they suspect you have could ask the store whether that address exists
and learn the answer. Addressing by ciphertext means two accounts storing the
same PDF produce different addresses, and the question cannot be asked.

Chunk nonces are **derived from the plaintext hash under a secret key** rather
than being random. Random nonces would mean identical content sealed twice
produces different bytes, which would defeat deduplication *within* an account
— the one place it is safe and the one place it saves money. Deriving them
means identical content seals identically inside your account and differently
from everyone else's.

## Adding a device

The vault key is never shown, never typed, and never sent anywhere the relay
could read it.

A device that has the account shows **ten characters**. The joining device
takes them, and the two run a **SPAKE2** exchange — a password-authenticated
key agreement — over an ephemeral relay event that the relay does not store. At
the end both sides hold a key derived from those ten characters, and the vault
key crosses sealed under it.

Two properties come from choosing a PAKE rather than "encrypt the key under a
password":

- **An eavesdropper gets no offline attack.** Somebody recording the exchange
  cannot take it away and try ten-character strings against it. That is what
  lets ten characters be enough; sealing under a passphrase would need one long
  enough to survive a dictionary.
- **One code, one attempt.** The granting state is consumed when it is
  answered, right or wrong. So an attacker on the wire at that exact moment
  gets a single online guess against thirty bits, rather than unlimited offline
  guesses.

The joining device authenticates to the relay with a **throwaway keypair**: it
has no account yet, and the relay's AUTH only proves possession of a key
anyway.

## Removing a device

**There is no revocation list, and adding one would be a lie.** A device that
has held the vault key can decrypt anything it has already seen, and nothing
published to a relay can be recalled — deletion there is advisory, and a blob
that was ever fetched was ever copied.

What can be done is **rotate**: re-seal the vault under a new key and sweep
what the old one addressed. Afterwards what remains on any relay is ciphertext
nobody holds a key for. That is the only meaningful delete this design has.

It costs pairing every device you keep, always. The new key is never published
under the old one, because a notice that reached your devices would reach the
device you are rotating away from — which is exactly the device you are trying
to exclude.

Two things rotation does **not** do:

- It does not evict anyone from the *account*. A device that kept the account
  key can still publish and burn quota under your name; it simply cannot
  produce anything your other devices will accept. Cutting that off means a new
  account key, which is a louder decision.
- It only re-seals the namespace it is run from. One vault key covers a
  clipboard and a password store too, if you use them, and a namespace left out
  is not merely un-rotated — it becomes ciphertext under a key that no longer
  exists. The pane says so before the second press.

## Losing everything

The recovery kit is a printed page with both keys grouped for typing. Each
carries a bech32 checksum, so a single mistyped character is caught rather than
producing a valid-looking key that opens nothing. The two are bound together by
a **fingerprint**, because a checksum cannot catch two correctly typed keys
taken from different printouts.

The plugin renders the kit and then **parses it back** before telling you it is
ready, so the page is proved readable rather than assumed to be.

There is no other copy. If the kit is lost and the devices are gone, the vault
is gone.

## What this does not protect against

Said plainly, because a security page that only lists strengths is marketing.

- **A compromised device.** The vault key is on it, in the plugin's settings
  file. Anything with your user account has it.
- **Obsidian itself, and every other plugin you install.** A plugin runs with
  the same access this one has and can read `data.json`. Sync cannot be safer
  than the application it is inside.
- **Traffic analysis.** The relay sees when you sync and how much moved. Over
  time that is a pattern of when you work.
- **Metadata at the edges.** Your account's public key is visible to the relay,
  and the same account across products links those products together.
- **A malicious relay serving stale data.** It cannot forge a manifest — it has
  no key — but it can withhold one, answering with an older pointer. Ordering
  comes from a generation counter, so a client will not go backwards, but it
  can be kept from going forwards.
- **`.obsidian/` is not synced at all.** Your settings, themes, snippets and
  other plugins' data stay on each device. That is a deliberate limit, not
  protection.

## Reporting a vulnerability

Open a security advisory on this repository rather than a public issue, and
give it a week before disclosing. If it concerns the engine's cryptography
rather than the plugin, it belongs in the [engine
repository](https://github.com/open-sync/opensync) instead.

**This code has not been independently audited.** Obsidian published two audits
of their own sync; this has had none. That is a gap, it is known, and it is
worth weighing before trusting it with something irreplaceable.
