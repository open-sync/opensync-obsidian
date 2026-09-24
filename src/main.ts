import {
  App,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
} from "obsidian";

import {
  endpointsFor,
  generateAccountKey,
  drawInvitation,
  grantAccount,
  Invitation,
  joinAccount,
  Namespace,
  npubOf,
  PairingCode,
  parseAccountKey,
  QuotaError,
  readAccountLink,
  readRecoveryKit,
  ready,
  Relay,
  RemoteSigner,
  renderRecoveryKit,
  republishVaultKey,
  signInWithNostr,
  Signer,
  vaultString,
  type NostrSigner,
  type SignerChoice,
// Vendored, not reached across a sibling checkout: this repository has to
// build on its own, for a reviewer and for the directory's build check.
// `npm run vendor` refreshes it; `npm run vendor:check` fails if it drifts.
} from "../vendor/opensync-client";

/**
 * What the free plan carries: the file types a vault is *written* in, as
 * opposed to the ones it accumulates.
 *
 * Chosen by weight rather than by importance. A note, a canvas, a Bases
 * table and an Excalidraw drawing are all a few kilobytes of text; a
 * screenshot, a PDF or a voice memo is three orders of magnitude bigger, and
 * attachments are the only thing here that costs real money to keep. The list
 * is deliberately an allow-list: a file type nobody anticipated is far more
 * likely to be a new kind of binary than a new kind of prose, and the failure
 * that matters is the one where a photo library syncs by accident.
 *
 * `.excalidraw.md` and `.canvas` are Obsidian's own; `.json`, `.csv`, `.svg`,
 * `.yaml` and `.bib` are what the common plugins write beside them.
 */
/**
 * What to say when somebody turns attachments off.
 *
 * Not "your files will be deleted": on devices running this version they will
 * not, and a warning that overstates is one people learn to dismiss. The
 * manifest declares the extensions its publisher was carrying, and a reader
 * treats a missing path as a deletion *only inside that scope* — so narrowing
 * what this device offers no longer reads as "delete the rest".
 *
 * The risk that remains is version skew, and it is real rather than
 * theoretical: it was measured on two real vaults before the scope existed.
 * A device still running an older plugin has no scope to read, so it treats
 * every path absent from the manifest as deleted — and it moved the
 * attachment to the trash with the status bar reading "up to date". The
 * warning names that condition rather than the general case, because the
 * general case is safe and the specific one is not.
 */
const TURNING_OFF_WARNING =
  "Attachments will stop being published from this device. Nothing is deleted " +
  "by a device running this version — but one still on an older plugin cannot " +
  "read the manifest's scope, and will treat the attachments it no longer sees " +
  "as deleted and move them to the trash. Update every device before you sync, " +
  "or leave this on until you have.";

const FREE_EXTENSIONS = [
  "md",         // notes, and Excalidraw drawings, which are markdown
  "canvas",     // Obsidian Canvas
  "base",       // Obsidian Bases
  "excalidraw", // the legacy Excalidraw format, plain JSON
  "json",       // plugin data, and drawings
  "csv",        // tables, Dataview sources
  "txt",
  "svg",        // diagrams — vector, so text, and small
  "css",        // themes and snippets
  "yaml",
  "yml",
  "bib",        // citations
  "drawio",     // diagrams.net, which is XML
];

/**
 * The relay this plugin ships pointing at, and the only one anything is
 * metered on.
 *
 * Empty until there is one, which is also the honest default: with no hosted
 * relay, every user is running their own, and there is nothing to sell them.
 * The plan gate below reads this — so the day this string is filled in is the
 * day the free plan starts meaning anything, and not before.
 */
declare const __HOSTED_RELAY__: string;
/**
 * Is this a build made for someone to test?
 *
 * The plan will come from the account once there is one. Until then a tester
 * asked to check what the free tier does and what the paid tier does has no
 * way to be either, so a test build says which it is and lets them switch.
 * Off in anything released, where the control would be a lie: flipping a
 * setting does not pay for storage, and the relay meters bytes regardless.
 */
declare const __TEST_BUILD__: boolean;
const HOSTED_RELAY = __HOSTED_RELAY__;

/**
 * The OpenApps account server: the account a Nostr sign-in also signs in to.
 *
 * The product's own host, never the platform's. Being provisioned as this is
 * written, which is why nothing about syncing waits on it: a sign-in that
 * cannot reach it still sets sync up, and says so.
 */
const ACCOUNTS_BASE = "https://auth.opensync.network";
/**
 * Is this a build for the in-app checks?
 *
 * Only then may the account server be pointed elsewhere, at a local one the
 * check starts. A released build has no way to be redirected: the address a
 * signed challenge names is the address it is sent to.
 */
declare const __CHECK_BUILD__: boolean;
function accountsBase(): string {
  if (__CHECK_BUILD__) {
    const override = (globalThis as { opensyncAccountsBase?: string }).opensyncAccountsBase;
    if (override) return override.replace(/\/+$/, "");
  }
  return ACCOUNTS_BASE;
}

/** The blob endpoint beside a relay: same host, the other scheme. */
function storageFor(ws: string): string {
  if (!ws) return "";
  if (ws.startsWith("wss://")) return `https://${ws.slice(6).replace(/\/+$/, "")}`;
  if (ws.startsWith("ws://")) return `http://${ws.slice(5).replace(/\/+$/, "")}`;
  return "";
}

interface OpenSyncSettings {
  relayWs: string;
  relayHttp: string;
  /** The account key. Identity on the relay; never sees vault content. */
  accountSecret: string;
  /** The namespace key. This is what actually protects the vault. */
  namespaceKey: string;
  namespace: string;
  deviceLabel: string;
  syncOnSave: boolean;
  /** What the user has asked for. Only granted when the plan allows it. */
  syncAttachments: boolean;
  /**
   * What the account is entitled to.
   *
   * A flag in a settings file, which anyone can edit — and that is fine,
   * because it is not what enforces anything. The relay cannot see a file
   * type at all: filenames live inside the sealed manifest and every blob is
   * ciphertext. What the server enforces is bytes, through the account's
   * quota, and this flag only decides what this device offers to upload.
   * Filled from the account once there is one to ask.
   */
  plan: "free" | "supporter";
  /**
   * Which relay host the plan applies to. Ours.
   *
   * Not shown in the pane. It exists because the thing being sold is *not
   * running a server*: someone pointing this at their own relay is already
   * paying for their own storage, in their own electricity, and crippling
   * their client would be charging them for the one thing we are not doing.
   * So the gate is "is this our relay", not "has this user paid".
   */
  hostedRelay: string;
  intervalSeconds: number;
  /**
   * How this device signs, once it has signed in with Nostr. Absent on an
   * install set up with keys of its own, which signs with `accountSecret` as
   * it always has. For a remote signer `accountSecret` is empty — the key is
   * in the signer, not here.
   */
  nostr?: SignerChoice;
  /** The OpenApps account the same key signed in to, as last seen. */
  account?: { id: string; name: string } | null;
  /** This install's entry in Obsidian's secret storage, when there is one. */
  secretId?: string;
}

