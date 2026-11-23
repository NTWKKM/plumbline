#!/usr/bin/env bash
# Build, package, ad-hoc sign, and install Plumb_Line as a native macOS .app bundle.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "error: bundle.sh packages a macOS .app and must run on macOS" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

BIN_NAME="plumbline-macos"
APP_NAME="Plumb_Line.app"
DIST_DIR="${SCRIPT_DIR}/dist"
APP_DIR="${DIST_DIR}/${APP_NAME}"
INSTALL_DIR="${HOME}/Applications"

# Keep the bundle version in lockstep with Cargo.toml instead of a hard-coded string
APP_VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' Cargo.toml | head -n 1)"
if [[ -z "${APP_VERSION}" ]]; then
    echo "error: could not read package version from Cargo.toml" >&2
    exit 1
fi

echo "Building release binary (v${APP_VERSION})..."
cargo build --release

BIN_PATH="${SCRIPT_DIR}/target/release/${BIN_NAME}"
if [[ ! -x "${BIN_PATH}" ]]; then
    echo "error: release binary not found at ${BIN_PATH}" >&2
    exit 1
fi

echo "Packaging ${APP_NAME}..."
rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
cp "${BIN_PATH}" "${APP_DIR}/Contents/MacOS/${BIN_NAME}"
chmod +x "${APP_DIR}/Contents/MacOS/${BIN_NAME}"

cat << EOF > "${APP_DIR}/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${BIN_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>com.plumbline.macos</string>
    <key>CFBundleName</key>
    <string>Plumb_Line</string>
    <key>CFBundleDisplayName</key>
    <string>Plumb_Line</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${APP_VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${APP_VERSION}</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.photography</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key>
    <true/>
</dict>
</plist>
EOF
plutil -lint "${APP_DIR}/Contents/Info.plist" > /dev/null

echo "Signing ${APP_NAME} (ad-hoc)..."
codesign --force --sign - "${APP_DIR}"
codesign --verify --strict "${APP_DIR}"

echo "Installing to ${INSTALL_DIR}/${APP_NAME}..."
mkdir -p "${INSTALL_DIR}"
rm -rf "${INSTALL_DIR:?}/${APP_NAME}"
# ditto preserves the code signature, extended attributes, and bundle metadata
ditto "${APP_DIR}" "${INSTALL_DIR}/${APP_NAME}"

echo "Done. Bundle: ${APP_DIR}"
echo "Launch with: open \"${INSTALL_DIR}/${APP_NAME}\" (or via Spotlight / Finder)"
