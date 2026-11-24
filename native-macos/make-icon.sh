#!/usr/bin/env bash
# Regenerate assets/AppIcon.icns and assets/icon-512.png from assets/icon.svg (macOS only).
# QuickLook renders the SVG with WebKit but always onto an opaque white page, so the icon is
# rendered twice, on white and on black, and the alpha channel is recovered from the difference
# (alpha = 1 - (white - black), colour = black / alpha). Requires ImageMagick (brew install imagemagick).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="${SCRIPT_DIR}/assets"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

render_on() {
    # $1 = background colour, $2 = output png
    sed "s|<defs>|<rect width=\"1024\" height=\"1024\" fill=\"$1\"/><defs>|" "${ASSETS}/icon.svg" > "${WORK}/bg.svg"
    qlmanage -t -s 1024 -o "${WORK}" "${WORK}/bg.svg" > /dev/null 2>&1
    mv "${WORK}/bg.svg.png" "$2"
}

render_on "#FFFFFF" "${WORK}/white.png"
render_on "#000000" "${WORK}/black.png"

magick "${WORK}/white.png" "${WORK}/black.png" -colorspace sRGB -alpha off \
    -fx "cov = 1 - (u.r - v.r + u.g - v.g + u.b - v.b) / 3; cov < 0.004 ? 0 : min(1, v / cov)" \
    "${WORK}/rgb.png"
magick "${WORK}/white.png" "${WORK}/black.png" -colorspace sRGB -alpha off \
    -fx "1 - (u.r - v.r + u.g - v.g + u.b - v.b) / 3" -colorspace Gray "${WORK}/alpha.png"
magick "${WORK}/rgb.png" "${WORK}/alpha.png" -alpha off -compose CopyOpacity -composite \
    "${WORK}/icon-1024.png"

ICONSET="${WORK}/AppIcon.iconset"
mkdir -p "${ICONSET}"
for size in 16 32 128 256 512; do
    magick "${WORK}/icon-1024.png" -filter Lanczos -resize "${size}x${size}" "${ICONSET}/icon_${size}x${size}.png"
    double=$((size * 2))
    magick "${WORK}/icon-1024.png" -filter Lanczos -resize "${double}x${double}" "${ICONSET}/icon_${size}x${size}@2x.png"
done
iconutil -c icns "${ICONSET}" -o "${ASSETS}/AppIcon.icns"
cp "${ICONSET}/icon_256x256@2x.png" "${ASSETS}/icon-512.png"
echo "Wrote ${ASSETS}/AppIcon.icns and ${ASSETS}/icon-512.png"
