# Plumb_Line macOS (Native Desktop App)

macOS Native Desktop GUI for photo framing, square-fit borders, automatic horizon leveling, and inscribed-rectangle auto-cropping with 2x2 Bayer CFA RAW file support (integer sensor data).

Built with pure Rust:
- **`eframe` / `egui`**: Native desktop UI using the `glow` (OpenGL) renderer
- **`rawloader`**: Camera RAW decoder for 2x2 Bayer CFA files (.CR2, .NEF, .ARW, .DNG) with integer sensor data
- **`image` / `imageproc`**: High-performance image processing & bilinear rotation
- **`rayon`**: Multithreaded parallel horizon detection & demosaicing on Apple Silicon
- **`img-parts` / `kamadak-exif`**: Lossless source EXIF metadata preservation for JPEG sources (RAW exports do not include source EXIF)

## How to Build and Run

Requirements:
- macOS (Apple Silicon M1/M2/M3/M4 or Intel)
- Rust toolchain (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)

```bash
cd native-macos
cargo run --release
```
