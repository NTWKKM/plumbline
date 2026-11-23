# Plumb_Line macOS (Native Desktop App)

macOS Native Desktop GUI for photo framing, square-fit borders, automatic horizon leveling, and inscribed-rectangle auto-cropping with 2x2 Bayer CFA RAW file support (integer sensor data).

Built with pure Rust:
- **`eframe` / `egui`**: Native desktop UI using the `glow` (OpenGL) renderer
- **`rawloader`**: Camera RAW decoder for 2x2 Bayer CFA files (.CR2, .NEF, .ARW, .DNG) with integer sensor data
- **`image` / `imageproc`**: High-performance image processing & bilinear rotation
- **`rayon`**: Declared for future multithreading; current horizon detection and demosaicing operations run sequentially
- **`img-parts` / `kamadak-exif`**: Lossless source EXIF metadata preservation for JPEG sources (RAW exports do not include source EXIF)

## How to Build and Run

Requirements:
- macOS (Apple Silicon M1/M2/M3/M4 or Intel)
- Rust toolchain (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)

### Option 1: Run directly from CLI

```bash
cd native-macos
cargo run --release
```

### Option 2: Package & Install as Native macOS App (.app)

```bash
cd native-macos
./bundle.sh
```

This compiles an optimized release binary, packages it into `native-macos/dist/Plumb_Line.app` (git-ignored), performs ad-hoc codesigning, and installs it into `~/Applications/Plumb_Line.app` (launchable via Spotlight or Finder).

- The bundle version (`CFBundleShortVersionString` / `CFBundleVersion`) is read from `Cargo.toml`.
- The packaged binary path comes from Cargo's `compiler-artifact` JSON output, so a custom `CARGO_TARGET_DIR` or `build.target-dir` is honoured.
- `~/Applications` is created if missing; any existing `~/Applications/Plumb_Line.app` is replaced on each run.
- The ad-hoc signature is local-only: it is not notarized and is not intended for distribution to other Macs.

