// Put a test build in front of every device you own, over Tailscale.
//
// There is no app to download: this is an Obsidian plugin, so Obsidian comes
// from the App Store or Play Store and the plugin goes into the vault. That is
// three files in a folder, which is easy on a laptop and fiddly on a phone —
// so this serves them, with the instructions, at one address every device on
// the tailnet can open.
//
//   node scripts/serve-for-devices.mjs
//
// It builds a *test* build: the relay it points at is this machine, and the
// settings pane grows a control for switching plans, so both tiers can be
// tried. Neither is true of a release.
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_PORT = Number(process.env.PAGE_PORT ?? 4849);
const RELAY_PORT = Number(process.env.RELAY_PORT ?? 4848);
const PAGE_HTTPS = Number(process.env.PAGE_HTTPS ?? 8444);
const RELAY_HTTPS = Number(process.env.RELAY_HTTPS ?? 8443);

/** This machine's name on the tailnet, so nothing is hard-coded to one. */
function tailnetName() {
  try {
    const out = execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" });
    const name = JSON.parse(out).Self?.DNSName?.replace(/\.$/, "");
    if (name) return name;
  } catch {
    // Not on a tailnet, or tailscale is not installed.
  }
  return null;
}

const host = tailnetName();
if (!host) {
  console.error("no tailnet name — is tailscale running? (`tailscale status`)");
  process.exit(1);
}

const relayWs = `wss://${host}:${RELAY_HTTPS}/`;
const relayHttp = `https://${host}:${RELAY_HTTPS}`;
const pageUrl = `https://${host}:${PAGE_HTTPS}/`;

// ---- build the plugin these devices will run -------------------------------
console.log(`building a test build pointed at ${relayWs}`);
execFileSync("node", ["scripts/build.mjs"], {
  cwd: REPO,
  stdio: "inherit",
  env: { ...process.env, OPENSYNC_TEST_BUILD: "1", OPENSYNC_HOSTED_RELAY: relayWs },
});

// ---- one zip, shaped the way a vault wants it ------------------------------
// Zipped from inside the folder, so unzipping gives `opensync/` with the three
// files in it — which is exactly what goes into `.obsidian/plugins/`.
const stage = join(REPO, "dist-install", "opensync");
mkdirSync(stage, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  writeFileSync(join(stage, f), readFileSync(join(REPO, f)));
}
const zip = join(REPO, "dist-install", "opensync-plugin.zip");
spawnSync("zip", ["-qr", zip, "opensync"], { cwd: join(REPO, "dist-install") });
const zipSize = (statSync(zip).size / 1024 / 1024).toFixed(1);

const page = readFileSync(join(REPO, "scripts", "install-page.html"), "utf8")
  .replaceAll("__RELAY_WS__", relayWs)
  .replaceAll("__RELAY_HTTP__", relayHttp)
  .replaceAll("__ZIP_SIZE__", `${zipSize} MB`)
  .replaceAll("__PAGE__", pageUrl)
  .replaceAll("__HOST__", host);

createServer((req, res) => {
  if (req.url === "/opensync-plugin.zip") {
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="opensync-plugin.zip"',
    });
    res.end(readFileSync(zip));
    return;
  }
  if (req.url?.startsWith("/main.js") || req.url?.startsWith("/manifest.json") || req.url?.startsWith("/styles.css")) {
    const name = req.url.slice(1).split("?")[0];
    res.writeHead(200, {
      "content-type": name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "application/json",
      "content-disposition": `attachment; filename="${name}"`,
    });
    res.end(readFileSync(join(REPO, name)));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}).listen(PAGE_PORT, "127.0.0.1", () => {
  console.log(`
  page   http://127.0.0.1:${PAGE_PORT}   (local)
  zip    ${zipSize} MB

  Put both in front of the tailnet, once:

    tailscale serve --bg --https=${PAGE_HTTPS} http://127.0.0.1:${PAGE_PORT}
    tailscale serve --bg --https=${RELAY_HTTPS} http://127.0.0.1:${RELAY_PORT}

  Then, on any device signed into the tailnet:

    ${pageUrl}

  And run the relay beside this:

    opensync-relay relay.toml     (bind 127.0.0.1:${RELAY_PORT})
`);
});
