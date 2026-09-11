// The free plan and the paid one, in the same vault pair.
//
// Every assertion here is about a file *not* disappearing. A tier that
// filters what it publishes looks, to every other device, exactly like a tier
// that deleted everything it filtered out — and before the manifest carried a
// scope, that is precisely what happened: one device turning off "Sync
// attachments" moved the other device's attachments to the trash, with the
// status bar reading "up to date".
//
//   npm run build && npm run check:tiers
import { environment, failed, ok, sleep } from "./harness.mjs";

const PNG = [137, 80, 78, 71, 13, 10, 26, 10, ...Array.from({ length: 4096 }, (_, i) => (i * 31) % 256)];
const env = await environment();

/** Ask a device which plan it is on, and set it — the account will do this later. */
const setPlan = (d, plan) =>
  d.eval(async (plan) => {
    const p = window.app.plugins.plugins.opensync;
    p.settings.plan = plan;
    await p.saveSettings();
  }, plan);

/**
 * Tell the plugin that the harness relay is the hosted one.
 *
 * Without this nothing is metered at all, which is the shipped default and
 * the correct behaviour: a relay of your own is nobody's business but yours.
 * The checks below are about the hosted case, so they have to say so.
 */
const meterAgainst = (d, ws) =>
  d.eval(async (ws) => {
    const p = window.app.plugins.plugins.opensync;
    p.settings.hostedRelay = ws;
    await p.saveSettings();
  }, ws);

const setAttachments = (d, on) =>
  d.eval(async (on) => {
    const p = window.app.plugins.plugins.opensync;
    p.settings.syncAttachments = on;
    await p.saveSettings();
  }, on);

const carries = (d) => d.eval(() => window.app.plugins.plugins.opensync.carriesAttachments);