/** An OpenApps session. Kept with the secrets, never in `data.json` if avoidable. */
interface AccountSession {
  access_token: string;
  refresh_token: string;
}

/**
 * What goes in Obsidian's secret storage rather than `data.json`.
 *
 * Only for a Nostr sign-in: that key is somebody's identity everywhere Nostr
 * is used, not a key this plugin made up, and a vault folder is a thing
 * people copy, back up and share. Installs set up with their own random keys
 * keep them where they always were.
 */
interface StoredSecrets {
  accountSecret?: string;
  clientSecret?: string;
  session?: AccountSession | null;
}

// Loopback is a fine default on a desktop, where the relay is often on the
// same machine. On a phone it is never right — 127.0.0.1 is the phone — and
// shipping it as a default just produces a connection error that points at
// the wrong thing.
const DEFAULTS: OpenSyncSettings = {
  // The hosted relay when this build has one, so an install syncs with
  // nothing typed. Without one the desktop default is a relay on this
  // machine, and the mobile default is empty — 127.0.0.1 on a phone is the
  // phone, and shipping it produces a connection error pointing at the wrong
  // thing.
  relayWs: HOSTED_RELAY || (Platform.isMobile ? "" : "ws://127.0.0.1:4848/"),
  relayHttp: HOSTED_RELAY
    ? storageFor(HOSTED_RELAY)
    : Platform.isMobile
      ? ""
      : "http://127.0.0.1:4848",
  accountSecret: "",
  namespaceKey: "",
  namespace: "vault:main",
  // Replaced at load with the vault's own name, which is the thing a person
  // recognises. Left generic here because a default cannot reach the app.
  deviceLabel: "",
  syncOnSave: true,
  syncAttachments: false,
  plan: "free",
  hostedRelay: HOSTED_RELAY,
  intervalSeconds: 120,
};

/**
 * What `data.json` holds: the settings, plus the pointer and merge base that
 * `saveState` keeps beside them. `loadData` is typed `any` by Obsidian, so this
 * is the one place that says what comes back.
 */
type StoredState = Partial<OpenSyncSettings> & {
  _pointer?: Pointer | null;
  _base?: ManifestJson | null;
  /** The OpenApps session, when there is no secret storage to keep it in. */
  _session?: AccountSession | null;
};

/** What the engine's merge hands back. */
interface MergeOutcome {
  merged: ManifestJson;
  conflicts: { path: string; copy_path: string }[];
}

interface Pointer {
  root: string;
  generation: number;
  updated_at: number;
}

interface ManifestEntry {
  size: number;
  mtime: number;
  chunks: { content: string; blob: string; len: number }[];
}

interface Blob {
  id: string;
  bytes: Uint8Array;
}

interface Commit {
  /** Hex, because it rides in a Nostr event's content field. */
  pointer: string;
  root: string;
  generation: number;
  blobs: Blob[];
}

interface ManifestJson {
  generation: number;
  updated_at: number;
  entries: Record<string, ManifestEntry>;
  /** The device that published it. Absent on manifests written before the
   *  field existed, and on surfaces that do not set one. */
  device?: string;
  /** The extensions the publisher was carrying. Absent means everything. */
  scope?: string[];
}

/**
 * Does this manifest have anything to say about `path`?
 *
 * `false` means the device that wrote it was not carrying this kind of file,
 * so the path's absence is silence rather than a deletion. Mirrors
 * `Manifest::covers` in the engine; the two must agree, because one decides
 * what the merge keeps and the other decides what gets moved to the trash.
 */
function covers(manifest: ManifestJson, path: string): boolean {
  if (!manifest.scope) return true;
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return manifest.scope.includes(ext);
}

export default class OpenSyncPlugin extends Plugin {
  settings: OpenSyncSettings = { ...DEFAULTS };
  private ns: Namespace | null = null;
  private relay: Relay | null = null;
  private pointer: Pointer | null = null;
  private base: ManifestJson | null = null;
  private status: HTMLElement | null = null;
  /** What the status bar says, without the prefix, for the settings pane. */
  statusText = "idle";
  private running = false;
  private dirty = false;
  /** The signer the relay uses, and which identity it was opened for. */
  private signer: NostrSigner | null = null;
  private signerFor = "";
  /** The OpenApps session, if the Nostr sign-in reached the account server. */
  session: AccountSession | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Instantiated from an inlined module, so there is nothing to fetch and
    // the same path works on desktop and mobile.
    await ready();

    this.status = this.addStatusBarItem();
    this.setStatus("idle");

    this.addSettingTab(new OpenSyncSettingTab(this.app, this));
    this.addCommand({
      // Not "opensync-sync-now": Obsidian prefixes the plugin id itself, and
      // repeating it gives the palette "OpenSync: OpenSync sync now".
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.sync(true),
    });

