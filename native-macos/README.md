# Plumb_Line macOS (Native Desktop App)

macOS Native Desktop GUI for photo framing, square-fit borders, automatic horizon leveling, and inscribed-rectangle auto-cropping with full RAW file support.

Built with pure Rust:
- **`eframe` / `egui`**: Native Metal-accelerated desktop UI
- **`rawloader`**: Camera RAW decoder (.CR2, .NEF, .ARW, .DNG, .RAF)
- **`image` / `imageproc`**: High-performance image processing & bilinear rotation
- **`rayon`**: Multithreaded parallel horizon detection & demosaicing on Apple Silicon
- **`img-parts` / `kamadak-exif`**: Lossless EXIF metadata preservation

## How to Build and Run

Requirements:
- macOS (Apple Silicon M1/M2/M3/M4 or Intel)
- Rust toolchain (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)

```bash
cd native-macos
cargo run --release
```
