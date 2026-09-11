import {
  App,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from "obsidian";

import {
  endpointsFor,
  generateAccountKey,
  drawInvitation,
  grantAccount,
  Invitation,
  joinAccount,
  Namespace,
  PairingCode,
  parseAccountKey,
  QuotaError,
  readRecoveryKit,
  ready,
  Relay,
  renderRecoveryKit,
  Signer,
} from "../../opensync/packages/client/src";

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
const HOSTED_RELAY = "";

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
}

// Loopback is a fine default on a desktop, where the relay is often on the
// same machine. On a phone it is never right — 127.0.0.1 is the phone — and
// shipping it as a default just produces a connection error that points at
// the wrong thing.
const DEFAULTS: OpenSyncSettings = {
  relayWs: Platform.isMobile ? "" : "ws://127.0.0.1:4848/",
  relayHttp: Platform.isMobile ? "" : "http://127.0.0.1:4848",
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
  private running = false;
  private dirty = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Instantiated from an inlined module, so there is nothing to fetch and
    // the same path works on desktop and mobile.
    await ready();

    this.status = this.addStatusBarItem();
    this.setStatus("idle");

    this.addSettingTab(new OpenSyncSettingTab(this.app, this));
    this.addCommand({
      id: "opensync-sync-now",
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
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULTS, stored);
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
  }

  private setStatus(text: string): void {
    this.status?.setText(`OpenSync: ${text}`);
  }

  private ready(): { ns: Namespace; relay: Relay } | null {
    if (!this.settings.namespaceKey || !this.settings.accountSecret) return null;
    try {
      if (!this.ns) this.ns = new Namespace(this.settings.namespaceKey);
      if (!this.relay) {
        this.relay = new Relay(
          this.settings.relayWs,
          this.settings.relayHttp.replace(/\/$/, ""),
          // The settings field holds `nsec1…` — that is what the Generate
          // button writes and what the description asks for — so it is
          // decoded here. Handing the bech32 string straight to `fromHex`
          // throws on the very first sync, which is what this used to do.
          Signer.fromHex(parseAccountKey(this.settings.accountSecret)),
        );
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
    const ctx = this.ready();
    if (!ctx) throw new Error("set a relay, an account key and a vault key first");
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

      const fresh = this.ready();
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
      const commit: Commit = fresh.ns.commit(
        1n,
        BigInt(Math.floor(Date.now() / 1000)),
        this.settings.deviceLabel,
        this.scope,
      );
      await this.publish(fresh.relay, commit);
      this.base = fresh.ns.openManifest(
        commit.blobs.find((b) => b.id === commit.root)!.bytes,
      );
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
      return key;
    } finally {
      this.running = false;
    }
  }

  async sync(interactive: boolean): Promise<void> {
    if (this.running) return;
    const ctx = this.ready();
    if (!ctx) {
      if (interactive) new Notice("OpenSync: set a relay, an account key and a vault key first.");
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
    const commit: Commit = ns.commit(
      BigInt(generation),
      BigInt(Math.floor(Date.now() / 1000)),
      this.settings.deviceLabel,
      this.scope,
    );
    const ours: ManifestJson = ns.openManifest(
      commit.blobs.find((b) => b.id === commit.root)!.bytes,
    );

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

    const incoming: Pointer = ns.openPointer(remoteHex);
    const theirsSealed = await relay.getBlob(incoming.root);
    if (!theirsSealed) throw new Error("the relay is advertising a manifest it does not hold");
    const theirs: ManifestJson = ns.openManifest(theirsSealed);

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
    );

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
    const republish: Commit = ns.commit(
      BigInt(incoming.generation + 1),
      BigInt(Math.floor(Date.now() / 1000)),
      this.settings.deviceLabel,
      this.scope,
    );
    await this.publish(relay, republish);
    this.base = ns.openManifest(republish.blobs.find((b) => b.id === republish.root)!.bytes);
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
    await this.saveData({
      ...this.settings,
      _pointer: this.pointer,
      _base: this.base,
    });
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
            "Images, PDFs and audio are what actually cost storage to keep, so they are part of the paid plan. " +
            "Nothing is deleted either way — an attachment simply stays on the device it is on.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.carriesAttachments)
          .setDisabled(!supporter)
          .onChange(async (v) => {
            this.plugin.settings.syncAttachments = v;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (!supporter && held.length > 0) {
      // Said out loud rather than discovered. A file that silently does not
      // sync is indistinguishable from a file that failed to sync, and the
      // second one is the bug report.
      const note = containerEl.createEl("div", { cls: "opensync-pairing" });
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
    const status = containerEl.createEl("div", { cls: "opensync-pairing" });
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
