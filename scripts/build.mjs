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
  define: { "import.meta.url": '""' },
  sourcemap: false,
  minify: true,
  logLevel: "info",
});
