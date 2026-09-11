// Two real Obsidian windows, a real relay, and a way to talk to both.
//
// Everything here is isolated: its own `--user-data-dir`, its own vaults under
// a temporary directory, its own relay on a port the OS hands out. It never
// touches the Obsidian you actually use, and running it while that Obsidian is
// open is fine — Electron's single-instance lock is per user-data directory.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..");
const ENGINE = join(REPO, "../opensync");
const APP = process.env.OBSIDIAN ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";

// Obsidian updates itself into its user-data directory, so a fresh profile
// downloads about 25 MB before it will start. Whatever it fetched is kept here
// between runs and copied into the next profile, which makes the check fast on
// a second run and identical on both.
const CACHE = join(tmpdir(), "opensync-obsidian-check-cache");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function awaitRelay(http, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(http, { headers: { Accept: "application/nostr+json" } });
      if (res.ok) return;
    } catch {
      // Connection refused is the retry signal, not a failure.
    }
    await sleep(100);
  }
  throw new Error(`no relay answered at ${http} within the timeout`);
}

/**
 * A vault on disk with this plugin installed, exactly as a user would have it:
 * the built files under `.obsidian/plugins/opensync`, and the plugin listed in
 * `community-plugins.json`. No `data.json` — the check configures it through
 * the settings pane, because settings that are only ever written by a test are
 * settings the pane has never been shown to write.
 */
function makeVault(root, name) {
  const vault = join(root, name);
  const dir = join(vault, ".obsidian/plugins/opensync");
  mkdirSync(dir, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    const from = join(REPO, file);
    if (existsSync(from)) cpSync(from, join(dir, file));
  }
  writeFileSync(join(vault, ".obsidian/community-plugins.json"), '["opensync"]');
  return vault;
}

