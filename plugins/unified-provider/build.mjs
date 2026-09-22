import { build } from "esbuild";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "./manifest.source.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const sdk = JSON.parse(await readFile(join(root, "../../packages/plugin-sdk/package.json"), "utf8"));
const approvedSdkVersion = process.env.CCGUI_PLUGIN_SDK_VERSION;
const metadata = manifest(approvedSdkVersion);
if (approvedSdkVersion !== sdk.version) throw new Error("The approved plugin SDK patch must equal the current workspace SDK version");
const outdir = join(root, "dist");
await mkdir(outdir, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/main.tsx"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outdir,
  entryNames: "main",
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
});
await rename(join(outdir, "main.css"), join(outdir, "styles.css"));
await writeFile(join(outdir, "manifest.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
console.log(`Built independent unified-provider bundle for SDK ${approvedSdkVersion}`);
