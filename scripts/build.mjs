import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian provides these at runtime; bundling them would ship a second
  // copy of the app into the plugin.
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  platform: "browser",
  outfile: "main.js",
  // wasm-bindgen's generated loader references import.meta.url on a default
  // path we never take — we always hand init() the inlined bytes. Defining it
  // away keeps the cjs build warning-free rather than shipping a misleading one.
  define: {
    "import.meta.url": '""',
    // The relay this build ships pointing at.
    //
    // It defaults to the hosted one now that there is one. The empty default
    // was honest while no relay existed — with none, every user is running
    // their own and the plan gate means nothing — but it also meant a fresh
    // install on a phone had an empty relay field and no way to guess what
    // belonged in it.
    //
    // Build for a different relay, or for none, by saying so:
    //   OPENSYNC_HOSTED_RELAY=wss://relay.example.net/ npm run build
    //   OPENSYNC_HOSTED_RELAY= npm run build
    __TEST_BUILD__: JSON.stringify(process.env.OPENSYNC_TEST_BUILD === "1"),
    // A build for the in-app checks, which may point the account server at
    // a local one. Off in anything released.
    __CHECK_BUILD__: JSON.stringify(process.env.OPENSYNC_CHECK_BUILD === "1"),
    __HOSTED_RELAY__: JSON.stringify(
      process.env.OPENSYNC_HOSTED_RELAY ?? "wss://relay.opensync.network/",
    ),
  },
  sourcemap: false,
  minify: true,
  logLevel: "info",
});
