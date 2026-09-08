// The screenshots, taken from the running application.
//
// Same harness as the check, same relay, same built plugin: every image here
// is a photograph of a state the app actually reached, in the order a person
// reaches them. Nothing is mocked and nothing is drawn.
//
//   npm run build && node checks/capture.mjs docs/screenshots
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { environment, sleep } from "./harness.mjs";

const out = process.argv[2] ?? "docs/screenshots";
mkdirSync(out, { recursive: true });
const shot = (n, name) => join(out, `${String(n).padStart(2, "0")}-${name}.png`);
const timings = {};

// Written as it happens rather than at the end. A capture run drives two
// applications and can block inside either; a log that only appears on exit
// says nothing about where it stopped.
const logFile = join(out, "capture.log");
writeFileSync(logFile, "");
const started = Date.now();
function say(line) {
  const stamp = `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s  ${line}`;
  appendFileSync(logFile, `${stamp}\n`);
  console.log(stamp);
}

/** Every step is bounded: a hang should name itself, not stall the run. */
async function step(name, fn, ms = 120_000) {
  const at = Date.now();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); }),
    ]);
    say(`${name} — ${Date.now() - at} ms`);
    return result;
  } catch (e) {
    say(`${name} — FAILED: ${e.message}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const env = await environment();
try {
  const A = await env.open("vaultA");
  const B = await env.open("vaultB");
  for (const d of [A, B]) await d.resize(1440, 900);
  say(`Obsidian ${await A.version()}, relay ${env.relay.ws}`);

  // ---- 01 what a new install looks like ------------------------------------
  await step("01 the pane a new install shows", async () => {
    await A.openSettings();
    await A.shotPane(shot(1, "setup"));
  });

  // ---- 02 configured, with keys this device made ---------------------------
  await A.type("Relay address", env.relay.ws);
  await A.type("Storage address", env.relay.http);
  await A.press("Vault key", "Generate");
  await sleep(300);
  await A.press("Account key", "Generate");
  await sleep(600);
  await A.shotPane(shot(2, "keys"));
  await A.closeSettings();

  // A vault worth photographing.
  await A.write("Welcome.md", [
    "# Welcome",
    "",
    "This vault syncs through a relay that cannot read it. The files are split",
    "into chunks, each chunk is sealed on this device, and what the server",
    "stores is ciphertext addressed by the hash of the ciphertext.",
    "",
    "- Markdown is unlimited and free.",
    "- Attachments are the tier that costs storage, so they are opt-in.",
    "- Point it at a relay you run yourself and there is no tier at all.",
    "",
    "See [[Pairing]] for how a second device gets the key.",
  ].join("\n"));
  await A.write("Pairing.md", [
    "# Pairing",
    "",
    "The vault key is never displayed and never typed. Ten characters are.",
    "",
    "The code goes over a SPAKE2 exchange, so the relay in the middle carries",
    "ciphertext and an attacker on the wire at that moment gets exactly one",
    "guess. Answering a code spends it, right or wrong.",
  ].join("\n"));
  await A.write("Notes/Merge rules.md", [
    "# Merge rules",
    "",
    "Whole-file last-writer-wins, with a conflict copy rather than a loss.",
    "Ordering comes from a generation counter, never from a timestamp: the",
    "clock is set by the client and can lie.",
  ].join("\n"));
  await step("03 a vault, published", async () => {
    await A.sync();
    await A.open("Welcome.md");
    await sleep(1000);
    await A.shot(shot(3, "vault"));
  });

  // ---- 04 the pairing screen -----------------------------------------------
  await A.openSettings();
  await A.press("Add a device", "Show a code");
  await A.waitForLine(/^code /);
  await sleep(400);
  await A.shotPane(shot(4, "pairing"));
  const box = await A.pairingBox();
  const invite = box.lines.find((l) => l.startsWith("opensync://"));
  const code = box.lines.find((l) => l.startsWith("code")).replace(/^code\s+/, "").trim();
  say(`pairing code ${code}`);

  // ---- 05 the joining device -----------------------------------------------
  await B.openSettings();
  await B.type("Join from a code", invite);
  await B.press("Join from a code", "Join");
  const joinStart = Date.now();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !(await B.settings()).namespaceKey) await sleep(300);
  timings.pair = Date.now() - joinStart;
  await sleep(800);
  await B.shotPane(shot(5, "joined"));
  await B.closeSettings();
  await A.closeSettings();

  // ---- 06 the vault, on the device that just joined -------------------------
  const pullStart = Date.now();
  await step("06 the joining device fetches the vault", () => B.sync());
  timings.bootstrap = Date.now() - pullStart;
  await B.open("Welcome.md");
  await sleep(1200);
  await B.shot(shot(6, "arrived"));
  say(`bootstrap ${timings.bootstrap} ms for ${(await B.files()).length} files`);

  // ---- 07 a fork, kept rather than resolved --------------------------------
  await A.write("Pairing.md", "# Pairing\n\nRewritten on A: one code, one device, one attempt.\n");
  await B.write("Pairing.md", "# Pairing\n\nRewritten on B: the relay never sees the code.\n");
  await A.sync();
  await B.sync();
  await A.sync();
  const copy = (await B.files()).find((f) => f.startsWith("Pairing (conflict"));
  await B.open(copy);
  await sleep(1200);
  await B.shot(shot(7, "conflict"));
  say(`conflict copy: ${copy}`);

  // ---- 08 the page to print -------------------------------------------------
  await A.openSettings();
  await A.press("Recovery kit", "Show it");
  await A.waitForLine(/Reads back as account/);
  await sleep(400);
  await A.shotPane(shot(8, "kit"));

  // ---- 09 rotation, and the report that now survives its own re-render ------
  await A.press("Rotate the vault key", "Rotate");
  await sleep(400);
  await A.press("Rotate the vault key");
  await A.waitForLine(/Use "Add a device"/, 90_000);
  await sleep(400);
  await A.shotPane(shot(9, "rotation"));
  await A.closeSettings();

  // Put B back in step, so the scale pass has two devices again.
  await A.openSettings();
  await A.press("Add a device", "Show a code");
  await A.waitForLine(/^code /);
  const second = (await A.pairingBox()).lines.find((l) => l.startsWith("opensync://"));
  await B.eval(async () => {
    const p = window.app.plugins.plugins.opensync;
    p.settings.namespaceKey = "";
    p.settings.accountSecret = "";
    await p.saveSettings();
  });
  await B.openSettings();
  await B.type("Join from a code", second);
  await B.press("Join from a code", "Join");
  const rejoin = Date.now() + 60_000;
  while (Date.now() < rejoin && !(await B.settings()).namespaceKey) await sleep(300);
  await B.closeSettings();
  await A.closeSettings();
  await B.sync();

  // ---- 10 a vault with something in it --------------------------------------
  const N = 500;
  const made = await A.eval(async (n) => {
    const started = performance.now();
    if (!window.app.vault.getAbstractFileByPath("Archive")) await window.app.vault.createFolder("Archive");
    const words = "sealed chunk manifest pointer generation relay blossom nostr envelope namespace".split(" ");
    for (let i = 0; i < n; i += 1) {
      const body = Array.from({ length: 40 }, (_, k) => words[(i + k) % words.length]).join(" ");
      const path = `Archive/Note ${String(i + 1).padStart(4, "0")}.md`;
      if (!window.app.vault.getAbstractFileByPath(path)) {
        await window.app.vault.create(path, `# Note ${i + 1}\n\n${body}\n\n${body}\n`);
      }
    }
    return { ms: Math.round(performance.now() - started), files: window.app.vault.getFiles().length };
  }, N);
  say(`wrote ${N} notes in ${made.ms} ms, ${made.files} files in the vault`);

  const pubStart = Date.now();
  await A.sync();
  timings.publish = Date.now() - pubStart;
  const fetchStart = Date.now();
  await B.sync();
  timings.fetch = Date.now() - fetchStart;
  timings.files = (await B.files()).length;
  say(`published ${timings.files} files in ${timings.publish} ms; the other device fetched them in ${timings.fetch} ms`);

  // On the device that received them, not the one that wrote them: a file
  // tree full of notes proves nothing about sync if it is photographed on the
  // machine that typed them.
  await B.open("Welcome.md");
  await step("10 the vault at scale, on the device it arrived at", async () => {
    // Expanded, or the folder holding five hundred notes is one grey row and
    // the screenshot of a full vault looks exactly like the screenshot of an
    // empty one.
    await B.eval(async () => {
      const explorer = window.app.workspace.getLeavesOfType("file-explorer")[0]?.view;
      const item = explorer?.fileItems?.["Archive"];
      if (item?.setCollapsed) await item.setCollapsed(false);
    });
    await B.page.waitForFunction(
      () => document.querySelectorAll(".nav-file-title").length > 20,
      null,
      { timeout: 20_000 },
    );
    await sleep(800);
    await B.shot(shot(10, "scale"));
  }, 60_000);

  // ---- 11 the app's own count of what arrived -------------------------------
  await step("11 search across the synced vault", async () => {
    const found = await B.eval(async () => {
      const search = window.app.internalPlugins.getPluginById("global-search");
      await search.instance.openGlobalSearch("manifest pointer generation");
      return true;
    });
    if (found) {
      await B.page.waitForFunction(
        () => /\d/.test(document.querySelector(".search-result-count, .search-results-info")?.textContent ?? ""),
        null,
        { timeout: 30_000 },
      ).catch(() => undefined);
      await sleep(1200);
    }
    await B.shot(shot(11, "search"));
  }, 60_000);

  // ---- 12 the same thing, dark ----------------------------------------------
  await step("12 the same vault, dark", async () => {
    await A.theme("dark");
    await sleep(800);
    await A.shot(shot(12, "dark"));
  }, 60_000);
  await step("13 the pane, dark", async () => {
    await A.openSettings();
    await sleep(600);
    await A.shotPane(shot(13, "dark-settings"));
  }, 60_000);
  await step("close the pane", () => A.closeSettings(), 30_000);
  await step("back to light", () => A.theme("light"), 30_000);

  // ---- what the relay is holding --------------------------------------------
  // The claim the whole product rests on, checked where it can be checked: the
  // server's own storage, searched for words that are in every note on both
  // devices. A hit here would mean plaintext left the device.
  const relayDir = join(env.root, "relay");
  // Words from the notes, a path from the vault, and a token that exists
  // nowhere else in the world — written into a note and synced a moment ago,
  // so a relay that stored plaintext would be holding this exact string.
  const token = `canary-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await A.write("Canary.md", `# Canary\n\n${token}\n`);
  await A.sync();
  await B.sync();
  const needles = [token, "Welcome", "sealed chunk manifest", "SPAKE2", "Merge rules", "Archive/Note 0007"];
  let files = 0;
  let bytes = 0;
  let hits = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      files += 1;
      bytes += statSync(full).size;
      const text = readFileSync(full).toString("latin1");
      for (const needle of needles) if (text.includes(needle)) hits += 1;
    }
  };
  await step("search the relay's own storage for plaintext", () => walk(relayDir), 120_000);
  say(`relay holds ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${hits} plaintext hits (searched for ${needles.length} strings incl. ${token})`);
  const summary = { ...timings, relay: { files, bytes, hits, searched: needles.length, token } };
  writeFileSync(join(out, "capture.json"), `${JSON.stringify(summary, null, 2)}\n`);
  say(JSON.stringify(summary));
} finally {
  await env.stop(false);
}
console.log(`\nscreenshots in ${out}`);
