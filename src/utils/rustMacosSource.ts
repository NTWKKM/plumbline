/**
 * Complete, self-contained Rust macOS Native Desktop GUI implementation
 * Built with `eframe/egui` (Native Metal renderer on macOS), `image`, `imageproc`,
 * `rawloader` (Camera RAW decoding), and `kamadak-exif` / `img-parts` (lossless EXIF injection).
 *
 * Follows Andrej Karpathy's Coding Guidelines:
 * 1. Data-First Thinking (explicit structs first)
 * 2. Concrete Procedural Functions (zero trait/factory over-engineering)
 * 3. Self-Contained & Dependency-Light (Pure Rust, no C++ OpenCV dylib headaches on macOS)
 */

export const RUST_CARGO_TOML = `[package]
name = "whiteborder-macos"
version = "0.1.0"
edition = "2021"
description = "macOS Native White Border Framing + Sobel Auto-Leveling + Inscribed Auto-Crop (JPEG & RAW)"

[dependencies]
eframe = { version = "0.29", default-features = false, features = ["default_fonts", "glow", "persistence"] }
egui_extras = { version = "0.29", features = ["all_loaders"] }
rfd = "0.15"                        # Native macOS NSOpenPanel / NSSavePanel file dialogs
image = { version = "0.25", default-features = false, features = ["jpeg", "png", "tiff", "webp"] }
imageproc = "0.25"                  # Bilinear/Bicubic rotation around image center
rawloader = "0.37"                  # Pure-Rust Camera RAW decoder (.CR2, .NEF, .ARW, .DNG, .RAF)
kamadak-exif = "0.5"                # Parse EXIF tags from source JPEG/RAW
img-parts = "0.3"                   # Losslessly copy raw APP1 EXIF segment into output JPEG
rayon = "1.10"                      # Data-parallel Sobel gradient & demosaicing on Apple Silicon

[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
`;

