// The plugin, inside Obsidian.
//
// Everything else about this product is proved by a test that stands in for
// the application: `opensync/checks/plugincheck.ts` mirrors `runSync()` line
// for line, and the Rust suite proves the protocol underneath it. Neither can
// say whether Obsidian loads the plugin, whether the settings pane renders,
// whether a QR appears on a canvas, or whether the vault API writes the file
// where the manifest says it goes. This one drives the application.
//
//   npm run build && npm run check:obsidian
//
// It wants a relay binary from the engine beside this repository:
//   cargo build --release -p opensync-relay --manifest-path ../opensync/Cargo.toml
import { environment, failed, ok, sleep } from "./harness.mjs";

const env = await environment();
const keep = process.argv.includes("--keep");

try {
  console.log(`relay ${env.relay.ws}`);
  let A = await env.open("vaultA", 9333);
  let B = await env.open("vaultB", 9334);
  console.log(`Obsidian ${await A.version()}, two vaults\n`);

  // ---- it loads at all -----------------------------------------------------
  for (const d of [A, B]) {
    const loaded = await d.eval(() => Object.keys(window.app.plugins.plugins));
    ok(loaded.includes("opensync"), `${d.name}: Obsidian loads the plugin (${JSON.stringify(loaded)})`);
  }
  ok((await A.status())?.startsWith("OpenSync"), `a status bar item appears (${await A.status()})`);

  // ---- setting it up, through the pane -------------------------------------
  const pane = await A.openSettings();
  ok(pane.heading === "Set up", `a vault with no keys leads with setting up (${pane.heading})`);
  ok(pane.names[0] === "Join from a code", `and offers joining before the key fields (${JSON.stringify(pane.names.slice(0, 3))})`);

  await A.type("Relay address", env.relay.ws);
  await A.type("Storage address", env.relay.http);
  await A.press("Vault key", "Generate");
  await sleep(300);
  await A.press("Account key", "Generate");
  await sleep(500);
  const keysA = await A.settings();
  ok(keysA.namespaceKey.startsWith("ovault1"), `Generate writes a vault key (${keysA.namespaceKey.slice(0, 12)}…)`);
  ok(keysA.accountSecret.startsWith("nsec1"), `Generate writes an account key (${keysA.accountSecret.slice(0, 10)}…)`);
  const stored = JSON.parse(await A.read(".obsidian/plugins/opensync/data.json"));
  ok(stored.namespaceKey === keysA.namespaceKey && stored.relayWs === env.relay.ws,
     "settings reach data.json, so a restart keeps them");

  // ---- the first sync ------------------------------------------------------
  await A.closeSettings();
  await A.write("hello.md", "# Hello from A\n\nline one\n");
  const first = await A.sync();
  ok(first.errors.length === 0 && first.status === "OpenSync: up to date",
     `A publishes a vault (${first.status}${first.errors.length ? " " + JSON.stringify(first.errors) : ""})`);

  // ---- pairing: ten characters, read off A's pane ---------------------------
  await A.openSettings();
  await A.press("Add a device", "Show a code");
  await A.waitForLine(/^code /);
  const shown = await A.pairingBox();
  const code = shown.lines.find((l) => l.startsWith("code")).replace(/^code\s+/, "").trim();
  ok(/^[a-z0-9]{4}-[a-z0-9]{6}$/.test(code), `a ten-character code is shown (${code})`);
  ok(shown.qr && shown.qr.width > 100 && shown.qr.dark > 500,
     `a QR is drawn on a canvas, with modules in it (${JSON.stringify(shown.qr)})`);
  ok(shown.lines.some((l) => /this machine/.test(l)),
     "a loopback relay address is called out as unreachable from the joining device");

  const invite = shown.lines.find((l) => l.startsWith("opensync://"));
  ok(invite?.includes(code.replace("-", "")) || invite?.includes(code),
     `the same pairing is offered as one line to paste (${invite})`);

  // Ten characters and no relay address is the state a fresh phone is in. It
  // used to spend two minutes asking nobody; it should say so at once.
  await B.openSettings();
  await B.type("Relay address", "");
  await B.type("Join from a code", code);
  await B.press("Join from a code", "Join");
  await sleep(1500);
  const refused = await B.pairingBox();
  ok(/Fill in the relay address/.test(refused?.text ?? ""),
     `a code with nowhere to send it is refused immediately (${JSON.stringify(refused?.text ?? "")})`);

  // The pasted line, which carries the relay with it. This is the path the
  // pane now leads with, and the one a second computer has to take: it cannot
  // point a camera at the screen showing the QR.
  await B.type("Join from a code", invite);
  await B.press("Join from a code", "Join");
  const deadline = Date.now() + 60_000;
  let keysB = await B.settings();
  while (Date.now() < deadline && !(keysB.namespaceKey && keysB.accountSecret)) {
    await sleep(500);
    keysB = await B.settings();
  }
  ok(keysB.namespaceKey === keysA.namespaceKey && keysB.accountSecret === keysA.accountSecret,
     "B holds A's keys after one pasted line");
  ok(keysB.relayWs === env.relay.ws && keysB.relayHttp === env.relay.http,
     `the pasted line carried the relay address B never typed (${keysB.relayWs})`);
  ok(/that device now has this account/i.test(await A.waitForLine(/device now has this account/i)),
     "A says the grant finished");
  await A.closeSettings();
  await B.closeSettings();

  // ---- and the point of pairing: reading what was written before it ---------
  const pulled = await B.sync();
  ok(pulled.errors.length === 0, `B syncs cleanly${pulled.errors.length ? " " + JSON.stringify(pulled.errors) : ""}`);
  ok(await B.read("hello.md") === "# Hello from A\n\nline one\n",
     "B reads a note written before it had any keys, verbatim");

  // ---- an ordinary edit ----------------------------------------------------
  await A.write("hello.md", "# Hello from A\n\nline one\nline two\n");
  await A.sync();
  await B.sync();
  ok(await B.read("hello.md") === "# Hello from A\n\nline one\nline two\n", "an edit on A reaches B");
  const strays = (await B.files()).filter((p) => p.includes("conflict"));
  ok(strays.length === 0, `an ordinary update makes no conflict copy (${JSON.stringify(strays)})`);

  // ---- an attachment, which is the tier that costs money --------------------
  // Off by default, and that is the product: markdown is unlimited, and the
  // thing that fills a disk is the thing you have to ask for.
  const png = [137, 80, 78, 71, 13, 10, 26, 10, ...Array.from({ length: 4096 }, (_, i) => (i * 31) % 256)];
  await A.writeBinary("assets/pic.png", png);
  await A.sync();
  await B.sync();
  ok(!(await B.files()).includes("assets/pic.png"), "an attachment stays put while attachments are off");

  await A.openSettings();
  await A.toggle("Sync attachments");
  await A.closeSettings();
  ok((await A.settings()).syncAttachments === true, "the attachment switch flips");
  await A.sync();
  await B.openSettings();
  await B.toggle("Sync attachments");
  await B.closeSettings();
  await B.sync();
  const arrived = await B.readBinary("assets/pic.png").catch(() => null);
  ok(arrived && arrived.length === png.length && arrived.every((v, i) => v === png[i]),
     `a binary attachment then arrives byte-identical, in a folder B did not have (${arrived?.length ?? "missing"} bytes)`);

  // ---- a delete -------------------------------------------------------------
  await A.remove("assets/pic.png");
  await A.sync();
  await B.sync();
  ok(!(await B.files()).includes("assets/pic.png"), "a delete on A removes the file on B");

  // ---- a real fork ---------------------------------------------------------
  await A.write("shared.md", "seed\n");
  await A.sync();
  await B.sync();
  ok(await B.read("shared.md") === "seed\n", "both devices agree before diverging");
  await A.write("shared.md", "seed\nA was here\n");
  await B.write("shared.md", "seed\nB was here\n");
  await A.sync();
  await B.sync();
  await A.sync();
  const copies = (await B.files()).filter((p) => p.startsWith("shared (conflict"));
  ok(copies.length === 1, `a fork produces one conflict copy (${JSON.stringify(copies)})`);
  // Named after the vault that made it. Both devices used to ship the same
  // default label, so both sides of a fork were "from This device".
  ok(copies[0]?.includes("from vaultB"), `and it names the vault it came from (${copies[0]})`);
  const kept = await Promise.all(["shared.md", ...copies].map((p) => B.read(p)));
  ok(kept.some((t) => t.includes("A was here")) && kept.some((t) => t.includes("B was here")),
     `neither side is lost (${JSON.stringify(kept)})`);
  await B.sync();
  await A.sync();
  ok((await A.files()).filter((p) => p.startsWith("shared (conflict")).length === 1,
     "the conflict copy converges back to A");

  // ---- doing it again does nothing -----------------------------------------
  const before = await B.files();
  await B.sync();
  await B.sync();
  ok(JSON.stringify(await B.files()) === JSON.stringify(before),
     `repeat syncs are inert (${JSON.stringify((await B.files()).filter((f) => !before.includes(f)))})`);

  // ---- the recovery kit ----------------------------------------------------
  await A.openSettings();
  await A.press("Recovery kit", "Show it");
  await A.waitForLine(/Reads back as account/);
  const kit = await A.pairingBox();
  // Printed in groups, so it can be typed back by a person. Both keys are
  // there, in the only sense that matters: the letters, in order.
  const printed = kit.pre?.replace(/\s+/g, "") ?? "";
  ok(printed.includes(keysA.namespaceKey) && printed.includes(keysA.accountSecret),
     "the recovery kit prints both keys");
  ok(kit.lines.some((l) => /Reads back as account/.test(l)),
     `the kit is parsed back in the app that printed it (${JSON.stringify(kit.lines)})`);
  await A.closeSettings();

  // ---- a restart -----------------------------------------------------------
  const filesBefore = await A.files();
  A = await env.restart(A);
  const state = await A.state();
  ok(state.pointer?.generation > 0, `the pointer survives a restart (generation ${state.pointer?.generation})`);
  ok(state.baseEntries === filesBefore.length, `the merge base survives a restart (${state.baseEntries} entries)`);
  const afterRestart = await A.sync();
  ok(JSON.stringify(await A.files()) === JSON.stringify(filesBefore),
     `a sync after a restart invents nothing (${JSON.stringify((await A.files()).filter((f) => !filesBefore.includes(f)))})`);
  ok(afterRestart.status === "OpenSync: up to date", `and reports itself up to date (${afterRestart.status})`);

  // ---- rotation ------------------------------------------------------------
  const bFilesBefore = await B.files();
  await A.openSettings();
  const armed = await A.press("Rotate the vault key", "Rotate");
  await sleep(400);
  const warning = await A.pairingBox();
  const armedLabel = await A.buttonLabel("Rotate the vault key");
  ok(/press again/i.test(armedLabel ?? ""), `rotation takes two presses (was "${armed}", now "${armedLabel}")`);
  ok(warning.lines.some((l) => /clipboard or a password store/.test(l)),
     "the first press says one key can cover other apps this one cannot reach");
  await A.press("Rotate the vault key");
  // Read *after* the pane has rebuilt itself around the new key. Rotation used
  // to report into a box that the rebuild emptied, so the screen went blank on
  // the one operation that cannot be undone.
  await A.waitForLine(/Use "Add a device"/, 90_000);
  const rotation = await A.pairingBox();
  ok(rotation.lines.some((l) => /Published \d+ files? under the new key/.test(l)),
     `the whole vault is republished, and it still says so afterwards (${JSON.stringify(rotation.lines)})`);
  ok(rotation.lines.some((l) => /^Swept/.test(l)), "the blobs the old key addressed are swept");
  ok(await A.buttonLabel("Vault key") === "Generate" && (await A.pairingBox()).lines.length >= 3,
     "the pane shows the new key and the report of how it got there at once");
  const rotated = await A.settings();
  ok(rotated.namespaceKey !== keysA.namespaceKey && rotated.namespaceKey.startsWith("ovault1"), "the vault key changed");
  ok((await A.state()).pointer?.generation === 1, "the new history starts at generation 1");
  await A.closeSettings();
  const afterRotate = await A.sync();
  ok(afterRotate.status === "OpenSync: up to date" && afterRotate.errors.length === 0,
     `A syncs cleanly under the new key (${afterRotate.status})`);

  // B still holds the old key, and must fail rather than be quietly wrong.
  const lockedOut = await B.sync();
  ok(lockedOut.status === "OpenSync: error", `an un-paired device is locked out (${lockedOut.status})`);
  ok(JSON.stringify(await B.files()) === JSON.stringify(bFilesBefore),
     "and loses nothing of its own while locked out");

  // Re-pairing is the whole cost of rotating, so it has to work afterwards.
  await A.openSettings();
  await A.press("Add a device", "Show a code");
  await A.waitForLine(/^code /);
  const second = (await A.pairingBox()).lines.find((l) => l.startsWith("code")).replace(/^code\s+/, "").trim();
  await B.eval(async () => {
    // B is enrolled, so the pane shows no join field. Clearing the keys is
    // what a person does by hand here, and it is the only way back in.
    const p = window.app.plugins.plugins.opensync;
    p.settings.namespaceKey = "";
    p.settings.accountSecret = "";
    await p.saveSettings();
  });
  await B.openSettings();
  // The other path, this time: ten characters read off A's screen, with the
  // relay address typed in by hand.
  await B.type("Relay address", env.relay.ws);
  await B.type("Join from a code", second);
  await B.press("Join from a code", "Join");
  const rejoin = Date.now() + 60_000;
  let keysB2 = await B.settings();
  while (Date.now() < rejoin && !keysB2.namespaceKey) {
    await sleep(500);
    keysB2 = await B.settings();
  }
  ok(keysB2.namespaceKey === rotated.namespaceKey, "B pairs again from ten characters and picks up the new key");
  await B.closeSettings();
  await A.closeSettings();
  const backInStep = await B.sync();
  ok(backInStep.errors.length === 0 && backInStep.status === "OpenSync: up to date",
     `and syncs again${backInStep.errors.length ? " " + JSON.stringify(backInStep.errors) : ""} (${backInStep.status})`);
  ok(await B.read("hello.md") === "# Hello from A\n\nline one\nline two\n",
     "reading the vault again, under the key it was re-sealed with");
} finally {
  await env.stop(keep || failed() > 0);
}

console.log(failed() === 0 ? "\nall good" : `\n${failed()} failed`);
process.exit(failed() === 0 ? 0 : 1);