/** The relay this account syncs through: one binary, one SQLite file, auth on. */
async function startRelay(root) {
  const bin = join(ENGINE, "target/release/opensync-relay");
  if (!existsSync(bin)) {
    throw new Error(
      `no relay at ${bin}\n` +
        "  Build it first: cargo build --release -p opensync-relay --manifest-path ../opensync/Cargo.toml",
    );
  }
  const dir = join(root, "relay");
  mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const config = join(dir, "relay.toml");
  writeFileSync(
    config,
    [
      `bind = "127.0.0.1:${port}"`,
      `data_dir = ${JSON.stringify(dir)}`,
      `database_url = ${JSON.stringify(`sqlite://${dir}/relay.db?mode=rwc`)}`,
      // Auth on, as in production. A check that skips the NIP-42 handshake has
      // not exercised the path every real client takes.
      "require_auth = true",
    ].join("\n"),
  );
  const child = spawn(bin, [config], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const http = `http://127.0.0.1:${port}`;
  try {
    await awaitRelay(http, Date.now() + 15_000);
  } catch (e) {
    child.kill();
    throw new Error(`${e.message}\nrelay said: ${stderr || "(nothing)"}`);
  }
  return { ws: `ws://127.0.0.1:${port}/`, http, stop: () => child.kill() };
}

/**
 * One Obsidian, on its own profile, with a vault already open and the debugger
 * listening. Obsidian asks whether it trusts the vault's author before it will
 * load a community plugin; the check answers that the way a person does,
 * because a profile that skipped it would not be testing plugin loading at all.
 */
async function launchObsidian(root, vault, name, port, extraArgs = []) {
  const profile = join(root, `profile-${name}`);
  mkdirSync(profile, { recursive: true });
  mkdirSync(CACHE, { recursive: true });
  for (const asar of readdirSync(CACHE)) cpSync(join(CACHE, asar), join(profile, asar));
  writeFileSync(
    join(profile, "obsidian.json"),
    JSON.stringify({ vaults: { [`${name}0000000000000000`.slice(0, 16)]: { path: vault, ts: Date.now(), open: true } } }),
  );

  if (!existsSync(APP)) throw new Error(`no Obsidian at ${APP} — set OBSIDIAN to its binary`);
  const child = spawn(
    APP,
    [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, ...extraArgs],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  let deadline = Date.now() + 120_000;
  let browser = null;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!browser) throw new Error(`${name}: Obsidian never opened a debugger on ${port}`);

  // The window that holds the app, not a popped-out settings window or a
  // devtools page — and the window holding *this* vault. An Obsidian left
  // over from an earlier run answers a debugger just as readily as the one
  // just started, and a run that attached to one silently drove the wrong
  // vault: five hundred notes that were already there, a publish that took
  // 176 ms, and numbers that looked like a triumph.
  let page = null;
  while (Date.now() < deadline) {
    for (const candidate of browser.contexts().flatMap((c) => c.pages())) {
      if (!candidate.url().startsWith("app://obsidian.md")) continue;
      const path = await candidate
        .evaluate(() => window.app?.vault?.adapter?.basePath ?? null)
        .catch(() => null);
      if (path && path.replace(/^\/private/, "") === vault.replace(/^\/private/, "")) { page = candidate; break; }
    }
    if (page) break;
    await sleep(500);
  }
  if (!page) throw new Error(`${name}: nothing on port ${port} is showing ${vault}`);
  deadline = Date.now() + 60_000;

  // "Do you trust the author of this vault?" — the gate in front of every
  // community plugin on a vault Obsidian has not seen before. It can appear a
  // beat after the window does, so this presses it until the plugin is up
  // rather than once and hopefully in time.
  while (Date.now() < deadline) {
    const loaded = await page.evaluate(() => {
      if (window.app?.plugins?.plugins?.opensync) return true;
      const button = [...document.querySelectorAll(".modal button")].find((b) => /trust/i.test(b.textContent));
      if (button) button.click();
      return false;
    });
    if (loaded) break;
    await sleep(500);
  }
  const up = await page.evaluate(() => Boolean(window.app?.plugins?.plugins?.opensync));
  if (!up) throw new Error(`${name}: Obsidian never loaded the plugin — is main.js built?`);

  return device(browser, page, child, profile, name);
}

/** Everything the check does to one vault, said in the vault's own vocabulary. */
function device(browser, page, child, profile, name) {
  // Kept from the moment the window opens, because the thing worth reading
  // after a hang is what the window was saying while it hung. A capture run
  // stalled twice on a first sync and left nothing behind but a timeout.
  const noise = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") noise.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => noise.push(`pageerror: ${e.message}`));

  // The settings pane, evaluated in the window rather than here: a function
  // defined out here does not travel into `page.evaluate`. Whichever tab
  // content is on screen — there is one per settings tab, and only the open
  // one is laid out.
  const PANE =
    '(() => { const all = [...document.querySelectorAll(".vertical-tab-content")];' +
    ' return all.find((e) => e.offsetParent !== null) ?? all[0] ?? document.body; })()';

  /**
   * The window the settings pane is in.
   *
   * Obsidian 1.13 moved settings into a window of its own — `about:blank`,
   * with no `window.app` in it. Before that it was a modal in the vault
   * window. The check reads the pane out of whichever one has it, so it keeps
   * working on both, and asks the vault window for everything else.
   */
  async function pane() {
    for (const candidate of browser.contexts().flatMap((c) => c.pages())) {
      const has = await candidate
        .evaluate(() => document.querySelectorAll(".vertical-tab-content").length > 0)
        .catch(() => false);
      if (has) return candidate;
    }
    return page;
  }

  const api = {
    name,
    page,
    version: () => page.evaluate(() => document.title.match(/Obsidian v?([\d.]+)/)?.[1] ?? "unknown"),
    eval: (fn, arg) => page.evaluate(fn, arg),
    files: () => page.evaluate(() => window.app.vault.getFiles().map((f) => f.path).sort()),
    read: (p) => page.evaluate((p) => window.app.vault.adapter.read(p), p),
    settings: () => page.evaluate(() => ({ ...window.app.plugins.plugins.opensync.settings })),
    state: () =>
      page.evaluate(() => {
        const p = window.app.plugins.plugins.opensync;
        return { pointer: p.pointer, baseEntries: Object.keys(p.base?.entries ?? {}).length };
      }),
    write: (p, text) =>
      page.evaluate(async ([p, text]) => {
        const file = window.app.vault.getAbstractFileByPath(p);
        if (file) return window.app.vault.modify(file, text);
        // The vault API does not make the folder for you; the plugin does,
        // on the receiving side, which is the path worth testing.
        const parent = p.split("/").slice(0, -1).join("/");
        if (parent && !window.app.vault.getAbstractFileByPath(parent)) {
          await window.app.vault.createFolder(parent);
        }
        await window.app.vault.create(p, text);
      }, [p, text]),
    writeBinary: (p, bytes) =>
      page.evaluate(async ([p, arr]) => {
        const parent = p.split("/").slice(0, -1).join("/");
        if (parent && !window.app.vault.getAbstractFileByPath(parent)) await window.app.vault.createFolder(parent);
        const buffer = new Uint8Array(arr).buffer;
        const file = window.app.vault.getAbstractFileByPath(p);
        if (file) await window.app.vault.modifyBinary(file, buffer);
        else await window.app.vault.createBinary(p, buffer);
      }, [p, [...bytes]]),
    readBinary: (p) =>
      page.evaluate(async (p) => {
        const file = window.app.vault.getAbstractFileByPath(p);
        return [...new Uint8Array(await window.app.vault.readBinary(file))];
      }, p),
    remove: (p) =>
      page.evaluate(async (p) => {
        await window.app.vault.delete(window.app.vault.getAbstractFileByPath(p));
      }, p),
    status: () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".status-bar-item")].map((e) => e.textContent).find((t) => t.startsWith("OpenSync")) ?? null,
      ),

    /**
     * A sync, plus whatever it logged. The plugin reports failures there.
     *
     * Waited out on both sides, because the plugin syncs on its own when a
     * vault opens and `sync()` returns immediately if one is already running.
     * Asking for a sync in that window read back as "syncing…" and looked
     * like a failure of the sync that had in fact just succeeded.
     */
    sync: async () => {
      await api.settle();
      const result = await page.evaluate(async () => {
        const errors = [];
        const original = console.error;
        console.error = (...args) => {
          errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
          original(...args);
        };
        try {
          await window.app.plugins.plugins.opensync.sync(true);
        } finally {
          console.error = original;
        }
        return {
          errors,
          status: [...document.querySelectorAll(".status-bar-item")].map((e) => e.textContent).find((t) => t.startsWith("OpenSync")) ?? null,
        };
      });
      return { ...result, status: (await api.settle()) ?? result.status };
    },

    /** Wait until the plugin is not mid-sync, and say what it settled on. */
    settle: async (timeoutMs = 90_000) => {
      const deadline = Date.now() + timeoutMs;
      let status = await api.status();
      while (Date.now() < deadline && /syncing/.test(status ?? "")) {
        await sleep(200);
        status = await api.status();
      }
      return status;
    },

    /** Open this plugin's settings pane and list what it offers. */
    openSettings: async () => {
      await page.evaluate(() => {
        window.app.setting.open();
        window.app.setting.openTabById("opensync");
      });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const where = await pane();
        const found = await where
          .evaluate((pane) => {
            const el = eval(pane);
            const names = [...el.querySelectorAll(".setting-item:not(.setting-item-heading) .setting-item-name")].map(
              (e) => e.textContent,
            );
            if (!names.includes("Relay address")) return null;
            return {
              // Headings are settings too, in the DOM. They are not what the
              // pane offers, so they are not counted among what it offers.
              heading: el.querySelector(".setting-item-heading .setting-item-name, h3")?.textContent ?? null,
              names,
            };
          }, PANE)
          .catch(() => null);
        if (found) return found;
        await sleep(300);
      }
      throw new Error(`${name}: the settings pane never showed this plugin`);
    },

    /** Type into the text field of a named setting, as a person would. */
    type: async (setting, value) =>
      (await pane()).evaluate(async ([pane, setting, value]) => {
        const item = [...eval(pane).querySelectorAll(".setting-item")].find(
          (e) => e.querySelector(".setting-item-name")?.textContent === setting,
        );
        if (!item) throw new Error(`no setting called ${setting}`);
        const input = item.querySelector("input[type=text]");
        input.value = value;
        input.dispatchEvent(new Event("input"));
        await new Promise((r) => setTimeout(r, 200));
      }, [PANE, setting, value]),

    /** Press the button of a named setting. Not awaited past the click: some
     *  of these wait on another device answering. */
    press: async (setting, label) =>
      (await pane()).evaluate(([pane, setting, label]) => {
        const item = [...eval(pane).querySelectorAll(".setting-item")].find(
          (e) => e.querySelector(".setting-item-name")?.textContent === setting,
        );
        if (!item) throw new Error(`no setting called ${setting}`);
        const buttons = [...item.querySelectorAll("button")];
        const button = label ? buttons.find((b) => b.textContent === label) : buttons[0];
        if (!button) throw new Error(`no button ${label ?? ""} on ${setting}`);
        const text = button.textContent;
        button.click();
        return text;
      }, [PANE, setting, label]),

    /** Flip the switch of a named setting. */
    toggle: async (setting) =>
      (await pane()).evaluate(([pane, setting]) => {
        const item = [...eval(pane).querySelectorAll(".setting-item")].find(
          (e) => e.querySelector(".setting-item-name")?.textContent === setting,
        );
        if (!item) throw new Error(`no setting called ${setting}`);
        item.querySelector(".checkbox-container").click();
      }, [PANE, setting]),

    /** What a named setting's button says right now. */
    buttonLabel: async (setting) =>
      (await pane()).evaluate(([pane, setting]) => {
        const item = [...eval(pane).querySelectorAll(".setting-item")].find(
          (e) => e.querySelector(".setting-item-name")?.textContent === setting,
        );
        return item?.querySelector("button")?.textContent ?? null;
      }, [PANE, setting]),

    /** What the pane is currently saying below the buttons. */
    pairingBox: async () =>
      (await pane()).evaluate(() => {
        const box = document.querySelector(".opensync-pairing");
        if (!box) return null;
        const canvas = box.querySelector("canvas");
        return {
          lines: [...box.querySelectorAll("p")].map((e) => e.textContent),
          // Some of what the pane says is set with `setText`, which leaves no
          // element to read it out of.
          text: box.textContent,
          pre: box.querySelector("pre")?.textContent ?? null,
          qr: canvas
            ? (() => {
                const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
                let dark = 0;
                for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark += 1;
                return { width: canvas.width, height: canvas.height, dark };
              })()
            : null,
        };
      }),

    /** Poll the pane until it says something, so a slow relay is not a failure. */
    waitForLine: async (re, timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const box = await api.pairingBox();
        const line = box?.lines.find((l) => re.test(l));
        if (line) return line;
        await sleep(300);
      }
      const box = await api.pairingBox();
      throw new Error(`nothing matched ${re} in ${JSON.stringify(box?.lines ?? [])}`);
    },

    closeSettings: () => page.evaluate(() => window.app.setting.close()),

    /**
     * What this window has been complaining about, and what it is doing now.
     * For printing when something times out — a stalled sync says nothing on
     * its own, and the status bar is the only place it admits to being stuck.
     */
    async diagnose() {
      const state = await page
        .evaluate(() => {
          const p = window.app?.plugins?.plugins?.opensync;
          return {
            status:
              [...document.querySelectorAll(".status-bar-item")]
                .map((e) => e.textContent)
                .find((t) => t.startsWith("OpenSync")) ?? null,
            running: p?.running ?? null,
            generation: p?.pointer?.generation ?? null,
            files: window.app?.vault?.getFiles().length ?? null,
          };
        })
        .catch((e) => ({ unreachable: e.message }));
      return { name, ...state, noise: noise.slice(-12) };
    },

    /** Run something in the window the settings pane is in. */
    paneEval: async (fn, arg) => (await pane()).evaluate(fn, arg),

    /** Photograph the vault window. */
    shot: (file) => page.screenshot({ path: file }),

    /**
     * Photograph whichever window the settings pane is in.
     *
     * Obsidian 1.13 gives settings a window of its own, which opens at its own
     * size; the same metrics override makes those shots one shape too.
     */
    shotPane: async (file, width = 1100, height = 860) => {
      const where = await pane();
      if (where !== page) await api.resize(width, height, where);
      await sleep(400);
      return where.screenshot({ path: file });
    },

    /** Open a note in the editor, so a screenshot shows the app in use. */
    open: (path) =>
      page.evaluate(async (path) => {
        const file = window.app.vault.getAbstractFileByPath(path);
        if (file) await window.app.workspace.getLeaf().openFile(file);
      }, path),

    /** Light or dark, for the second pass of screenshots. */
    theme: async (which) => {
      await page.evaluate((which) => window.app.changeTheme(which === "dark" ? "obsidian" : "moonstone"), which);
      await sleep(600);
    },

    /**
     * Lay the window out at a known size, so every screenshot is the same
     * shape whatever the screen is.
     *
     * Through the renderer's metrics rather than the window's: Electron does
     * not carry `Browser.setWindowBounds`, and a screenshot is of the page in
     * any case. `deviceScaleFactor: 2` is what makes the text sharp.
     */
    async resize(width, height, target = page) {
      const cdp = await target.context().newCDPSession(target);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await sleep(600);
    },


    /** Shut the window and keep the asar it downloaded, for the next run. */
    async quit() {
      await browser.close().catch(() => undefined);
      child.kill();
      await sleep(2000);
      for (const file of readdirSync(profile)) {
        if (file.endsWith(".asar") && !existsSync(join(CACHE, file))) cpSync(join(profile, file), join(CACHE, file));
      }
    },
  };
  return api;
}