export const RUST_MAIN_RS = `// src/main.rs
// macOS Native Desktop GUI: WhiteBorder + Auto-Leveling + Inscribed Auto-Crop
// Run on macOS (Apple Silicon / Intel): \`cargo run --release\`

use eframe::egui;
use image::{DynamicImage, GenericImageView, ImageBuffer, Rgba, RgbaImage};
use img_parts::jpeg::Jpeg;
use img_parts::ImageEXIF;
use rayon::prelude::*;
use std::fs::File;
use std::io::{BufReader, Cursor};
use std::path::{Path, PathBuf};

// ============================================================================
// 1. DATA STRUCTURES (Data-First Thinking)
// ============================================================================

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AspectPreset {
    Square1x1,      // 1:1 Instagram / Square Fit
    Portrait4x5,    // 4:5 Editorial Portrait
    Landscape16x9,  // 16:9 Cinema Frame
    Classic3x2,     // 3:2 Leica / Full-Frame
    Original,       // Preserve source aspect ratio
}

impl AspectPreset {
    pub fn target_ratio(self, src_w: u32, src_h: u32) -> f32 {
        match self {
            Self::Square1x1 => 1.0,
            Self::Portrait4x5 => 4.0 / 5.0,
            Self::Landscape16x9 => 16.0 / 9.0,
            Self::Classic3x2 => 3.0 / 2.0,
            Self::Original => (src_w.max(1) as f32) / (src_h.max(1) as f32),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ExifSummary {
    pub raw_app1_bytes: Option<Vec<u8>>,
    pub camera_model: String,
    pub lens_model: String,
    pub focal_length: String,
    pub aperture: String,
    pub shutter_speed: String,
    pub iso: String,
}

#[derive(Clone, Copy, Debug)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct ProcessConfig {
    pub auto_level: bool,
    pub max_auto_angle_deg: f32,   // Default 15.0° clamp to protect intentional Dutch angles
    pub manual_angle_deg: f32,     // Fine-tune override (-15.0° .. +15.0°)
    pub auto_crop_inscribed: bool, // Crop out empty black corner triangles after rotation
    pub split_compare: bool,       // Toggle Before/After split-screen comparison
    pub split_pct: f32,            // Split divider position (5.0 .. 95.0%)
    pub aspect: AspectPreset,
    pub padding_pct: f32,          // 0.0 .. 35.0%
    pub bg_rgb: [u8; 3],           // Border color (e.g. [255, 255, 255])
    pub preserve_exif: bool,       // Losslessly inject original EXIF APP1 block on export
    pub jpeg_quality: u8,          // 75 .. 100
}

impl Default for ProcessConfig {
    fn default() -> Self {
        Self {
            auto_level: true,
            max_auto_angle_deg: 15.0,
            manual_angle_deg: 0.0,
            auto_crop_inscribed: true,
            split_compare: false,
            split_pct: 50.0,
            aspect: AspectPreset::Square1x1,
            padding_pct: 10.0,
            bg_rgb: [255, 255, 255],
            preserve_exif: true,
            jpeg_quality: 95,
        }
    }
}

// ============================================================================
// 2. PURE PROCEDURAL PIPELINE (JPEG + RAW Decode, Auto-Level, Crop, Frame, EXIF)
// ============================================================================

/// Loads either standard JPEG/PNG/TIFF or decodes Camera RAW (.CR2, .NEF, .ARW, .DNG)
/// into an 8-bit sRGB RgbaImage + extracts raw EXIF bytes.
pub fn load_image_and_exif(path: &Path) -> Result<(RgbaImage, ExifSummary), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let raw_bytes = std::fs::read(path).map_err(|e| format!("Read error: {e}"))?;
    let exif_summary = parse_exif_from_bytes(&raw_bytes);

    let is_raw = matches!(
        ext.as_str(),
        "cr2" | "nef" | "arw" | "dng" | "raf" | "orf" | "rw2" | "pef"
    );

    if is_raw {
        let raw_img = rawloader::decode_file(path).map_err(|e| format!("RAW decode error: {e}"))?;
        let rgba = develop_raw_bilinear(&raw_img)?;
        Ok((rgba, exif_summary))
    } else {
        let img = image::load_from_memory(&raw_bytes)
            .map_err(|e| format!("Image decode error: {e}"))?
            .to_rgba8();
        Ok((img, exif_summary))
    }
}

/// Fast bilinear Bayer demosaicing + sRGB gamma curve for Camera RAW sensors.
fn develop_raw_bilinear(raw: &rawloader::RawImage) -> Result<RgbaImage, String> {
    let w = raw.width;
    let h = raw.height;
    let data = match &raw.data {
        rawloader::RawImageData::Integer(v) => v,
        _ => return Err("Unsupported floating-point RAW sensor data".into()),
    };

    // Ensure dimensions contain at least a complete 2x2 Bayer block to prevent indexing panic
    if w < 2 || h < 2 {
        return Err(format!(
            "Incomplete 2x2 block: decoded RAW image dimensions ({w}x{h}) must be at least 2x2 for Bayer demosaicing"
        ));
    }

    // Validate CFA pattern: reject unsupported layouts (e.g. 6x6 X-Trans pattern in certain .raf files)
    if raw.cfa.width != 2 || raw.cfa.height != 2 {
        return Err(format!(
            "Unsupported CFA pattern {}x{} (e.g. Fujifilm X-Trans). Only 2x2 Bayer CFA layouts are currently supported.",
            raw.cfa.width, raw.cfa.height
        ));
    }

    // Inspect the 2x2 CFA layout to dynamically map sensor samples to Red, Green, and Blue channels
    let mut r_pos = (0, 0);
    let mut b_pos = (1, 1);
    let mut g1_pos = (1, 0);
    let mut g2_pos = (0, 1);
    let mut r_count = 0;
    let mut b_count = 0;
    let mut g_count = 0;

    for dy in 0..2 {
        for dx in 0..2 {
            match raw.cfa.color_at(dy, dx) {
                0 => {
                    r_pos = (dx, dy); // Red
                    r_count += 1;
                }
                2 => {
                    b_pos = (dx, dy); // Blue
                    b_count += 1;
                }
                1 => {
                    if g_count == 0 {
                        g1_pos = (dx, dy); // Green 1
                    } else {
                        g2_pos = (dx, dy); // Green 2
                    }
                    g_count += 1;
                }
                other => {
                    return Err(format!("Unsupported CFA color value: {other} at ({dx}, {dy})"));
                }
            }
        }
    }

    if r_count != 1 || b_count != 1 || g_count != 2 {
        return Err(format!(
            "Invalid 2x2 Bayer layout: expected exactly 1 Red, 1 Blue, and 2 Green sites, found {r_count} Red, {b_count} Blue, {g_count} Green"
        ));
    }

    let black = raw.blacklevels[0] as f32;
    let white = (raw.whitelevels[0] as f32).max(black + 1.0);
    let wb = raw.wb_coeffs;
    let g_ref = wb[1].max(1.0);
    let r_gain = (wb[0] / g_ref).clamp(0.5, 4.0);
    let b_gain = (wb[2] / g_ref).clamp(0.5, 4.0);

    // Downsample 2x2 super-pixel Bayer block for fast interactive preview/export
    let out_w = (w / 2).max(1);
    let out_h = (h / 2).max(1);
    let mut out = ImageBuffer::new(out_w as u32, out_h as u32);

    for oy in 0..out_h {
        for ox in 0..out_w {
            let sx = ox * 2;
            let sy = oy * 2;
            let norm = |v: u16| ((v as f32 - black) / (white - black)).clamp(0.0, 1.0);

            let r_val = norm(data[(sy + r_pos.1) * w + sx + r_pos.0]);
            let g_val = (norm(data[(sy + g1_pos.1) * w + sx + g1_pos.0])
                + norm(data[(sy + g2_pos.1) * w + sx + g2_pos.0]))
                * 0.5;
            let b_val = norm(data[(sy + b_pos.1) * w + sx + b_pos.0]);

            let r = (r_val * r_gain).clamp(0.0, 1.0).powf(1.0 / 2.2);
            let g = g_val.clamp(0.0, 1.0).powf(1.0 / 2.2);
            let b = (b_val * b_gain).clamp(0.0, 1.0).powf(1.0 / 2.2);

            out.put_pixel(
                ox as u32,
                oy as u32,
                Rgba([(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8, 255]),
            );
        }
    }
    Ok(out)
}

/// Extracts human-readable EXIF metadata and preserves the raw APP1 JPEG segment.
fn parse_exif_from_bytes(bytes: &[u8]) -> ExifSummary {
    let mut summary = ExifSummary::default();

    if let Ok(jpeg) = Jpeg::from_bytes(bytes.to_vec().into()) {
        if let Some(exif_bytes) = jpeg.exif() {
            summary.raw_app1_bytes = Some(exif_bytes.to_vec());
        }
    }

    let mut cursor = Cursor::new(bytes);
    if let Ok(exif) = exif::Reader::new().read_from_container(&mut cursor) {
        let get_tag = |tag: exif::Tag| -> String {
            exif.get_field(tag, exif::In::PRIMARY)
                .map(|f| f.display_value().with_unit(&exif).to_string().replace('"', ""))
                .unwrap_or_default()
        };
        summary.camera_model = get_tag(exif::Tag::Model);
        summary.lens_model = get_tag(exif::Tag::LensModel);
        summary.focal_length = get_tag(exif::Tag::FocalLength);
        summary.aperture = get_tag(exif::Tag::FNumber);
        summary.shutter_speed = get_tag(exif::Tag::ExposureTime);
        summary.iso = get_tag(exif::Tag::PhotographicSensitivity);
    }
    summary
}

/// Detects dominant horizon & vertical architectural tilt in [-max_angle_deg, +max_angle_deg]
/// using 3x3 Sobel edge extraction followed by Radon / Hough line accumulator energy maximization
/// at 0.1° resolution. Returns the correction angle in degrees (-detected_tilt).
pub fn detect_auto_level_angle_deg(img: &RgbaImage, max_angle_deg: f32) -> f32 {
    let limit = max_angle_deg.clamp(1.0, 15.0);
    let (w0, h0) = img.dimensions();
    let scale = (480.0 / (w0.max(h0) as f32)).min(1.0);
    let w = ((w0 as f32 * scale) as usize).max(16);
    let h = ((h0 as f32 * scale) as usize).max(16);

    let resized = image::imageops::resize(
        img,
        w as u32,
        h as u32,
        image::imageops::FilterType::Triangle,
    );

    let mut gray = vec![0.0f32; w * h];
    for (i, p) in resized.pixels().enumerate() {
        gray[i] = 0.299 * (p[0] as f32) + 0.587 * (p[1] as f32) + 0.114 * (p[2] as f32);
    }

    let cx = (w as f32) * 0.5;
    let cy = (h as f32) * 0.5;
    // Tuple: (dx, dy, weight, is_horizontal)
    let mut edges: Vec<(f32, f32, f32, bool)> = Vec::new();

    for y in 1..(h - 1) {
        let v_weight = if y > h * 12 / 100 && y < h * 88 / 100 { 1.25 } else { 0.75 };
        for x in 1..(w - 1) {
            let p00 = gray[(y - 1) * w + (x - 1)];
            let p01 = gray[(y - 1) * w + x];
            let p02 = gray[(y - 1) * w + (x + 1)];
            let p10 = gray[y * w + (x - 1)];
            let p12 = gray[y * w + (x + 1)];
            let p20 = gray[(y + 1) * w + (x - 1)];
            let p21 = gray[(y + 1) * w + x];
            let p22 = gray[(y + 1) * w + (x + 1)];

            let gx = -p00 + p02 - 2.0 * p10 + 2.0 * p12 - p20 + p22;
            let gy = -p00 - 2.0 * p01 - p02 + p20 + 2.0 * p21 + p22;
            let mag = (gx * gx + gy * gy).sqrt();
            if mag < 36.0 {
                continue;
            }

            if gy.abs() > gx.abs() * 1.35 {
                edges.push((x as f32 - cx, y as f32 - cy, mag * v_weight, true));
            } else if gx.abs() > gy.abs() * 1.35 {
                edges.push((x as f32 - cx, y as f32 - cy, mag * 0.9, false));
            }
        }
    }

    if edges.len() < 16 {
        return 0.0;
    }

    let stride = (edges.len() / 2400).max(1);
    let diag = (((w * w + h * h) as f32).sqrt().ceil() as usize) + 4;
    let rho_offset = (diag / 2) as isize;

    let bin_step = 0.1f32;
    let half_bins = (limit / bin_step).round() as isize;
    let num_bins = (half_bins * 2 + 1) as usize;

    let mut best_bin = half_bins as usize;
    let mut max_energy = -1.0f64;
    let mut h_acc = vec![0.0f64; diag];
    let mut v_acc = vec![0.0f64; diag];

    for b in 0..num_bins {
        let angle_deg = (b as f32) * bin_step - limit;
        let rad = angle_deg.to_radians();
        let (sin_a, cos_a) = rad.sin_cos();

        h_acc.fill(0.0);
        v_acc.fill(0.0);

        for &(dx, dy, weight, is_horiz) in edges.iter().step_by(stride) {
            if is_horiz {
                let rho = (dy * cos_a - dx * sin_a).round() as isize + rho_offset;
                if rho >= 0 && (rho as usize) < diag {
                    h_acc[rho as usize] += weight as f64;
                }
            } else {
                let rho = (dx * cos_a + dy * sin_a).round() as isize + rho_offset;
                if rho >= 0 && (rho as usize) < diag {
                    v_acc[rho as usize] += weight as f64;
                }
            }
        }

        let energy: f64 = h_acc.iter().map(|v| v * v).sum::<f64>()
            + v_acc.iter().map(|v| v * v).sum::<f64>();

        if energy > max_energy {
            max_energy = energy;
            best_bin = b;
        }
    }

    let detected_tilt = (best_bin as f32) * bin_step - limit;
    -detected_tilt
}

/// Computes the Largest Inscribed Axis-Aligned Rectangle preserving original aspect ratio
/// inside an image of size (w, h) rotated by \`angle_deg\`.
pub fn compute_inscribed_crop(w: u32, h: u32, angle_deg: f32) -> CropRect {
    let rad = angle_deg.abs().to_radians();
    if rad < 1e-5 || w == 0 || h == 0 {
        return CropRect { x: 0, y: 0, width: w, height: h, scale_factor: 1.0 };
    }

    let wf = w as f32;
    let hf = h as f32;
    let sin_a = rad.sin();
    let cos_a = rad.cos();

    let s_w = wf / (wf * cos_a + hf * sin_a);
    let s_h = hf / (wf * sin_a + hf * cos_a);
    let s = s_w.min(s_h);

    let crop_w = ((wf * s).floor() as u32).max(1);
    let crop_h = ((hf * s).floor() as u32).max(1);

    CropRect {
        x: (w - crop_w) / 2,
        y: (h - crop_h) / 2,
        width: crop_w,
        height: crop_h,
        scale_factor: s,
    }
}

/// Executes the full WhiteBorder + Auto-Level + Inscribed Crop pipeline.
pub fn render_pipeline(src: &RgbaImage, cfg: &ProcessConfig, auto_angle_deg: f32) -> RgbaImage {
    let total_angle_deg = if cfg.auto_level {
        auto_angle_deg + cfg.manual_angle_deg
    } else {
        cfg.manual_angle_deg
    };

    // Step 1: Rotate around center with bilinear interpolation
    let (w, h) = src.dimensions();
    let rotated = if total_angle_deg.abs() > 0.01 {
        imageproc::geometric_transformations::rotate_about_center(
            src,
            total_angle_deg.to_radians(),
            imageproc::geometric_transformations::Interpolation::Bilinear,
            Rgba([cfg.bg_rgb[0], cfg.bg_rgb[1], cfg.bg_rgb[2], 255]),
        )
    } else {
        src.clone()
    };

    // Step 2: Auto-Crop to Largest Inscribed Rectangle (eliminating corner wedges)
    let cropped = if cfg.auto_crop_inscribed && total_angle_deg.abs() > 0.01 {
        let rect = compute_inscribed_crop(w, h, total_angle_deg);
        image::imageops::crop_imm(&rotated, rect.x, rect.y, rect.width, rect.height).to_image()
    } else {
        rotated
    };

    // Step 3: White Border Square/Custom Fit Framing
    let (cw, ch) = cropped.dimensions();
    let target_ratio = cfg.aspect.target_ratio(cw, ch);
    let pad_ratio = (cfg.padding_pct / 100.0).clamp(0.0, 0.40);
    let base_long = cw.max(ch) as f32;

    let (canvas_w, canvas_h) = if target_ratio >= 1.0 {
        let out_w = (base_long / (1.0 - (pad_ratio * 1.6).min(0.7))).round() as u32;
        let out_h = (out_w as f32 / target_ratio).round() as u32;
        (out_w.max(1), out_h.max(1))
    } else {
        let out_h = (base_long / (1.0 - (pad_ratio * 1.6).min(0.7))).round() as u32;
        let out_w = (out_h as f32 * target_ratio).round() as u32;
        (out_w.max(1), out_h.max(1))
    };

    let avail_w = (canvas_w as f32 * (1.0 - 2.0 * pad_ratio)).max(1.0);
    let avail_h = (canvas_h as f32 * (1.0 - 2.0 * pad_ratio)).max(1.0);
    let fit_scale = (avail_w / cw as f32).min(avail_h / ch as f32);

    let inner_w = ((cw as f32 * fit_scale).round() as u32).max(1);
    let inner_h = ((ch as f32 * fit_scale).round() as u32).max(1);
    let resized_inner = image::imageops::resize(
        &cropped,
        inner_w,
        inner_h,
        image::imageops::FilterType::Lanczos3,
    );

    let mut canvas = RgbaImage::from_pixel(
        canvas_w,
        canvas_h,
        Rgba([cfg.bg_rgb[0], cfg.bg_rgb[1], cfg.bg_rgb[2], 255]),
    );

    let offset_x = ((canvas_w - inner_w) / 2) as i64;
    let offset_y = ((canvas_h - inner_h) / 2) as i64;
    image::imageops::overlay(&mut canvas, &resized_inner, offset_x, offset_y);

    // Optional Before/After Split-Screen Composite (Left = Un-leveled Original, Right = Leveled & Framed)
    if cfg.split_compare {
        let split_x = ((canvas_w as f32) * (cfg.split_pct.clamp(5.0, 95.0) / 100.0)).round() as u32;
        let orig_resized = image::imageops::resize(
            src,
            inner_w,
            inner_h,
            image::imageops::FilterType::Triangle,
        );
        let ox = offset_x.max(0) as u32;
        let oy = offset_y.max(0) as u32;

        for y in 0..canvas_h {
            for x in 0..split_x.min(canvas_w) {
                if x >= ox && x < ox + inner_w && y >= oy && y < oy + inner_h {
                    canvas.put_pixel(x, y, *orig_resized.get_pixel(x - ox, y - oy));
                } else {
                    canvas.put_pixel(x, y, Rgba([20, 20, 24, 255]));
                }
            }
            if split_x < canvas_w {
                canvas.put_pixel(split_x, y, Rgba([59, 130, 246, 255]));
            }
        }
    }

    canvas
}

/// Encodes JPEG and losslessly injects original EXIF APP1 metadata block if enabled.
pub fn save_jpeg_preserving_exif(
    img: &RgbaImage,
    exif: &ExifSummary,
    cfg: &ProcessConfig,
    dest: &Path,
) -> Result<(), String> {
    let rgb = DynamicImage::ImageRgba8(img.clone()).into_rgb8();
    let mut jpeg_buf = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buf, cfg.jpeg_quality);
    encoder
        .encode_image(&rgb)
        .map_err(|e| format!("JPEG encode error: {e}"))?;

    if cfg.preserve_exif {
        if let Some(raw_exif) = &exif.raw_app1_bytes {
            if let Ok(mut parsed_jpeg) = Jpeg::from_bytes(jpeg_buf.clone().into()) {
                parsed_jpeg.set_exif(Some(raw_exif.clone().into()));
                let out_file = File::create(dest).map_err(|e| e.to_string())?;
                parsed_jpeg
                    .encoder()
                    .write_to(out_file)
                    .map_err(|e| format!("EXIF write error: {e}"))?;
                return Ok(());
            }
        }
    }

    std::fs::write(dest, &jpeg_buf).map_err(|e| format!("File write error: {e}"))
}

// ============================================================================
// 3. NATIVE MACOS EGUI APPLICATION STATE & UI
// ============================================================================

struct WhiteBorderMacApp {
    source_path: Option<PathBuf>,
    source_image: Option<RgbaImage>,
    exif: ExifSummary,
    auto_detected_angle: f32,
    cfg: ProcessConfig,
    preview_texture: Option<egui::TextureHandle>,
    dirty: bool,
    status_msg: String,
}

impl Default for WhiteBorderMacApp {
    fn default() -> Self {
        Self {
            source_path: None,
            source_image: None,
            exif: ExifSummary::default(),
            auto_detected_angle: 0.0,
            cfg: ProcessConfig::default(),
            preview_texture: None,
            dirty: false,
            status_msg: "Drop a JPEG or Camera RAW (.CR2, .NEF, .ARW, .DNG) file to start.".into(),
        }
    }
}

impl eframe::App for WhiteBorderMacApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Handle drag-and-drop files on macOS window
        if let Some(dropped) = ctx.input(|i| i.raw.dropped_files.first().cloned()) {
            if let Some(path) = dropped.path {
                self.load_file(&path);
            }
        }

        egui::SidePanel::right("inspector_panel")
            .exact_width(320.0)
            .show(ctx, |ui| {
                ui.heading("WhiteBorder + AutoLevel");
                ui.separator();

                if ui.button("Open JPEG / RAW Image...").clicked() {
                    if let Some(path) = rfd::FileDialog::new()
                        .add_filter("Photos (JPEG, RAW)", &["jpg", "jpeg", "png", "dng", "cr2", "nef", "arw", "raf"])
                        .pick_file()
                    {
                        self.load_file(&path);
                    }
                }

                ui.add_space(12.0);
                ui.label(egui::RichText::new("1. Horizon Auto-Level & Crop").strong());
                if ui.checkbox(&mut self.cfg.auto_level, "Auto-Level Horizon (Sobel)").changed() {
                    self.dirty = true;
                }
                ui.label(format!("Detected correction: {:+.2}°", self.auto_detected_angle));
                if ui.add(egui::Slider::new(&mut self.cfg.manual_angle_deg, -15.0..=15.0).text("Fine Angle (°)")).changed() {
                    self.dirty = true;
                }
                if ui.checkbox(&mut self.cfg.auto_crop_inscribed, "Auto-Crop Inscribed Rectangle").changed() {
                    self.dirty = true;
                }
                if ui.checkbox(&mut self.cfg.split_compare, "Before/After Split View").changed() {
                    self.dirty = true;
                }
                if self.cfg.split_compare {
                    if ui.add(egui::Slider::new(&mut self.cfg.split_pct, 5.0..=95.0).text("Split Wipe (%)")).changed() {
                        self.dirty = true;
                    }
                }

                ui.add_space(12.0);
                ui.label(egui::RichText::new("2. White Border & Aspect Ratio").strong());
                egui::ComboBox::from_label("Aspect Ratio")
                    .selected_text(format!("{:?}", self.cfg.aspect))
                    .show_ui(ui, |ui| {
                        for preset in [
                            AspectPreset::Square1x1,
                            AspectPreset::Portrait4x5,
                            AspectPreset::Landscape16x9,
                            AspectPreset::Classic3x2,
                            AspectPreset::Original,
                        ] {
                            if ui.selectable_value(&mut self.cfg.aspect, preset, format!("{:?}", preset)).changed() {
                                self.dirty = true;
                            }
                        }
                    });

                if ui.add(egui::Slider::new(&mut self.cfg.padding_pct, 0.0..=30.0).text("Border (%)")).changed() {
                    self.dirty = true;
                }

                ui.horizontal(|ui| {
                    ui.label("Background Color:");
                    if ui.color_edit_button_srgb(&mut self.cfg.bg_rgb).changed() {
                        self.dirty = true;
                    }
                });

                ui.add_space(12.0);
                ui.label(egui::RichText::new("3. EXIF Metadata & Export").strong());
                ui.checkbox(&mut self.cfg.preserve_exif, "Preserve Original EXIF Tags");
                if !self.exif.camera_model.is_empty() {
                    ui.small(format!(
                        "{} · {} · {} · ISO {}",
                        self.exif.camera_model, self.exif.focal_length, self.exif.aperture, self.exif.iso
                    ));
                }

                ui.add_space(16.0);
                if ui.button("Export Framed JPEG...").clicked() {
                    self.export_current();
                }
                ui.small(&self.status_msg);
            });

        if self.dirty {
            self.rebuild_preview(ctx);
            self.dirty = false;
        }

        egui::CentralPanel::default().show(ctx, |ui| {
            if let Some(tex) = &self.preview_texture {
                let avail = ui.available_size();
                let tex_size = tex.size_vec2();
                let scale = (avail.x / tex_size.x).min(avail.y / tex_size.y).min(1.0);
                ui.centered_and_justified(|ui| {
                    ui.image((tex.id(), tex_size * scale));
                });
            } else {
                ui.centered_and_justified(|ui| {
                    ui.label(&self.status_msg);
                });
            }
        });
    }
}

impl WhiteBorderMacApp {
    fn load_file(&mut self, path: &Path) {
        match load_image_and_exif(path) {
            Ok((img, exif)) => {
                self.auto_detected_angle = detect_auto_level_angle_deg(&img, self.cfg.max_auto_angle_deg);
                self.source_image = Some(img);
                self.exif = exif;
                self.source_path = Some(path.to_path_buf());
                self.dirty = true;
                self.status_msg = format!("Loaded {}", path.display());
            }
            Err(e) => self.status_msg = e,
        }
    }

    fn rebuild_preview(&mut self, ctx: &egui::Context) {
        if let Some(src) = &self.source_image {
            let rendered = render_pipeline(src, &self.cfg, self.auto_detected_angle);
            let size = [rendered.width() as usize, rendered.height() as usize];
            let color_img = egui::ColorImage::from_rgba_unmultiplied(size, rendered.as_raw());
            self.preview_texture = Some(ctx.load_texture("preview", color_img, egui::TextureOptions::LINEAR));
        }
    }

    fn export_current(&mut self) {
        if let Some(src) = &self.source_image {
            if let Some(dest) = rfd::FileDialog::new()
                .set_file_name("framed_output.jpg")
                .save_file()
            {
                let out = render_pipeline(src, &self.cfg, self.auto_detected_angle);
                match save_jpeg_preserving_exif(&out, &self.exif, &self.cfg, &dest) {
                    Ok(()) => self.status_msg = format!("Saved to {}", dest.display()),
                    Err(e) => self.status_msg = e,
                }
            }
        }
    }
}

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Plumb_Line — macOS")
            .with_inner_size([1280.0, 820.0]),
        ..Default::default()
    };
    eframe::run_native(
        "Plumb_Line",
        options,
        Box::new(|_cc| Ok(Box::new(WhiteBorderMacApp::default()))),
    )
}
`;
