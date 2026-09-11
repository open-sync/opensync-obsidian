// The hosted relay, before there is one.
//
// Everything else here runs against `ws://127.0.0.1:<port>`, which leaves the
// production path — a real hostname, TLS, and a default nobody types —
// completely untested. This check builds the plugin the way a release would,
// stands a TLS front end in front of the relay, and points Obsidian's own
// resolver at it, so `wss://relay.opensync.network/` resolves to the relay
// on this machine and the plugin cannot tell the difference.
//
//   npm run check:hosted
//
// No domain and no certificate authority are involved: the hostname is mapped
// inside the browser, and the certificate is self-signed for that name.
import { execFileSync } from "node:child_process";
import { createServer } from "node:tls";
import { connect } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as tcpServer } from "node:net";
import { environment, failed, ok, sleep } from "./harness.mjs";

const HOST = "relay.opensync.network";
const RELAY_WS = `wss://${HOST}/`;
const RELAY_HTTP = `https://${HOST}`;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = tcpServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** A certificate for a name nobody owns yet. Self-signed, and that is fine:
 *  the browser is told to accept it, because what is under test is the wss
 *  and https code path, not a certificate authority. */
function selfSigned(dir) {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1",
    "-subj", `/CN=${HOST}`,
    "-addext", `subjectAltName=DNS:${HOST}`,
  ], { stdio: "ignore" });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/** TLS in front of the relay. Byte-level, so HTTP and WebSocket are the same
 *  problem — which is the point: the relay speaks both on one port. */
function tlsFront({ key, cert }, toPort, onPort) {
  const server = createServer({ key, cert }, (client) => {
    const upstream = connect(toPort, "127.0.0.1");
    client.pipe(upstream).pipe(client);
    const drop = () => { client.destroy(); upstream.destroy(); };
    client.on("error", drop);
    upstream.on("error", drop);
  });
  return new Promise((resolve) => server.listen(onPort, "127.0.0.1", () => resolve(server)));
}

const certDir = mkdtempSync(join(tmpdir(), "opensync-tls-"));
const env = await environment();
let front;
try {
  const relayPort = Number(new URL(env.relay.http).port);
  const tlsPort = await freePort();
  front = await tlsFront(selfSigned(certDir), relayPort, tlsPort);
  console.log(`${RELAY_WS} -> 127.0.0.1:${tlsPort} -> relay on ${relayPort}\n`);

  // Obsidian resolves the name itself; nothing touches /etc/hosts or DNS.
  const args = [
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${tlsPort}`,
    "--ignore-certificate-errors",
  ];
  const A = await env.open("vaultA", undefined, args);
  const B = await env.open("vaultB", undefined, args);

  // ---- the default, which is the whole onboarding argument -----------------
  const fresh = await A.settings();
  ok(fresh.relayWs === RELAY_WS, `a fresh install already points at the relay (${fresh.relayWs})`);
  ok(fresh.relayHttp === RELAY_HTTP, `and at its blob endpoint (${fresh.relayHttp})`);
  ok(fresh.hostedRelay === RELAY_WS, "and knows that relay is the metered one");

  // ---- it works over TLS, which nothing here has ever tested ---------------
  await A.openSettings();
  await A.press("Vault key", "Generate");
  await sleep(300);
  await A.press("Account key", "Generate");
  await sleep(500);
  await A.closeSettings();
  await A.write("note.md", "# over wss\n");
  const first = await A.sync();
  ok(first.errors.length === 0 && first.status === "OpenSync: up to date",
     `a vault publishes over wss and https (${first.status}${first.errors.length ? " " + JSON.stringify(first.errors) : ""})`);

  // ---- pairing over TLS ----------------------------------------------------
  await A.openSettings();
  await A.press("Add a device", "Show a code");
  await A.waitForLine(/^code /);
  const shown = await A.pairingBox();
  const invite = shown.lines.find((l) => l.startsWith("opensync://"));
  ok(invite?.includes(HOST), `the invitation carries the hosted name (${invite})`);
  ok(!shown.lines.some((l) => /this machine/.test(l)),
     "and the loopback warning is gone, because the relay is not loopback any more");
  await B.openSettings();
  await B.type("Join from a code", invite);
  await B.press("Join from a code", "Join");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !(await B.settings()).namespaceKey) await sleep(300);
  ok((await B.settings()).namespaceKey === (await A.settings()).namespaceKey,
     "a second device pairs over TLS");
  await A.closeSettings();
  await B.closeSettings();

  const pulled = await B.sync();
  ok(pulled.errors.length === 0 && await B.read("note.md") === "# over wss\n",
     "and reads the vault over TLS");

  // ---- the meter is on, because this is our relay --------------------------
  ok(await A.eval(() => window.app.plugins.plugins.opensync.onMeteredRelay),
     "the plan applies on the hosted relay");
  await A.writeBinary("assets/photo.png", [137, 80, 78, 71, 13, 10, 26, 10, ...Array(1024).keys()]);
  await A.sync();
  await B.sync();
  ok(!(await B.files()).includes("assets/photo.png"),
     "so a free vault holds its attachments back");
  ok((await B.files()).includes("note.md"), "and syncs everything it is written in");

  // ---- and off again the moment somebody uses their own ---------------------
  await B.eval(async () => {
    const p = window.app.plugins.plugins.opensync;
    p.settings.relayWs = "wss://relay.mine.example/";
    await p.saveSettings();
  });
  ok(!(await B.eval(() => window.app.plugins.plugins.opensync.onMeteredRelay)),
     "a relay of your own is not metered, even on a build that ships ours");
} finally {
  front?.close();
  rmSync(certDir, { recursive: true, force: true });
  await env.stop(failed() > 0);
}

console.log(failed() === 0 ? "\nall good" : `\n${failed()} failed`);
process.exit(failed() === 0 ? 0 : 1);
