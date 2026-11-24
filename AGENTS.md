# AGENTS.md

- Run web checks with `pnpm` (`pnpm-lock.yaml`): `pnpm test`, `pnpm run lint`, and `pnpm run build`.
- Run `cargo check --manifest-path native-macos/Cargo.toml` when modifying Rust sources in `native-macos/`.
- Read `native-macos/README.md` before changing RAW/EXIF handling, `bundle.sh`, or `.app` installation behavior.
- Locate target symbols via `rg -n` before reading slices of `native-macos/src/main.rs`, `src/utils/geometry.ts`, or `src/utils/exifParser.ts`.