try {
  const A = await env.open("vaultA");
  const B = await env.open("vaultB");

  // ---- pair them, both on the free plan ------------------------------------
  await A.openSettings();
  await A.type("Relay address", env.relay.ws);
  await A.type("Storage address", env.relay.http);
  await A.press("Vault key", "Generate");
  await sleep(300);
  await A.press("Account key", "Generate");
  await sleep(500);
  await A.press("Add a device", "Show a code");
  await A.waitForLine(/^code /);
  const invite = (await A.pairingBox()).lines.find((l) => l.startsWith("opensync://"));
  await B.openSettings();
  await B.type("Join from a code", invite);
  await B.press("Join from a code", "Join");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !(await B.settings()).namespaceKey) await sleep(300);
  await A.closeSettings();
  await B.closeSettings();
  await meterAgainst(A, env.relay.ws);
  await meterAgainst(B, env.relay.ws);
  ok(await A.eval(() => window.app.plugins.plugins.opensync.onMeteredRelay),
     "the plan applies, because this is the hosted relay");

  // ---- 1. the free plan carries what a vault is written in ------------------
  await A.write("note.md", "# a note\n");
  await A.write("board.canvas", '{"nodes":[],"edges":[]}\n');
  await A.write("drawing.excalidraw.md", "# drawing\n\n```json\n{}\n```\n");
  await A.write("table.csv", "a,b\n1,2\n");
  await A.write("LICENSE", "no extension at all\n");
  await A.writeBinary("assets/photo.png", PNG);
  await A.sync();
  await B.sync();

  const onB = await B.files();
  for (const path of ["note.md", "board.canvas", "drawing.excalidraw.md", "table.csv"]) {
    ok(onB.includes(path), `free: ${path} syncs`);
  }
  ok(!onB.includes("assets/photo.png"), "free: an attachment does not");
  ok(!onB.includes("LICENSE"), "free: a file with no extension does not");
  ok((await A.files()).includes("assets/photo.png"), "and the attachment is still on the device that made it");
  ok(await A.eval(() => window.app.plugins.plugins.opensync.heldBackPaths().length) === 2,
     "the pane can say how many files are held back");

  // ---- 2. the bug this whole change exists for ------------------------------
  // B pays, and has an attachment of its own. A is still free. A publishing a
  // manifest with no attachments in it must not remove B's.
  await setPlan(B, "supporter");
  await setAttachments(B, true);
  ok(await carries(B), "B is on the paid plan and carrying attachments");
  ok(!(await carries(A)), "A is not");
  await B.writeBinary("assets/scan.png", PNG);
  await B.sync();
  await A.write("note.md", "# a note\n\nedited on A\n");
  await A.sync();
  const r = await B.sync();
  ok(r.errors.length === 0, `B syncs cleanly${r.errors.length ? " " + JSON.stringify(r.errors) : ""}`);
  ok((await B.files()).includes("assets/scan.png"),
     `a free device's manifest does not delete a paid device's attachment (${JSON.stringify(await B.files())})`);
  ok(await B.read("note.md") === "# a note\n\nedited on A\n", "and the note edit still arrives");

  // ---- 3. a paid device's attachment reaches the free device ----------------
  // Receiving is not the metered part — the bytes are already paid for by the
  // account that stored them, and the far side's disk is its own.
  await A.sync();
  ok((await A.files()).includes("assets/scan.png"), "a paid device's attachment does reach the free one");
  const before = await A.files();
  await A.sync();
  await B.sync();
  await A.sync();
  ok(JSON.stringify(await A.files()) === JSON.stringify(before),
     `and repeat syncs across mismatched plans are inert (${JSON.stringify((await A.files()).filter((f) => !before.includes(f)))})`);

  // ---- 4. downgrade ---------------------------------------------------------
  // The dangerous transition: a device that was carrying everything stops.
  // Nothing may be deleted, on either side.
  const beforeDowngrade = { a: await A.files(), b: await B.files() };
  await setPlan(B, "free");
  ok(!(await carries(B)), "B has lapsed to the free plan");
  await B.sync();
  await A.sync();
  await B.sync();
  ok(JSON.stringify(await B.files()) === JSON.stringify(beforeDowngrade.b),
     `a lapsed plan deletes nothing on its own device (${JSON.stringify(await B.files())})`);
  ok(JSON.stringify(await A.files()) === JSON.stringify(beforeDowngrade.a),
     `and nothing on the other one (${JSON.stringify(await A.files())})`);

  // ---- 5. upgrade -----------------------------------------------------------
  await setPlan(A, "supporter");
  await setAttachments(A, true);
  ok(await carries(A), "A has upgraded");
  await A.sync();
  await B.sync();
  await A.sync();
  ok((await B.files()).includes("assets/photo.png"),
     `upgrading publishes the attachments that were waiting on that device (${JSON.stringify(await B.files())})`);
  ok(await B.read("note.md") === "# a note\n\nedited on A\n", "and nothing else moved");

  // ---- 6. a real deletion still propagates ---------------------------------
  // Scope must not become a way to lose deletions: a device that covers a file
  // and drops it still means it.
  await A.remove("table.csv");
  await A.sync();
  await B.sync();
  ok(!(await B.files()).includes("table.csv"), "a deletion inside the scope still propagates");
  ok((await B.files()).includes("note.md"), "and takes nothing else with it");

  // ---- 7. a relay of your own is not metered -------------------------------
  // The thing being sold is not running a server. Someone running their own
  // is already paying for the storage, so the plan has nothing to charge for.
  await setPlan(B, "free");
  await meterAgainst(B, "wss://relay.example.invalid/");
  ok(!(await B.eval(() => window.app.plugins.plugins.opensync.onMeteredRelay)),
     "pointing at a relay that is not ours turns the meter off");
  await setAttachments(B, true);
  ok(await carries(B), "and a free plan carries attachments on its own relay");
  ok(await B.eval(() => window.app.plugins.plugins.opensync.heldBackPaths().length) === 0,
     "with nothing held back");
} finally {
  await env.stop(failed() > 0);
}

console.log(failed() === 0 ? "\nall good" : `\n${failed()} failed`);
process.exit(failed() === 0 ? 0 : 1);
