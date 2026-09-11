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
    // The relay this build ships pointing at. Empty unless the build says
    // otherwise, which is what makes a local build self-hosted by default and
    // lets a release be built for the hosted one:
    //   OPENSYNC_HOSTED_RELAY=wss://relay01.example.net/ npm run build
    __HOSTED_RELAY__: JSON.stringify(process.env.OPENSYNC_HOSTED_RELAY ?? ""),
  },
  sourcemap: false,
  minify: true,
  logLevel: "info",
});
