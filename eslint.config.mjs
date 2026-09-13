// The community directory's own rules, run here before a version is spent.
//
// The directory scans each version once, so a finding discovered by its scan
// costs a release number to fix — 0.1.0 and 0.1.1 both went that way. This is
// the recommended configuration its scan reports against, so `npm run lint`
// is the dress rehearsal.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // The wasm-bindgen glue is JavaScript, which the TypeScript project
          // does not include; without this it fails to parse here, though the
          // scan reads it fine.
          allowDefaultProject: ["eslint.config.*", "vendor/opensync-client/wasm/opensync_wasm.js"],
        },
      },
    },
  },
  {
    // Severities as the directory's scan reported them, rather than as the
    // plugin's recommended set declares them. The scan failed 0.1.1 on errors
    // and listed these beside them as warnings; matching that makes an error
    // here mean "the scan will fail", which is the only thing worth gating on.
    // Nothing is switched off: every one of these still prints.
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      // Fires once, inside wasm-bindgen's generated glue. That file is
      // byte-identical across 0.1.0, 0.1.1 and 0.1.2, and neither scan of it
      // reported this; it is machine output, not code anybody wrote.
      "@typescript-eslint/no-array-constructor": "warn",
    },
  },
  {
    // Build output and tooling, not plugin code. The vendored client is
    // deliberately *not* ignored: the scan reads it, so this does too.
    ignores: ["main.js", "dist-install/**", "node_modules/**", "checks/**", "scripts/**"],
  },
]);