    // Debounced: a vault emits a modify event per keystroke burst, and a
    // publish per keystroke would be both wasteful and a good way to lose a
    // replaceable-event race with yourself.
    const touch = () => {
      this.dirty = true;
    };
    this.registerEvent(this.app.vault.on("modify", touch));
    this.registerEvent(this.app.vault.on("create", touch));
    this.registerEvent(this.app.vault.on("delete", touch));
    this.registerEvent(this.app.vault.on("rename", touch));

    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.syncOnSave && this.dirty) void this.sync(false);
      }, Math.max(15, this.settings.intervalSeconds) * 1000),
    );

    this.app.workspace.onLayoutReady(() => void this.sync(false));
  }

  onunload(): void {
    this.relay?.close();
    void this.signer?.close?.();
  }

  /**
   * Obsidian's secret storage, where it exists (1.11.4 and later).
   *
   * Looked up rather than assumed: the plugin still loads on 1.6.6, where
   * there is none and a Nostr key has to live in `data.json` like every other
   * key here.
   */
  private get keychain(): { setSecret(id: string, secret: string): void; getSecret(id: string): string | null } | null {
    const store = (this.app as { secretStorage?: unknown }).secretStorage as
      | { setSecret?: unknown; getSecret?: unknown }
      | undefined;
    if (!store || typeof store.setSecret !== "function" || typeof store.getSecret !== "function") return null;
    return store as { setSecret(id: string, secret: string): void; getSecret(id: string): string | null };
  }

  /** Whether a Nostr key is kept out of `data.json` on this install. */
  get secretsInKeychain(): boolean {
    return this.keychain !== null;
  }

  async loadSettings(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as StoredState;
    this.settings = Object.assign({}, DEFAULTS, stored);
    this.session = stored._session ?? null;
    const keychain = this.keychain;
    if (this.settings.secretId && keychain) {
      try {
        const secrets = JSON.parse(keychain.getSecret(this.settings.secretId) || "{}") as StoredSecrets;
        if (secrets.accountSecret) this.settings.accountSecret = secrets.accountSecret;
        if (secrets.clientSecret && this.settings.nostr?.kind === "bunker") {
          this.settings.nostr = { ...this.settings.nostr, clientSecret: secrets.clientSecret };
        }
        if (secrets.session) this.session = secrets.session;
      } catch {
        // An unreadable entry reads as "not signed in on this device", which
        // the pane says, and signing in again repairs.
      }
    }
    // The label ends up in the name of every conflict copy, so a default that
    // is the same everywhere makes the copies useless: two devices both
    // shipped "This device" and produced "note (conflict … from This
    // device).md" on both sides of the fork. The vault's name is at least the
    // name the person chose.
    if (!this.settings.deviceLabel) this.settings.deviceLabel = this.app.vault.getName();
    this.pointer = stored._pointer ?? null;
    this.base = stored._base ?? null;
  }

  async saveSettings(): Promise<void> {
    await this.saveState();
    this.ns = null;
    this.relay?.close();
    this.relay = null;
    // The signer outlives an ordinary settings change: for a remote signer,
    // reopening it is a round trip to a phone. Only a different identity
    // closes it.
    if (this.signer && this.signerFor !== this.identity()) {
      void this.signer.close?.();
      this.signer = null;
    }
  }

  private setStatus(text: string): void {
    this.statusText = text;
    this.status?.setText(`OpenSync: ${text}`);
  }

  /** Has this device been set up — with keys of its own, or a Nostr sign-in? */
  get configured(): boolean {
    const s = this.settings;
    return Boolean(s.namespaceKey && (s.accountSecret || s.nostr?.kind === "bunker"));
  }

  /** Which identity the saved settings sign as, for noticing a change. */
  private identity(): string {
    const s = this.settings;
    return `${s.nostr?.kind ?? "own"}|${s.nostr?.pubkey ?? ""}|${s.accountSecret}`;
  }

  /** The npub this device syncs as, if it can say without asking a signer. */
  get npub(): string | null {
    try {
      if (this.settings.nostr?.pubkey) return npubOf(this.settings.nostr.pubkey);
      if (!this.settings.accountSecret) return null;
      return npubOf(Signer.fromHex(parseAccountKey(this.settings.accountSecret)).pubkey);
    } catch {
      return null;
    }
  }

  /**
   * The signer for this device's account, opened once and kept.
   *
   * A key held here is instant. A remote signer is a connection to an app on
   * a phone, reopened with the client key it was approved for, so a restart
   * does not ask for approval again.
   */
  async openSigner(): Promise<NostrSigner> {
    const identity = this.identity();
    if (this.signer && this.signerFor === identity) return this.signer;
    await this.signer?.close?.();
    this.signer = null;
    const choice = this.settings.nostr;
    const signer =
      choice?.kind === "bunker"
        ? await RemoteSigner.open(choice.bunker, {
            clientSecret: choice.clientSecret,
            expected: choice.pubkey,
            onAuthUrl: (url) => new Notice(`OpenSync: your remote signer asks you to approve this device — ${url}`, 0),
          })
        : // The settings field holds `nsec1…` — that is what the Generate
          // button writes and what the description asks for — so it is
          // decoded here. Handing the bech32 string straight to `fromHex`
          // throws on the very first sync, which is what this used to do.
          Signer.fromHex(parseAccountKey(this.settings.accountSecret));
    this.signer = signer;
    this.signerFor = identity;
    return signer;
  }

  private async connect(): Promise<{ ns: Namespace; relay: Relay } | null> {
    if (!this.configured) return null;
    try {
      await ready();
      if (!this.ns) this.ns = new Namespace(this.settings.namespaceKey);
      if (!this.relay) {
        const signer = await this.openSigner();
        this.relay = new Relay(this.settings.relayWs, this.settings.relayHttp.replace(/\/$/, ""), signer);
      }
    } catch (e) {
      this.setStatus(`keys are not usable — ${message(e)}`);
      return null;
    }
    return { ns: this.ns, relay: this.relay };
  }

  /**
   * Is this device carrying attachments?
   *
   * Wanting them is not enough; the plan has to allow it. Kept as one
   * accessor because the answer decides two things that must never disagree —
   * which files are published, and what the manifest claims to cover.
   */
  private get carriesEverything(): boolean {
    return this.settings.syncAttachments && !this.metered;
  }

  /**
   * Is this device storing on the relay we pay for?
   *
   * Only then does a plan mean anything. A relay of your own — on a machine
   * in your house, or anywhere else — is unmetered, because the storage is
   * yours and so is the bill.
   */
  private get metered(): boolean {
    if (this.settings.plan === "supporter") return false;
    const hosted = this.settings.hostedRelay.trim();
    if (!hosted) return false;
    const host = (url: string) => {
      try {
        return new URL(url).host.toLowerCase();
      } catch {
        return "";
      }
    };
    const ours = host(hosted) || hosted.toLowerCase();
    const mine = host(this.settings.relayWs);
    return mine !== "" && mine === ours;
  }

  /** Whether the plan is doing anything here, for the pane and the checks. */
  get onMeteredRelay(): boolean {
    return this.metered;
  }

  /** What the manifests this device publishes cover. `undefined` is everything. */
  private get scope(): string[] | undefined {
    return this.carriesEverything ? undefined : FREE_EXTENSIONS;
  }

  /** Files this device offers, which is exactly what its scope claims. */
  private async readVault(): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    const scope = this.scope;
    for (const file of this.app.vault.getFiles()) {
      if (scope && !scope.includes(file.extension.toLowerCase())) continue;
      const data = await this.app.vault.readBinary(file);
      out.set(file.path, new Uint8Array(data));
    }
    return out;
  }

  /** Whether attachments are actually being carried, plan included. */
  get carriesAttachments(): boolean {
    return this.carriesEverything;
  }

  /** Files in this vault the plan is not carrying, so the pane can say so. */
  heldBackPaths(): string[] {
    if (this.carriesEverything) return [];
    return this.app.vault
      .getFiles()
      .filter((f) => !FREE_EXTENSIONS.includes(f.extension.toLowerCase()))
      .map((f) => f.path);
  }

  private async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
      await this.app.vault.createFolder(parent).catch(() => undefined);
    }
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, buffer);
    } else {
      await this.app.vault.createBinary(normalized, buffer);
    }
  }

  /**
   * Re-seal the whole vault under a fresh key.
   *
   * The only meaningful delete this protocol has: afterwards every blob left
   * on the relay is ciphertext under a key nobody holds. Deletion itself is
   * advisory — the relay may ignore it, and a blob that was ever fetched was
   * ever copied — so rotating is what makes "delete my data" mean something.
   *
   * Cheap here in a way it is not on the native side, and for one reason: the
   * vault on disk is the source of truth. There is nothing to download and
   * re-encrypt. Point the plugin at a new key, forget the pointer and the
   * merge base, and the next sync writes the whole vault out again as if this
   * device had never synced.
   *
   * There is deliberately no announcement. Publishing the new key sealed
   * under the old one would be convenient and would defeat the point: a
   * device you are rotating away from holds the old key, so it would read the
   * notice and follow the vault forever. Every device you keep is paired
   * again, ten characters each.
   */
  async rotate(onProgress: (line: string) => void): Promise<string> {
    const ctx = await this.connect();
    if (!ctx) throw new Error("sign in first");
    if (this.running) throw new Error("a sync is running — wait for it to finish");

    // Collect what the old key addressed *before* anything changes, so it can
    // be swept afterwards. Best effort: the sweep tidies, the rotation is what
    // protects, and a relay that refuses must not fail the rotation.
    const stranded = new Set<string>();
    if (this.pointer) stranded.add(this.pointer.root);
    for (const entry of Object.values(this.base?.entries ?? {})) {
      for (const chunk of entry.chunks) stranded.add(chunk.blob);
    }

    this.running = true;
    try {
      const key = Namespace.generateKey();
      onProgress("Re-sealing the vault…");

      this.settings.namespaceKey = key;
      // A new key means a new history. Keeping the old pointer would publish
      // at a generation another device could never have seen, and keeping the
      // old base would offer a merge against manifests nothing can now open.
      this.pointer = null;
      this.base = null;
      this.ns = null;
      await this.saveState();

      const fresh = await this.connect();
      if (!fresh) throw new Error("the new key was refused");

      // Publish without reading, which no other path here does. An ordinary
      // sync reads the relay's pointer first and merges — but that pointer is
      // still sealed under the key we just replaced, so opening it fails and
      // the rotation would stop one step from the end, having already changed
      // the key. There is nothing to merge with: this device is the only one
      // that can read anything from here until the others are re-paired.
      const files = await this.readVault();
      fresh.ns.clear();
      for (const [path, bytes] of files) fresh.ns.stage(path, bytes);
      const commit = fresh.ns.commit(
        1n,
        BigInt(Math.floor(Date.now() / 1000)),
        this.settings.deviceLabel,
        this.scope,
      ) as Commit;
      await this.publish(fresh.relay, commit);
      this.base = fresh.ns.openManifest(
        commit.blobs.find((b) => b.id === commit.root)!.bytes,
      ) as ManifestJson;
      await this.saveState();
      onProgress(`Published ${files.size} file${files.size === 1 ? "" : "s"} under the new key.`);

      onProgress(`Sweeping ${stranded.size} blob${stranded.size === 1 ? "" : "s"} the old key addressed…`);
      let swept = 0;
      for (const id of stranded) {
        if (await fresh.relay.deleteBlob(id)) swept += 1;
      }
      onProgress(
        swept === stranded.size
          ? `Swept all ${swept}.`
          : `Swept ${swept} of ${stranded.size} — the rest stay on the relay as ciphertext nothing can read.`,
      );

      // An account that signs in with Nostr keeps its vault key on the relay,
      // sealed to the npub. Left alone, the next device to sign in would be
      // handed the key just rotated away and sync into a vault nobody else
      // can read.
      if (this.settings.nostr) {
        try {
          await republishVaultKey(
            await this.openSigner(),
            { ws: this.settings.relayWs, http: this.settings.relayHttp },
            key,
          );
          onProgress("Sealed the new key to your Nostr account, so a device that signs in gets it.");
        } catch (e) {
          onProgress(
            `The new key could not be sealed to your Nostr account (${message(e)}). ` +
              "A device signing in now would get the old one — press Rotate again once the relay is reachable.",
          );
        }
      }
      return key;
    } finally {
      this.running = false;
    }
  }

  async sync(interactive: boolean): Promise<void> {
    if (this.running) return;
    if (!this.configured) {
      if (interactive) new Notice("OpenSync: sign in first, under Settings → OpenSync.");
      return;
    }
    const ctx = await this.connect();
    if (!ctx) {
      if (interactive) new Notice(`OpenSync: ${this.statusText}`);
      return;
    }
    this.running = true;
    this.dirty = false;
    this.setStatus("syncing…");

    try {
      await this.runSync(ctx.ns, ctx.relay);
      this.setStatus("up to date");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.setStatus("error");
      // Quota is worth interrupting for, because there is a decision to make
      // and three ways out of it. Everything else stays in the status bar.
      if (e instanceof QuotaError || interactive) new Notice(`OpenSync: ${message}`);
      console.error("OpenSync", e);
    } finally {
      this.running = false;
    }
  }

  private async runSync(ns: Namespace, relay: Relay): Promise<void> {
    const local = await this.readVault();
    ns.clear();
    for (const [path, bytes] of local) ns.stage(path, bytes);

    const generation = (this.pointer?.generation ?? 0) + 1;
    // Sealed with this device's name in it, so the *other* device can name a
    // conflict copy after this one. Nothing here reads it back for ourselves.
    const commit = ns.commit(
      BigInt(generation),
      BigInt(Math.floor(Date.now() / 1000)),
      this.settings.deviceLabel,
      this.scope,
    ) as Commit;
    const ours = ns.openManifest(
      commit.blobs.find((b) => b.id === commit.root)!.bytes,
    ) as ManifestJson;

    // Read before writing. Publishing first would replace a pointer this
    // device has never looked at, so a concurrent write would be overwritten
    // by a device that never knew it existed.
    const remoteHex = await relay.fetchPointer(this.settings.namespace);

    if (!remoteHex) {
      await this.publish(relay, commit);
      this.base = ours;
      await this.saveState();
      return;
    }

    const incoming = ns.openPointer(remoteHex) as Pointer;
    const theirsSealed = await relay.getBlob(incoming.root);
    if (!theirsSealed) throw new Error("the relay is advertising a manifest it does not hold");
    const theirs = ns.openManifest(theirsSealed) as ManifestJson;

    if (sameContent(ours, theirs)) {
      this.pointer = incoming;
      this.base = theirs;
      await this.saveState();
      return;
    }

    // What this device just sealed, addressed the way a manifest names it.
    const mine = new Map(commit.blobs.map((b) => [b.id, b.bytes] as const));

    const weDiverged = this.base ? !sameContent(this.base, ours) : local.size > 0;
    if (!weDiverged) {
      // A plain fast-forward. Merging here would manufacture conflict copies
      // out of an ordinary update, which is the bug users notice first.
      await this.applyRemote(ns, relay, theirs, local, mine);
      this.pointer = incoming;
      this.base = theirs;
      await this.saveState();
      return;
    }

    const date = today();
    const result = ns.mergeManifests(
      this.base ?? null,
      ours,
      theirs,
      this.settings.deviceLabel,
      date,
      BigInt(Math.floor(Date.now() / 1000)),
    ) as MergeOutcome;

    await this.applyRemote(ns, relay, result.merged, local, mine);
    if (result.conflicts.length > 0) {
      new Notice(
        `OpenSync: ${result.conflicts.length} conflict${result.conflicts.length === 1 ? "" : "s"} — both versions kept.`,
      );
    }

    // Republish the resolved state on top of theirs.
    const merged = await this.readVault();
    ns.clear();
    for (const [path, bytes] of merged) ns.stage(path, bytes);
    const republish = ns.commit(
      BigInt(incoming.generation + 1),
      BigInt(Math.floor(Date.now() / 1000)),
      this.settings.deviceLabel,
      this.scope,
    ) as Commit;
    await this.publish(relay, republish);
    this.base = ns.openManifest(republish.blobs.find((b) => b.id === republish.root)!.bytes) as ManifestJson;
  }

  /** Write blobs first, then the pointer. The pointer is the commit. */
  private async publish(relay: Relay, commit: Commit): Promise<void> {
    for (const blob of commit.blobs) {
      if (await relay.hasBlob(blob.id)) continue;
      await relay.putBlob(blob.bytes);
    }
    await relay.publishPointer(this.settings.namespace, commit.pointer);
    // Keep what we just published. Discarding it reset the generation counter
    // to 1 on every sync, so two devices sat at the same generation forever
    // and every exchange between them looked like a fork.
    this.pointer = {
      root: commit.root,
      generation: commit.generation,
      updated_at: Math.floor(Date.now() / 1000),
    };
    await this.saveState();
  }

  /**
   * Remember the pointer and the merge base across restarts.
   *
   * Obsidian unloads plugins freely, and without this every reload lost the
   * merge base — which makes the next fork resolve against nothing and
   * manufacture conflict copies out of an ordinary update.
   */
  private async saveState(): Promise<void> {
    const state: StoredState = {
      ...this.settings,
      _pointer: this.pointer,
      _base: this.base,
      _session: this.session,
    };
    const keychain = this.keychain;
    if (keychain && this.settings.nostr) {
      // A Nostr sign-in's secrets go to Obsidian's secret storage, and
      // `data.json` keeps only which entry holds them.
      if (!this.settings.secretId) this.settings.secretId = `opensync-${randomId()}`;
      const secrets: StoredSecrets = {
        accountSecret: this.settings.accountSecret || undefined,
        clientSecret: this.settings.nostr.kind === "bunker" ? this.settings.nostr.clientSecret : undefined,
        session: this.session,
      };
      keychain.setSecret(this.settings.secretId, JSON.stringify(secrets));
      state.secretId = this.settings.secretId;
      state.accountSecret = "";
      state._session = null;
      if (state.nostr?.kind === "bunker") state.nostr = { ...state.nostr, clientSecret: "" };
    } else if (keychain && this.settings.secretId) {
      // Signed out, or back to keys of its own: nothing is left in there.
      keychain.setSecret(this.settings.secretId, "");
    }
    await this.saveData(state);
  }

  /**
   * Sign this device in with a Nostr key.
   *
   * Finds the vault key sealed to that key on the relay and joins it; with
   * none, creates one — or, on a device that already synced with keys of its
   * own, keeps that vault key and seals it to the Nostr account. Either way
   * the files in this vault are merged into what the account holds on the
   * next sync, so nothing here is lost by signing in.
   *
   * Saves nothing until the relay has answered, so a failure leaves this
   * device exactly as it was. The account server is tried last and never
   * fails the sign-in.
   */
  async signInNostr(
    open: () => Promise<NostrSigner>,
    nsec: string,
    onProgress: (line: string) => void,
  ): Promise<string> {
    if (this.running) throw new Error("a sync is running — wait for it to finish");
    const s = this.settings;
    if (!s.relayWs) throw new Error("Fill in the relay address under Relay and keys first.");
    await ready();
    this.running = true;
    let signer: NostrSigner | null = null;
    let kept = false;
    try {
      signer = await open();
      onProgress(`Looking for your vault on ${s.relayWs}…`);
      const before = this.configured ? { pubkey: this.npub, key: s.namespaceKey } : null;
      const endpoint = { ws: s.relayWs, http: s.relayHttp || storageFor(s.relayWs) };
      const result = await signInWithNostr(signer, endpoint, before?.key ?? null);
      const samePlace =
        before !== null && before.pubkey === result.npub && vaultString(before.key) === result.namespaceKey;

      const choice: SignerChoice =
        signer instanceof RemoteSigner ? signer.choice : { kind: "key", pubkey: signer.pubkey };
      this.relay?.close();
      this.relay = null;
      this.ns = null;
      if (this.signer !== signer) await this.signer?.close?.();
      s.nostr = choice;
      s.accountSecret = choice.kind === "key" ? nsec.trim() : "";
      s.namespaceKey = result.namespaceKey;
      s.relayHttp = endpoint.http;
      if (!samePlace) {
        // A different identity or a different vault key is a different
        // history. What this vault holds is merged into the account's on the
        // next sync rather than published over it.
        this.pointer = null;
        this.base = null;
      }
      this.signer = signer;
      this.signerFor = this.identity();
      kept = true;
      this.session = null;
      s.account = null;
      await this.saveState();

      const what = {
        joined: "Signed in. This device joined your vault.",
        created: "Signed in, and a vault made for your account. Sign in on your other devices to bring them in.",
        adopted: "Signed in, carrying on with the vault this device already had.",
      }[result.setup];
      onProgress(before && !samePlace ? `${what} What this vault held is merged in on the next sync.` : what);

      onProgress("Signing in to your OpenApps account…");
      onProgress(await this.connectAccount());
      // After `running` is cleared below, or the sync would see it and leave.
      window.setTimeout(() => void this.sync(false), 0);
      return what;
    } finally {
      this.running = false;
      if (!kept) await signer?.close?.();
    }
  }

  /**
   * Sign in to the OpenApps account with the key this device syncs as.
   *
   * Never throws: the account is a convenience on top of sync, and the server
   * is new. Returns the line the pane shows.
   */
  async connectAccount(): Promise<string> {
    if (!this.settings.nostr) return "";
    try {
      const signer = await this.openSigner();
      this.session = await accountSignIn(signer);
      const me = await accountMe(this.session);
      this.settings.account = me;
      await this.saveState();
      return `Signed in to your OpenApps account, ${me.name}.`;
    } catch (e) {
      this.session = null;
      this.settings.account = null;
      await this.saveState();
      return `Your OpenApps account could not be reached (${message(e)}). Sync works without it.`;
    }
  }

  /**
   * Ask the account server who this is, refreshing the session if it has
   * expired. `null` when there is no session; throws when unreachable.
   */
  async refreshAccount(): Promise<{ id: string; name: string } | null> {
    if (!this.session) return null;
    let me: { id: string; name: string };
    try {
      me = await accountMe(this.session);
    } catch (e) {
      if (!(e instanceof AccountError && e.status === 401)) throw e;
      try {
        this.session = await accountCall<AccountSession>("/v1/auth/refresh", {
          refresh_token: this.session.refresh_token,
        });
      } catch (again) {
        if (again instanceof AccountError && again.status === 401) {
          this.session = null;
          this.settings.account = null;
          await this.saveState();
          return null;
        }
        throw again;
      }
      me = await accountMe(this.session);
    }
    this.settings.account = me;
    await this.saveState();
    return me;
  }

  /**
   * Forget this device's account: keys, signer, account session. The files
   * in the vault stay; so does everything on the relay.
   */
  async signOut(): Promise<void> {
    if (this.running) throw new Error("a sync is running — wait for it to finish");
    const session = this.session;
    if (session) {
      // Best effort: signing out here happens whether or not it arrives.
      void accountCall("/v1/auth/logout", { refresh_token: session.refresh_token }, session.access_token).catch(
        () => undefined,
      );
    }
    this.relay?.close();
    this.relay = null;
    this.ns = null;
    await this.signer?.close?.();
    this.signer = null;
    this.signerFor = "";
    const s = this.settings;
    s.accountSecret = "";
    s.namespaceKey = "";
    s.nostr = undefined;
    s.account = null;
    this.session = null;
    this.pointer = null;
    this.base = null;
    await this.saveState();
    this.setStatus("signed out");
  }

  /**
   * Write a manifest into the vault, fetching only what is genuinely remote.
   *
   * `mine` is what this device just sealed. It matters because a *merged*
   * manifest legitimately names chunks that exist nowhere else yet — our own
   * side of the merge has not been published at this point, and asking the
   * relay for it fails with a missing chunk for a file that is sitting on
   * this disk. The Rust engine avoids this by materialising from a local
   * cache; this is that cache.
   */
  private async applyRemote(
    ns: Namespace,
    relay: Relay,
    manifest: ManifestJson,
    local: Map<string, Uint8Array>,
    mine: Map<string, Uint8Array>,
  ): Promise<void> {
    for (const [path, entry] of Object.entries(manifest.entries)) {
      const current = local.get(path);
      const parts: Uint8Array[] = [];
      let changed = current === undefined;

      for (const chunk of entry.chunks) {
        const sealed = mine.get(chunk.blob) ?? (await relay.getBlob(chunk.blob));
        if (!sealed) throw new Error(`the store is missing a chunk of ${path}`);
        // Verified against what the manifest promised, every time. The AEAD
        // tag proves it was sealed with our key; the hash proves it is the
        // blob we asked for.
        parts.push(ns.openChunk(sealed, chunk.content));
      }
      const joined = concat(parts);
      if (!changed && current && !equal(current, joined)) changed = true;
      if (changed) await this.writeFile(path, joined);
    }

    for (const path of local.keys()) {
      if (path in manifest.entries) continue;
      // Absent, but only a deletion if the device that wrote this manifest
      // was carrying that kind of file. Without this check, one device
      // turning off attachments trashed the other device's attachments —
      // measured, on two real vaults, before the scope existed.
      if (!covers(manifest, path)) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await this.app.fileManager.trashFile(file);
    }
  }
}

