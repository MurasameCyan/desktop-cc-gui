"""Inspect a failed CI test EXE, then change only its activation manifest."""

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib

import pefile


app, evidence = (Path(arg).resolve() for arg in sys.argv[1:])
evidence.mkdir(parents=True, exist_ok=True)
executables = list((app / "src-tauri/target/debug/deps").glob("ccgui_next_lib-*.exe"))
if len(executables) != 1:
    raise RuntimeError(f"Expected one freshly built test executable, found {executables}")
exe = executables[0]
shutil.copy2(exe, evidence / f"original-{exe.name}")

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.SetErrorMode(0x0001 | 0x0002)
kernel32.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
kernel32.LoadLibraryExW.restype = wintypes.HMODULE
kernel32.GetProcAddress.argtypes = [wintypes.HMODULE, ctypes.c_void_p]
kernel32.GetProcAddress.restype = ctypes.c_void_p
kernel32.GetModuleFileNameW.argtypes = [wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
kernel32.GetModuleFileNameW.restype = wintypes.DWORD
kernel32.FreeLibrary.argtypes = [wintypes.HMODULE]
kernel32.FreeLibrary.restype = wintypes.BOOL


def manifests(pe):
    result = []
    for resource_type in getattr(pe, "DIRECTORY_ENTRY_RESOURCE", ()).entries if hasattr(pe, "DIRECTORY_ENTRY_RESOURCE") else ():
        if resource_type.id != 24:
            continue
        for resource in resource_type.directory.entries:
            for language in resource.directory.entries:
                data = language.data.struct
                raw = pe.get_data(data.OffsetToData, data.Size)
                encoding = "utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
                result.append({"id": resource.id, "language": language.id, "xml": raw.decode(encoding, errors="replace")})
    return result


with pefile.PE(str(exe)) as pe:
    report = {
        "executable": str(exe),
        "manifest_before": manifests(pe),
        "note": "Exports below use the probe process activation context; the following full test run checks EXE activation.",
        "imports": [],
    }
    for descriptor in pe.DIRECTORY_ENTRY_IMPORT:
        dll = descriptor.dll.decode("ascii")
        module = kernel32.LoadLibraryExW(dll, None, 0x00000800)
        row = {"dll": dll, "import_count": len(descriptor.imports), "missing": []}
        if not module:
            row["load_error"] = ctypes.get_last_error()
            report["imports"].append(row)
            continue
        try:
            loaded_path = ctypes.create_unicode_buffer(32768)
            kernel32.GetModuleFileNameW(module, loaded_path, len(loaded_path))
            row["resolved_path"] = loaded_path.value
            for imported in descriptor.imports:
                if imported.name is None:
                    name = f"#{imported.ordinal}"
                    pointer = ctypes.c_void_p(imported.ordinal)
                else:
                    name = imported.name.decode("ascii")
                    pointer = ctypes.cast(ctypes.c_char_p(imported.name), ctypes.c_void_p)
                if not kernel32.GetProcAddress(module, pointer):
                    row["missing"].append(name)
        finally:
            kernel32.FreeLibrary(module)
        report["imports"].append(row)

(evidence / "loader-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report, indent=2), flush=True)

lock = tomllib.loads((app / "src-tauri/Cargo.lock").read_text(encoding="utf-8"))
build_version = next(package["version"] for package in lock["package"] if package["name"] == "tauri-build")
cargo_home = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")))
manifest_sources = list(cargo_home.glob(f"registry/src/*/tauri-build-{build_version}/src/windows-app-manifest.xml"))
if len(manifest_sources) != 1:
    raise RuntimeError(f"Cannot identify the existing Tauri application manifest: {manifest_sources}")
manifest = evidence / "tauri-application.manifest"
shutil.copy2(manifest_sources[0], manifest)
sdk_bin = Path(os.environ["ProgramFiles(x86)"]) / "Windows Kits/10/bin"
manifest_tools = sorted(sdk_bin.glob("*/x64/mt.exe"))
if not manifest_tools:
    raise RuntimeError("Windows SDK mt.exe is unavailable")
print(f"Manifest-only experiment: {manifest_tools[-1]} embeds {manifest_sources[0]}", flush=True)
subprocess.run(
    [str(manifest_tools[-1]), "-nologo", "-manifest", str(manifest), f"-outputresource:{exe};#1"],
    check=True,
)
with pefile.PE(str(exe)) as pe:
    after = manifests(pe)
(evidence / "manifest-after.json").write_text(json.dumps(after, indent=2), encoding="utf-8")
print(json.dumps({"manifest_after": after}, indent=2), flush=True)
print("Source and dependency files are unchanged. The next step reruns the same complete lib-test suite.", flush=True)
