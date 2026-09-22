import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Linux release installs the GBM development library before linking", () => {
  const workflow = read(".github/workflows/release.yml");
  const linuxJob = workflow.split("  build_linux:")[1].split("  build_windows:")[0];
  assert.match(linuxJob, /sudo apt-get install[^\n]*\blibgbm-dev\b/);
});

test("Windows MSVC embeds the manifest for library tests as well as the application", () => {
  const build = read("src-tauri/build.rs");
  assert.match(build, /CARGO_CFG_TARGET_OS/);
  assert.match(build, /CARGO_CFG_TARGET_ENV/);
  assert.match(build, /new_without_app_manifest\(\)/);
  assert.match(build, /cargo:rustc-link-arg=\/MANIFEST:EMBED/);
  assert.match(build, /cargo:rustc-link-arg=\/MANIFESTINPUT:/);
  assert.match(build, /cargo:rerun-if-changed=/);
  assert.doesNotMatch(build, /rustc-link-arg-(?:bins|tests)=/);
  const manifest = read("src-tauri/windows-app-manifest.xml");
  assert.match(manifest, /name="Microsoft.Windows.Common-Controls"/);
  assert.match(manifest, /version="6\.0\.0\.0"/);
  assert.match(manifest, /processorArchitecture="\*"/);
  assert.match(manifest, /publicKeyToken="6595b64144ccf1df"/);
});

test("Both Windows workflows continue to execute Rust library tests", () => {
  for (const path of [".github/workflows/release.yml", ".github/workflows/build-windows-artifact.yml"]) {
    const workflow = read(path);
    assert.match(workflow, /run: cargo test --manifest-path src-tauri\/Cargo\.toml --lib/);
    assert.doesNotMatch(workflow, /continue-on-error: true/);
  }
});