function sameContent(a: ManifestJson, b: ManifestJson): boolean {
  const ak = Object.keys(a.entries);
  const bk = Object.keys(b.entries);
  if (ak.length !== bk.length) return false;
  // Content only: mtime and generation deliberately ignored, or a touched
  // file reads as a changed one and produces phantom syncs.
  return ak.every((path) => {
    const x = a.entries[path];
    const y = b.entries[path];
    return (
      y !== undefined &&
      x.chunks.length === y.chunks.length &&
      x.chunks.every((c, i) => c.content === y.chunks[i].content)
    );
  });
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/* ------------------------------------------------------ the OpenApps account */

/** A refusal from the account server, with the status that decides a retry. */
class AccountError extends Error {
  constructor(
    detail: string,
    readonly status: number,
  ) {
    super(detail);
    this.name = "AccountError";
  }
}

/**
 * One call to the account server, through Obsidian's `requestUrl`.
 *
 * Not `fetch`: the plugin's origin is `app://obsidian.md`, which the server
 * has no reason to allow, and `requestUrl` is not subject to CORS.
 */
async function accountCall<T>(path: string, body?: unknown, bearer?: string): Promise<T> {
  let res: { status: number; text: string };
  try {
    res = await requestUrl({
      url: `${accountsBase()}${path}`,
      method: body === undefined ? "GET" : "POST",
      contentType: "application/json",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      throw: false,
    });
  } catch (e) {
    throw new AccountError(`account server unreachable: ${message(e)}`, 0);
  }
  let value: unknown = null;
  try {
    value = res.text ? JSON.parse(res.text) : null;
  } catch {
    throw new AccountError(`the account server answered ${res.status} with something unreadable`, res.status);
  }
  if (res.status >= 200 && res.status < 300) return value as T;
  const error = (value as { error?: { message?: string } } | null)?.error;
  throw new AccountError(error?.message ?? `the account server answered ${res.status}`, res.status);
}

/**
 * Sign in with the key this device syncs as: the server hands out an event
 * template naming its verify URL and a nonce, the signer signs it, and the
 * signed event comes back. The key never leaves the signer.
 */
async function accountSignIn(signer: NostrSigner): Promise<AccountSession> {
  const challenge = await accountCall<{ challenge_id?: string; id?: string; message?: string; payload?: string }>(
    "/v1/auth/challenge",
    { namespace: "nostr" },
  );
  const id = challenge.challenge_id ?? challenge.id;
  const template = challenge.message ?? challenge.payload;
  if (!id || !template) throw new AccountError("the account server sent a challenge without a template", 0);
  const t = JSON.parse(template) as { kind: number; tags: string[][]; content?: string; created_at?: number };
  const event = await signer.signEvent({
    kind: t.kind,
    tags: t.tags,
    content: t.content ?? "",
    created_at: t.created_at ?? Math.floor(Date.now() / 1000),
  });
  const session = await accountCall<AccountSession>("/v1/auth/verify", {
    challenge_id: id,
    proof: { type: "nostr_event", event: JSON.stringify(event) },
  });
  if (!session?.access_token) throw new AccountError("the account server signed nobody in", 0);
  return session;
}

async function accountMe(session: AccountSession): Promise<{ id: string; name: string }> {
  const me = await accountCall<{ id: string; display_name?: string | null }>("/v1/me", undefined, session.access_token);
  return { id: me.id, name: me.display_name || me.id };
}

/* ------------------------------------------------------------------ misc */

/** Eight random bytes as hex: a name for this install's secret-storage entry. */
function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A pasted secret key, as opposed to a remote signer's address. */
function isSecretKey(text: string): boolean {
  const t = text.trim();
  return t.startsWith("nsec1") || /^[0-9a-f]{64}$/i.test(t);
}

/** An npub short enough for a line, whole enough to recognise. */
function shortNpub(npub: string): string {
  return npub.length > 24 ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : npub;
}

/**
 * Whether a blob of text is a recovery kit rather than a code or a link.
 * Both key prefixes, so a stray `nsec1` in something else is not routed here.
 */
function looksLikeKit(text: string): boolean {
  const flat = text.toLowerCase();
  return flat.includes("nsec1") && flat.includes("ovault1");
}

/** Whatever was thrown, as something worth showing a user. */
function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Today, as this device's clock sees it.
 *
 * `toISOString` is UTC, and this date goes in a filename a person reads. East
 * of Greenwich that stamped yesterday on a conflict copy made this morning,
 * and on a recovery kit printed this afternoon — a small wrongness in exactly
 * the two places somebody is trying to work out which of two files is newer.
 */
function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

class OpenSyncSettingTab extends PluginSettingTab {
  /**
   * What the pane should say once it has been rebuilt.
   *
   * A rotation ends by re-rendering, because the new key has to appear in its
   * field — and re-rendering empties the box the rotation was reporting into.
   * Everything it had to say went with it: how many files were re-sealed, how
   * many stranded blobs were swept, and that every other device has to be
   * paired again. On the one operation here that cannot be undone, the screen
   * went blank and looked like nothing had happened.
   */
  private carry: string[] = [];

  constructor(app: App, private readonly plugin: OpenSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Scoped to this render: closing the settings pane and coming back is a
    // way to change your mind about replacing a key.
    let replacing = false;

    this.devicesSection(containerEl);

    new Setting(containerEl)
      .setName("Relay address")
      .setDesc(
        Platform.isMobile
          ? "The address of the computer running your relay, on your network — not 127.0.0.1, which is this phone."
          : "The WebSocket address of your relay. Point it anywhere — including a relay you run yourself.",
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.relayWs).onChange(async (v) => {
          this.plugin.settings.relayWs = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Storage address")
      .setDesc("Where file contents are stored. Usually the same host and port as the relay.")
      .addText((t) =>
        t.setValue(this.plugin.settings.relayHttp).onChange(async (v) => {
          this.plugin.settings.relayHttp = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Vault key")
      .setDesc(
        "Starts ovault1. This is what encrypts everything before it leaves this device. Copy it to your other devices, and keep a copy somewhere safe — nobody, including us, can recover it for you.",
      )
      .addText((t) =>
        t
          .setPlaceholder("ovault1…")
          .setValue(this.plugin.settings.namespaceKey)
          .onChange(async (v) => {
            this.plugin.settings.namespaceKey = v.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((b) =>
        // Two presses when there is a key to lose, matching the Rotate button
        // rather than asking `window.confirm`. On mobile that dialog is not
        // guaranteed to appear at all, and a blocked one reads as a button
        // that silently does nothing — on the control that decides whether a
        // vault stays readable.
        b.setButtonText(replacing ? "Generate — press again" : "Generate").onClick(async () => {
          if (this.plugin.settings.namespaceKey && !replacing) {
            replacing = true;
            b.setButtonText("Generate — press again").setWarning();
            new Notice(
              "This replaces the vault key. Anything already synced under the old one becomes unreadable — press again to go ahead.",
            );
            return;
          }
          replacing = false;
          this.plugin.settings.namespaceKey = Namespace.generateKey();
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Account key")
      .setDesc("Starts nsec1. This is a Nostr key and identifies you to the relay — it never sees your notes.")
      .addText((t) =>
        t.setValue(this.plugin.settings.accountSecret).onChange(async (v) => {
          this.plugin.settings.accountSecret = v.trim();
          await this.plugin.saveSettings();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Generate").onClick(async () => {
          this.plugin.settings.accountSecret = generateAccountKey();
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Device name")
      .setDesc(
        "Travels sealed inside what this device publishes, so a conflict copy made on another of your devices can say the version came from here.",
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.deviceLabel).onChange(async (v) => {
          this.plugin.settings.deviceLabel = v.trim() || this.app.vault.getName();
          await this.plugin.saveSettings();
        }),
      );

    const metered = this.plugin.onMeteredRelay;
    const supporter = !metered;
    const held = this.plugin.heldBackPaths();
    new Setting(containerEl)
      .setName("Sync attachments")
      .setDesc(
        supporter
          ? this.plugin.settings.plan === "supporter"
            ? "Images, PDFs, audio and everything else in the vault. Notes sync either way."
            : "You are syncing through your own relay, so your storage is your own and nothing here is limited. Notes sync either way."
          : "Notes, canvases and the other text your vault is written in sync free and unlimited. " +
            "Images, PDFs and audio are what actually cost storage to keep, so they are part of the paid plan — " +
            "or point this at a relay of your own, where the storage is yours and nothing here is limited. " +
            "Nothing is deleted either way: an attachment simply stays on the device it is on.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.carriesAttachments)
          .setDisabled(!supporter)
          .onChange(async (v) => {
            this.plugin.settings.syncAttachments = v;
            await this.plugin.saveSettings();
            // Warned on the way *down* only, because that is the direction
            // that can cost somebody a file. See `TURNING_OFF_WARNING`.
            if (!v) new Notice(TURNING_OFF_WARNING, 12000);
            this.display();
          }),
      );

    if (supporter && !this.plugin.settings.syncAttachments) {
      // The same sentence the toggle says on the way down, left on the pane
      // afterwards. A warning that appears for eight seconds and is gone is a
      // warning nobody can re-read while they decide whether to sync.
      const caution = containerEl.createDiv({ cls: "opensync-pairing" });
      caution.createEl("p", { text: TURNING_OFF_WARNING });
    }

    if (!supporter && held.length > 0) {
      // Said out loud rather than discovered. A file that silently does not
      // sync is indistinguishable from a file that failed to sync, and the
      // second one is the bug report.
      const note = containerEl.createDiv({ cls: "opensync-pairing" });
      note.createEl("p", {
        text: `${held.length} file${held.length === 1 ? "" : "s"} in this vault ${
          held.length === 1 ? "is" : "are"
        } not covered by the free plan, so ${held.length === 1 ? "it stays" : "they stay"} on this device only:`,
      });
      note.createEl("p", {
        text: held.slice(0, 5).join(", ") + (held.length > 5 ? `, and ${held.length - 5} more` : ""),
        cls: "opensync-invite",
      });
    }

    if (__TEST_BUILD__) {
      new Setting(containerEl)
        .setName("Plan (test build only)")
        .setDesc(
          "Which plan to pretend this account is on, so both tiers can be tried. " +
            "It changes what this device offers to upload and nothing else — the relay meters bytes " +
            "either way, and this control is not in a released build.",
        )
        .addDropdown((d) =>
          d
            .addOption("free", "Free — notes only")
            .addOption("supporter", "Supporter — attachments too")
            .setValue(this.plugin.settings.plan)
            .onChange(async (v) => {
              this.plugin.settings.plan = v === "supporter" ? "supporter" : "free";
              await this.plugin.saveSettings();
              this.display();
            }),
        );
    }

    new Setting(containerEl)
      .setName("Sync automatically")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnSave).onChange(async (v) => {
          this.plugin.settings.syncOnSave = v;
          await this.plugin.saveSettings();
        }),
      );
  }

  /**
   * Getting the keys onto this device, without them being typed.
   *
   * This sits above the key fields on purpose. Those fields are the escape
   * hatch — the thing to do when pairing cannot work — and putting them first
   * taught every new install to copy a vault key by hand, which is the one
   * step where a mistake is silent and permanent.
   */
  private devicesSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    const enrolled = Boolean(settings.accountSecret && settings.namespaceKey);
    new Setting(containerEl).setName(enrolled ? "Your devices" : "Set up").setHeading();
    const status = containerEl.createDiv({ cls: "opensync-pairing" });
    for (const line of this.carry) status.createEl("p", { text: line });
    this.carry = [];
    // Rotation is irreversible and destroys access for every device that is
    // not re-paired, so it takes two presses. Scoped to this render of the
    // pane, which means closing settings and coming back is itself a way to
    // change your mind.
    let confirmed = false;

    if (!enrolled) {
      let typed = "";
      new Setting(containerEl)
        .setName("Join from a code")
        .setDesc(
          "On a device that already has this account, ask for a pairing code — `opensync pair`, or the Add a device button in its settings. Paste the whole opensync://pair… line it shows, or type the ten characters and fill in the relay address below. The keys are never shown and never typed.",
        )
        .addText((t) => t.setPlaceholder("9x4k-tv2q8m, or opensync://pair…").onChange((v) => (typed = v)))
        .addButton((b) =>
          b
            .setButtonText("Join")
            .setCta()
            .onClick(async () => {
              status.empty();
              if (!typed.trim()) {
                status.setText("Type the code from the other device first.");
                return;
              }
              // An invitation carries the relay with it, and wins over the
              // field above: a device that has just been handed one is a
              // device that was never told where the relay is, and a stale
              // address left in the field is not what the person meant.
              await ready();
              let ws = settings.relayWs;
              try {
                ws = Invitation.parse(typed.trim()).relayWs;
              } catch {
                // Ten characters on their own. The relay has to come from
                // somewhere, and on a fresh phone there is nothing there —
                // which used to mean two minutes of asking nobody.
              }
              if (!ws) {
                status.setText(
                  "Fill in the relay address from the other device, or paste the whole opensync://pair… line it showed.",
                );
                return;
              }
              status.setText(`Asking ${ws} for that account…`);
              try {
                const granted = await joinAccount(ws, typed.trim());
                const reachable = endpointsFor(ws, granted);
                settings.accountSecret = granted.accountSecret;
                settings.namespaceKey = granted.namespaceKey;
                settings.namespace = granted.namespace;
                settings.relayWs = reachable.ws;
                settings.relayHttp = reachable.http;
                await this.plugin.saveSettings();
                new Notice(`Joined the account on ${granted.grantedBy} (${granted.accountId})`);
                this.display();
              } catch (e) {
                status.setText(`Did not join: ${message(e)}`);
              }
            }),
        );
      return;
    }

    new Setting(containerEl)
      .setName("Add a device")
      .setDesc(
        "Shows a ten-character code, good for one device and one attempt. The vault key is never displayed and never crosses the relay in a form the relay can read.",
      )
      .addButton((b) =>
        b
          .setButtonText("Show a code")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            status.empty();
            try {
              await ready();
              const code = PairingCode.generate();
              const invitation = new Invitation(settings.relayWs, code);

              // The QR first, because it carries the relay address — which is
              // the half people mistype — and because a phone is the device
              // most likely to be joining and the worst one to type on.
              const canvas = status.createEl("canvas", { cls: "opensync-qr" });
              drawInvitation(canvas, invitation, { moduleSize: 6 });

              // Three ways to carry the same thing, because the right one
              // depends on what the joining device is. A phone scans. A second
              // computer, which cannot point a camera at this screen, gets one
              // line to copy. Anything else reads ten characters aloud — and
              // then needs the relay address too, which is the half that gets
              // mistyped.
              status.createEl("p", { text: "Scan that, paste this line on the other device:" });
              status.createEl("p", { text: invitation.uri, cls: "opensync-invite" });
              status.createEl("p", { text: "…or type both of these:" });
              status.createEl("p", { text: `code   ${code.text}` });
              status.createEl("p", { text: `relay  ${settings.relayWs}` });
              if (/127\.0\.0\.1|localhost/.test(settings.relayWs)) {
                // The commonest pairing failure by a distance, and it reads as
                // a broken code rather than an unreachable address.
                status.createEl("p", {
                  text:
                    "That relay address means \"this machine\", so another device cannot reach it. " +
                    "Put this machine's LAN address in the relay setting first.",
                });
              }
              const line = status.createEl("p", { text: "Waiting for it to answer…" });
              await grantAccount(
                settings.relayWs,
                code,
                {
                  accountSecret: settings.accountSecret,
                  namespaceKey: settings.namespaceKey,
                  namespace: settings.namespace,
                  relayWs: settings.relayWs,
                  relayHttp: settings.relayHttp,
                  grantedBy: settings.deviceLabel,
                },
                parseAccountKey(settings.accountSecret),
              );
              line.setText("Done — that device now has this account.");
            } catch (e) {
              status.createEl("p", { text: `Pairing stopped: ${message(e)}` });
            } finally {
              b.setDisabled(false);
            }
          }),
      );

    new Setting(containerEl)
      .setName("Rotate the vault key")
      .setDesc(
        "Re-seals this vault under a new key, so everything on the relay under the old one becomes unreadable. " +
          "This is the only real delete there is: a relay may ignore a deletion request, and anything ever " +
          "fetched was ever copied. Every device you keep must be paired again afterwards — there is no " +
          "announcement, because one that reached your devices would reach the device you are rotating away from.",
      )
      .addButton((b) =>
        b.setButtonText("Rotate").setWarning().onClick(async () => {
          status.empty();

          // One key covers every namespace on the account, and this plugin
          // only re-seals its own. Saying so before the button is pressed
          // rather than after is the difference between a warning and a
          // post-mortem.
          if (!confirmed) {
            confirmed = true;
            b.setButtonText("Rotate — press again");
            status.createEl("p", {
              text:
                "This re-seals the vault only. If the same key also syncs a clipboard or a password store, " +
                "rotate those from their own app first — this cannot reach them, and afterwards nothing can.",
            });
            status.createEl("p", {
              text: "Every other device loses access until it is paired again. Press Rotate once more to go ahead.",
            });
            return;
          }
          confirmed = false;
          b.setButtonText("Rotate").setDisabled(true);

          const progress: string[] = [];
          try {
            const key = await this.plugin.rotate((line) => {
              progress.push(line);
              status.createEl("p", { text: line });
            });
            this.plugin.settings.namespaceKey = key;
            await this.plugin.saveSettings();
            // Handed to the next render rather than written here: `display()`
            // is what puts the new key in its field, and it empties this box
            // on the way.
            this.carry = [...progress, 'Done. Use "Add a device" to pair each device you are keeping.'];
            this.display();
          } catch (e) {
            status.createEl("p", { text: `Rotation stopped: ${message(e)}` });
          } finally {
            b.setDisabled(false);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Recovery kit")
      .setDesc(
        "The page to print for the day no device is left to pair with. There is no other copy of these keys and nobody can reissue them.",
      )
      .addButton((b) =>
        b.setButtonText("Show it").onClick(async () => {
          status.empty();
          try {
            await ready();
            const page = renderRecoveryKit(
              settings.accountSecret,
              settings.namespaceKey,
              settings.namespace,
              settings.deviceLabel,
              today(),
            );
            // Shown in the settings pane rather than copied to the clipboard:
            // a clipboard is exactly where these two keys should not go.
            status.createEl("pre", { text: page, cls: "opensync-kit" });
            // Read it straight back, so the page is proved parseable before
            // anybody relies on it having been printed.
            const check = readRecoveryKit(page) as { fingerprint: string };
            status.createEl("p", {
              text: `Reads back as account ${check.fingerprint}. Print this page.`,
            });
          } catch (e) {
            status.createEl("p", { text: `Cannot render a kit: ${message(e)}` });
          }
        }),
      );
  }
}