export async function environment() {
  const root = mkdtempSync(join(tmpdir(), "opensync-obsidian-check-"));
  const relay = await startRelay(root);
  const devices = [];
  const env = {
    root,
    relay,
    async open(name, port, extraArgs = []) {
      // Whatever the OS hands out, never a fixed number: a fixed one is how a
      // run attaches to the last run's window.
      port = port ?? (await freePort());
      const vault = makeVault(root, name);
      const d = await launchObsidian(root, vault, name, port, extraArgs);
      d.vault = vault;
      d.port = port;
      devices.push(d);
      return d;
    },
    /** Close a window and open it again on the same vault: a restart. */
    async restart(d) {
      await d.quit();
      const port = await freePort();
      const back = await launchObsidian(root, d.vault, d.name, port);
      back.vault = d.vault;
      back.port = port;
      devices[devices.indexOf(d)] = back;
      return back;
    },
    async stop(keep) {
      for (const d of devices) await d.quit().catch(() => undefined);
      relay.stop();
      if (!keep) rmSync(root, { recursive: true, force: true });
      else console.log(`\nkept everything under ${root}`);
    },
  };
  return env;
}

let failures = 0;
export function ok(condition, message) {
  console.log(`${condition ? "  ok  " : " FAIL "} ${message}`);
  if (!condition) failures += 1;
  return condition;
}
export const failed = () => failures;
