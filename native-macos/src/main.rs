// src/main.rs
// macOS Native Desktop GUI: WhiteBorder + Auto-Leveling + Inscribed Auto-Crop
// Run on macOS (Apple Silicon / Intel): `cargo run --release`

use eframe::egui;
use image::{DynamicImage, ImageBuffer, Rgba, RgbaImage};
use img_parts::jpeg::Jpeg;
use img_parts::ImageEXIF;
use std::fs::File;
use std::io::Cursor;
use std::path::{Path, PathBuf};

// ============================================================================
// 1. DATA STRUCTURES (Data-First Thinking)
// ============================================================================

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AspectPreset {
    Square1x1,     // 1:1 Instagram / Square Fit
    Portrait4x5,   // 4:5 Editorial Portrait
    Landscape16x9, // 16:9 Cinema Frame
    Classic3x2,    // 3:2 Leica / Full-Frame
    Original,      // Preserve source aspect ratio
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
    pub orientation: u32,
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

/// Applies EXIF orientation transformation to normalize image to standard orientation (1 / upright).
fn apply_exif_orientation(img: RgbaImage, orientation: u32) -> RgbaImage {
    match orientation {
        2 => image::imageops::flip_horizontal(&img),
        3 => image::imageops::rotate180(&img),
        4 => image::imageops::flip_vertical(&img),
        5 => image::imageops::rotate270(&image::imageops::flip_horizontal(&img)),
        6 => image::imageops::rotate90(&img),
        7 => image::imageops::rotate90(&image::imageops::flip_horizontal(&img)),
        8 => image::imageops::rotate270(&img),
        _ => img,
    }
}

/// Computes crop margins (top, right, bottom, left) from sensor crop metadata [top, right, bottom, left].
/// Each 2x2 Bayer sensor block maps to 1 output pixel. Odd margins exclude the block containing inactive sensor data.
pub fn compute_raw_crop_margins(
    raw_width: usize,
    raw_height: usize,
    crops: [usize; 4],
    out_width: u32,
    out_height: u32,
) -> Result<(u32, u32, u32, u32), String> {
    if crops[0] + crops[2] >= raw_height || crops[3] + crops[1] >= raw_width {
        return Err("Invalid RAW crop margins: crop bounds leave no image data".into());
    }

    let crop_top = crops[0].div_ceil(2) as u32;
    let crop_left = crops[3].div_ceil(2) as u32;

    let kept_w = (raw_width - crops[1]) / 2;
    let crop_right = (out_width as usize).saturating_sub(kept_w) as u32;

    let kept_h = (raw_height - crops[2]) / 2;
    let crop_bottom = (out_height as usize).saturating_sub(kept_h) as u32;

    if crop_left + crop_right >= out_width || crop_top + crop_bottom >= out_height {
        return Err("Invalid RAW crop margins: crop bounds leave no image data".into());
    }

    Ok((crop_top, crop_right, crop_bottom, crop_left))
}

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
        "cr2" | "nef" | "arw" | "dng" | "orf" | "rw2" | "pef"
    );

    let (mut rgba, exif_summary) = if is_raw {
        let raw_img = rawloader::decode_file(path).map_err(|e| format!("RAW decode error: {e}"))?;
        let img = develop_raw_bilinear(&raw_img)?;

        let (crop_top, crop_right, crop_bottom, crop_left) = compute_raw_crop_margins(
            raw_img.width,
            raw_img.height,
            raw_img.crops,
            img.width(),
            img.height(),
        )?;

        let crop_w = img.width() - crop_left - crop_right;
        let crop_h = img.height() - crop_top - crop_bottom;
        let cropped = image::imageops::crop_imm(&img, crop_left, crop_top, crop_w, crop_h).to_image();
        (cropped, exif_summary)
    } else {
        let img = image::load_from_memory(&raw_bytes)
            .map_err(|e| format!("Image decode error: {e}"))?
            .to_rgba8();
        (img, exif_summary)
    };

    if exif_summary.orientation > 1 {
        rgba = apply_exif_orientation(rgba, exif_summary.orientation);
    }

    Ok((rgba, exif_summary))
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

    // Extract per-CFA-site black levels using CFA site coordinates (pos.1 * 2 + pos.0)
    // to preserve distinct G1 and G2 levels for DNG inputs
    let r_site = r_pos.1 * 2 + r_pos.0;
    let g1_site = g1_pos.1 * 2 + g1_pos.0;
    let g2_site = g2_pos.1 * 2 + g2_pos.0;
    let b_site = b_pos.1 * 2 + b_pos.0;

    let r_black = raw.blacklevels.get(r_site).copied().unwrap_or(raw.blacklevels[0]) as f32;
    let g1_black = raw.blacklevels.get(g1_site).copied().unwrap_or(raw.blacklevels[0]) as f32;
    let g2_black = raw.blacklevels.get(g2_site).copied().unwrap_or(raw.blacklevels[0]) as f32;
    let b_black = raw.blacklevels.get(b_site).copied().unwrap_or(raw.blacklevels[0]) as f32;

    let r_color = raw.cfa.color_at(r_pos.1, r_pos.0);
    let g1_color = raw.cfa.color_at(g1_pos.1, g1_pos.0);
    let g2_color = raw.cfa.color_at(g2_pos.1, g2_pos.0);
    let b_color = raw.cfa.color_at(b_pos.1, b_pos.0);

    let r_white = (raw.whitelevels.get(r_color).copied().unwrap_or(raw.whitelevels[0]) as f32).max(r_black + 1.0);
    let g1_white = (raw.whitelevels.get(g1_color).copied().unwrap_or(raw.whitelevels[0]) as f32).max(g1_black + 1.0);
    let g2_white = (raw.whitelevels.get(g2_color).copied().unwrap_or(raw.whitelevels[0]) as f32).max(g2_black + 1.0);
    let b_white = (raw.whitelevels.get(b_color).copied().unwrap_or(raw.whitelevels[0]) as f32).max(b_black + 1.0);

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
            let norm = |v: u16, black: f32, white: f32| ((v as f32 - black) / (white - black)).clamp(0.0, 1.0);

            let r_val = norm(data[(sy + r_pos.1) * w + sx + r_pos.0], r_black, r_white);
            let g_val = (norm(data[(sy + g1_pos.1) * w + sx + g1_pos.0], g1_black, g1_white)
                + norm(data[(sy + g2_pos.1) * w + sx + g2_pos.0], g2_black, g2_white))
                * 0.5;
            let b_val = norm(data[(sy + b_pos.1) * w + sx + b_pos.0], b_black, b_white);

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
        summary.orientation = exif
            .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
            .and_then(|f| f.value.get_uint(0))
            .unwrap_or(1);
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
/// inside an image of size (w, h) rotated by `angle_deg`.
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

fn get_tiff_type_size(tag_type: u16) -> usize {
    match tag_type {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 | 13 => 4,
        5 | 10 | 12 => 8,
        _ => 0,
    }
}

fn read_uint_array(
    buf: &[u8],
    tiff_start: usize,
    entry_pos: usize,
    tag_type: u16,
    count: usize,
    is_le: bool,
) -> Vec<usize> {
    if count == 0 || (tag_type != 3 && tag_type != 4 && tag_type != 13) {
        return Vec::new();
    }
    let type_size = if tag_type == 3 { 2 } else { 4 };
    let total_bytes = count.saturating_mul(type_size);
    let read_u16 = |offset: usize| -> u16 {
        if is_le {
            u16::from_le_bytes([buf[offset], buf[offset + 1]])
        } else {
            u16::from_be_bytes([buf[offset], buf[offset + 1]])
        }
    };
    let read_u32 = |offset: usize| -> u32 {
        if is_le {
            u32::from_le_bytes([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]])
        } else {
            u32::from_be_bytes([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]])
        }
    };

    let data_offset = if total_bytes <= 4 {
        entry_pos + 8
    } else {
        if entry_pos + 12 > buf.len() {
            return Vec::new();
        }
        let val_rel = read_u32(entry_pos + 8) as usize;
        if val_rel < 8 {
            return Vec::new();
        }
        tiff_start + val_rel
    };

    if data_offset < tiff_start + 8 || data_offset + total_bytes > buf.len() {
        return Vec::new();
    }

    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        let val = if tag_type == 3 {
            read_u16(data_offset + i * 2) as usize
        } else {
            read_u32(data_offset + i * 4) as usize
        };
        result.push(val);
    }
    result
}

fn clear_disjoint_portions(
    bytes: &mut [u8],
    cand_start: usize,
    cand_end: usize,
    retained_ranges: &[(usize, usize)],
) {
    let mut overlaps: Vec<(usize, usize)> = Vec::new();
    for &(r_start, r_end) in retained_ranges {
        let o_start = cand_start.max(r_start);
        let o_end = cand_end.min(r_end);
        if o_start < o_end {
            overlaps.push((o_start, o_end));
        }
    }

    if overlaps.is_empty() {
        bytes[cand_start..cand_end].fill(0);
        return;
    }

    overlaps.sort_by_key(|&(s, _)| s);

    let mut merged: Vec<(usize, usize)> = vec![overlaps[0]];
    for &(s, e) in &overlaps[1..] {
        let last = merged.last_mut().unwrap();
        if s <= last.1 {
            last.1 = last.1.max(e);
        } else {
            merged.push((s, e));
        }
    }

    let mut cursor = cand_start;
    for (m_start, m_end) in merged {
        if m_start > cursor {
            bytes[cursor..m_start].fill(0);
        }
        cursor = cursor.max(m_end);
    }
    if cursor < cand_end {
        bytes[cursor..cand_end].fill(0);
    }
}

fn merge_ranges(ranges: &mut Vec<(usize, usize)>) {
    if ranges.len() <= 1 {
        return;
    }
    ranges.sort_by_key(|&(s, _)| s);
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
    merged.push(ranges[0]);
    for &(s, e) in &ranges[1..] {
        let last = merged.last_mut().unwrap();
        if s <= last.1 {
            last.1 = last.1.max(e);
        } else {
            merged.push((s, e));
        }
    }
    *ranges = merged;
}

const MAX_SUB_IFD_PREVIEW_CANDIDATES: usize = 256;

fn retain_sub_ifd_tree(
    bytes: &mut [u8],
    tiff_start: usize,
    root_sub_rel: usize,
    is_le: bool,
    visited: &mut std::collections::HashSet<usize>,
    retained_ranges: &mut Vec<(usize, usize)>,
    candidate_ranges: &mut Vec<(usize, usize)>,
) -> bool {
    if root_sub_rel < 8 {
        return true;
    }
    let mut worklist = vec![root_sub_rel];

    let read_u16 = |buf: &[u8], offset: usize| -> u16 {
        if is_le {
            u16::from_le_bytes([buf[offset], buf[offset + 1]])
        } else {
            u16::from_be_bytes([buf[offset], buf[offset + 1]])
        }
    };
    let read_u32 = |buf: &[u8], offset: usize| -> u32 {
        if is_le {
            u32::from_le_bytes([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]])
        } else {
            u32::from_be_bytes([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]])
        }
    };

    while let Some(sub_rel) = worklist.pop() {
        if sub_rel < 8 || !visited.insert(sub_rel) {
            continue;
        }
        if visited.len() > 256 {
            return false;
        }
        let sub_offset = tiff_start + sub_rel;
        if sub_offset < tiff_start + 8 || sub_offset + 2 > bytes.len() {
            continue;
        }

        let sub_entries = read_u16(bytes, sub_offset) as usize;
        let is_complete_table = sub_entries
            .saturating_mul(12)
            .checked_add(6)
            .and_then(|table_len| sub_offset.checked_add(table_len))
            .filter(|&sub_end| sub_end <= bytes.len());

        if let Some(sub_end) = is_complete_table {
            retained_ranges.push((sub_offset, sub_end));
        }

        let mut jpeg_offsets: Vec<usize> = Vec::new();
        let mut jpeg_lengths: Vec<usize> = Vec::new();
        let mut strip_offsets: Vec<usize> = Vec::new();
        let mut strip_byte_counts: Vec<usize> = Vec::new();

        for s in 0..sub_entries {
            let Some(entry_rel) = s.checked_mul(12) else {
                break;
            };
            let Some(s_pos) = (sub_offset + 2).checked_add(entry_rel) else {
                break;
            };
            if s_pos.checked_add(12).is_none_or(|end| end > bytes.len()) {
                break;
            }
            let s_tag = read_u16(bytes, s_pos);
            let s_type = read_u16(bytes, s_pos + 2);
            let s_count = read_u32(bytes, s_pos + 4) as usize;
            let s_bytes = s_count.saturating_mul(get_tiff_type_size(s_type));
            if is_complete_table.is_some()
                && s_tag != 0x0201
                && s_tag != 0x0202
                && s_tag != 0x0111
                && s_tag != 0x0117
                && s_bytes > 4
            {
                let s_val_rel = read_u32(bytes, s_pos + 8) as usize;
                if s_val_rel >= 8 {
                    let s_val_start = tiff_start + s_val_rel;
                    let s_val_end = s_val_start + s_bytes;
                    if s_val_start >= tiff_start + 8 && s_val_end <= bytes.len() {
                        retained_ranges.push((s_val_start, s_val_end));
                    }
                }
            }

            // Detect nested directory pointers: SubIFDs (0x014a), type 13, ExifIFD (0x8769), InteropIFD (0xa005)
            if (s_tag == 0x014a || s_type == 13 || s_tag == 0x8769 || s_tag == 0xa005) && s_count >= 1 {
                let nested_offsets = read_uint_array(
                    bytes,
                    tiff_start,
                    s_pos,
                    if s_type == 13 { 4 } else { s_type },
                    s_count,
                    is_le,
                );
                for n_rel in nested_offsets {
                    if n_rel >= 8 {
                        worklist.push(n_rel);
                    }
                }
            }

            // SubIFD image data / preview tags
            if s_tag == 0x0201 && (s_type == 3 || s_type == 4) {
                jpeg_offsets = read_uint_array(bytes, tiff_start, s_pos, s_type, s_count, is_le);
                // Zero tag reference so exported image doesn't point to cleared preview
                bytes[s_pos + 4..s_pos + 8].copy_from_slice(&[0, 0, 0, 0]);
                bytes[s_pos + 8..s_pos + 12].copy_from_slice(&[0, 0, 0, 0]);
            } else if s_tag == 0x0202 && (s_type == 3 || s_type == 4) {
                jpeg_lengths = read_uint_array(bytes, tiff_start, s_pos, s_type, s_count, is_le);
                // Zero tag reference
                bytes[s_pos + 4..s_pos + 8].copy_from_slice(&[0, 0, 0, 0]);
                bytes[s_pos + 8..s_pos + 12].copy_from_slice(&[0, 0, 0, 0]);
            } else if s_tag == 0x0111 && (s_type == 3 || s_type == 4) {
                strip_offsets = read_uint_array(bytes, tiff_start, s_pos, s_type, s_count, is_le);
                // Zero tag reference so exported image doesn't point to cleared strip data
                bytes[s_pos + 4..s_pos + 8].copy_from_slice(&[0, 0, 0, 0]);
                bytes[s_pos + 8..s_pos + 12].copy_from_slice(&[0, 0, 0, 0]);
            } else if s_tag == 0x0117 && (s_type == 3 || s_type == 4) {
                strip_byte_counts = read_uint_array(bytes, tiff_start, s_pos, s_type, s_count, is_le);
                // Zero tag reference
                bytes[s_pos + 4..s_pos + 8].copy_from_slice(&[0, 0, 0, 0]);
                bytes[s_pos + 8..s_pos + 12].copy_from_slice(&[0, 0, 0, 0]);
            }
        }

        // SubIFD JPEG preview: reject when offset and length counts differ
        if jpeg_offsets.len() != jpeg_lengths.len() {
            return false;
        }

        // SubIFD JPEG preview: add to candidate_ranges for clearing, do NOT retain
        let jpeg_count = jpeg_offsets.len();
        for j in 0..jpeg_count {
            let j_off = jpeg_offsets[j];
            let j_len = jpeg_lengths[j];
            if j_off >= 8 && j_len > 0 {
                if let Some(j_start) = tiff_start.checked_add(j_off) {
                    if let Some(j_end) = j_start.checked_add(j_len) {
                        if j_start >= tiff_start + 8 {
                            if candidate_ranges.len() >= MAX_SUB_IFD_PREVIEW_CANDIDATES {
                                return false;
                            }
                            candidate_ranges.push((j_start, j_end));
                        }
                    }
                }
            }
        }

        // SubIFD strip image data: reject when offset and byte count arrays differ in length
        if strip_offsets.len() != strip_byte_counts.len() {
            return false;
        }

        // SubIFD strip image data: add to candidate_ranges for clearing, do NOT retain
        let strip_count = strip_offsets.len();
        for s in 0..strip_count {
            let s_off = strip_offsets[s];
            let s_len = strip_byte_counts[s];
            if s_off >= 8 && s_len > 0 {
                if let Some(s_start) = tiff_start.checked_add(s_off) {
                    if let Some(s_end) = s_start.checked_add(s_len) {
                        if s_start >= tiff_start + 8 {
                            if candidate_ranges.len() >= MAX_SUB_IFD_PREVIEW_CANDIDATES {
                                return false;
                            }
                            candidate_ranges.push((s_start, s_end));
                        }
                    }
                }
            }
        }

        // Follow chained next-IFD pointer if present
        let next_ptr_offset = (sub_entries.checked_mul(12))
            .and_then(|entries_len| sub_offset.checked_add(2 + entries_len));
        if let Some(next_ptr_pos) = next_ptr_offset {
            if next_ptr_pos + 4 <= bytes.len() {
                let next_rel = read_u32(bytes, next_ptr_pos) as usize;
                if next_rel >= 8 {
                    worklist.push(next_rel);
                }
            }
        }
    }
    true
}

/// Updates EXIF APP1 metadata block for export:
/// - Resets Orientation (0x0112) to 1 (normal) if the source was rotated (orientation > 1).
/// - Updates ImageWidth (0x0100), ImageLength (0x0101) in IFD0, and PixelXDimension (0xA002),
///   PixelYDimension (0xA003) in ExifSubIFD to match the encoded output dimensions.
/// - Clears IFD1 thumbnail byte ranges (JPEG & strips) if non-overlapping with retained TIFF data,
///   and zeros the IFD1 next-pointer.
fn update_app1_exif_for_export(bytes: &mut [u8], width: u32, height: u32, orientation: u32) -> bool {
    let tiff_start = if bytes.len() >= 6 && &bytes[0..6] == b"Exif\0\0" {
        6
    } else if bytes.len() >= 10 && &bytes[4..10] == b"Exif\0\0" {
        10
    } else {
        0
    };
    if bytes.len() < tiff_start + 8 {
        return false;
    }
    let is_le = match &bytes[tiff_start..tiff_start + 2] {
        b"II" => true,
        b"MM" => false,
        _ => return false,
    };
    let read_u16 = |buf: &[u8], offset: usize| -> u16 {
        if is_le {
            u16::from_le_bytes([buf[offset], buf[offset + 1]])
        } else {
            u16::from_be_bytes([buf[offset], buf[offset + 1]])
        }
    };
    let read_u32 = |buf: &[u8], offset: usize| -> u32 {
        if is_le {
            u32::from_le_bytes([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]])
        } else {
            u32::from_be_bytes([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]])
        }
    };
    let write_u16 = |buf: &mut [u8], offset: usize, val: u16| {
        let b = if is_le { val.to_le_bytes() } else { val.to_be_bytes() };
        buf[offset] = b[0];
        buf[offset + 1] = b[1];
    };
    let write_u32 = |buf: &mut [u8], offset: usize, val: u32| {
        let b = if is_le { val.to_le_bytes() } else { val.to_be_bytes() };
        buf[offset] = b[0];
        buf[offset + 1] = b[1];
        buf[offset + 2] = b[2];
        buf[offset + 3] = b[3];
    };

    let first_ifd_rel = read_u32(bytes, tiff_start + 4) as usize;
    let ifd0_offset = tiff_start + first_ifd_rel;
    if ifd0_offset + 2 > bytes.len() {
        return false;
    }
    let entries = read_u16(bytes, ifd0_offset) as usize;
    let mut exif_sub_ifd_offset = 0;
    let mut visited_sub_ifds: std::collections::HashSet<usize> = std::collections::HashSet::new();
    visited_sub_ifds.insert(first_ifd_rel);

    let mut retained_ranges: Vec<(usize, usize)> = Vec::new();
    let mut candidate_ranges: Vec<(usize, usize)> = Vec::new();
    retained_ranges.push((0, tiff_start + 8));
    let ifd0_end = (ifd0_offset + 2 + entries * 12 + 4).min(bytes.len());
    retained_ranges.push((ifd0_offset, ifd0_end));

    for i in 0..entries {
        let entry_pos = ifd0_offset + 2 + i * 12;
        if entry_pos + 12 > bytes.len() {
            break;
        }
        let tag = read_u16(bytes, entry_pos);
        let tag_type = read_u16(bytes, entry_pos + 2);
        let count = read_u32(bytes, entry_pos + 4);

        let type_size = get_tiff_type_size(tag_type);
        let total_bytes = (count as usize).saturating_mul(type_size);
        if total_bytes > 4 {
            let val_rel = read_u32(bytes, entry_pos + 8) as usize;
            if val_rel >= 8 {
                let val_start = tiff_start + val_rel;
                let val_end = val_start + total_bytes;
                if val_start >= tiff_start + 8 && val_end <= bytes.len() {
                    retained_ranges.push((val_start, val_end));
                }
            }
        }

        // Reset orientation only when source was rotated (orientation > 1)
        if orientation > 1 && tag == 0x0112 && tag_type == 3 && count == 1 {
            write_u16(bytes, entry_pos + 8, 1);
        }

        // 0x0100 / 0x0101 = ImageWidth / ImageLength in IFD0
        if tag == 0x0100 && count == 1 {
            if tag_type == 4 {
                write_u32(bytes, entry_pos + 8, width);
            } else if tag_type == 3 {
                write_u16(bytes, entry_pos + 8, width.min(0xffff) as u16);
            }
        } else if tag == 0x0101 && count == 1 {
            if tag_type == 4 {
                write_u32(bytes, entry_pos + 8, height);
            } else if tag_type == 3 {
                write_u16(bytes, entry_pos + 8, height.min(0xffff) as u16);
            }
        }

        // 0x8769 = ExifSubIFD pointer
        if tag == 0x8769 && (tag_type == 3 || tag_type == 4) && count == 1 {
            let sub_rel = if tag_type == 4 {
                read_u32(bytes, entry_pos + 8) as usize
            } else {
                read_u16(bytes, entry_pos + 8) as usize
            };
            if sub_rel >= 8 {
                exif_sub_ifd_offset = tiff_start + sub_rel;
            }
        }

        // 0x8825 = GPSInfo IFD pointer
        if tag == 0x8825 && (tag_type == 3 || tag_type == 4) && count == 1 {
            let gps_rel = if tag_type == 4 {
                read_u32(bytes, entry_pos + 8) as usize
            } else {
                read_u16(bytes, entry_pos + 8) as usize
            };
            if gps_rel >= 8 {
                let gps_offset = tiff_start + gps_rel;
                if gps_offset >= tiff_start + 8 && gps_offset + 2 <= bytes.len() {
                    let gps_entries = read_u16(bytes, gps_offset) as usize;
                    let gps_end = (gps_offset + 2 + gps_entries * 12 + 4).min(bytes.len());
                    retained_ranges.push((gps_offset, gps_end));
                    for g in 0..gps_entries {
                        let g_pos = gps_offset + 2 + g * 12;
                        if g_pos + 12 > bytes.len() {
                            break;
                        }
                        let g_type = read_u16(bytes, g_pos + 2);
                        let g_count = read_u32(bytes, g_pos + 4) as usize;
                        let g_bytes = g_count.saturating_mul(get_tiff_type_size(g_type));
                        if g_bytes > 4 {
                            let g_val_rel = read_u32(bytes, g_pos + 8) as usize;
                            if g_val_rel >= 8 {
                                let g_val_start = tiff_start + g_val_rel;
                                let g_val_end = g_val_start + g_bytes;
                                if g_val_start >= tiff_start + 8 && g_val_end <= bytes.len() {
                                    retained_ranges.push((g_val_start, g_val_end));
                                }
                            }
                        }
                    }
                }
            }
        }

        // 0x014a = SubIFDs tag in IFD0
        if tag == 0x014a && (tag_type == 3 || tag_type == 4 || tag_type == 13) && count >= 1 {
            let sub_ifd_offsets = read_uint_array(
                bytes,
                tiff_start,
                entry_pos,
                if tag_type == 13 { 4 } else { tag_type },
                count as usize,
                is_le,
            );
            for sub_rel in sub_ifd_offsets {
                if !retain_sub_ifd_tree(
                    bytes,
                    tiff_start,
                    sub_rel,
                    is_le,
                    &mut visited_sub_ifds,
                    &mut retained_ranges,
                    &mut candidate_ranges,
                ) {
                    return false;
                }
            }
        }
    }

    // ExifSubIFD: update PixelXDimension (0xA002) and PixelYDimension (0xA003)
    if exif_sub_ifd_offset >= tiff_start + 8 && exif_sub_ifd_offset + 2 <= bytes.len() {
        let sub_entries = read_u16(bytes, exif_sub_ifd_offset) as usize;
        let sub_end = (exif_sub_ifd_offset + 2 + sub_entries * 12 + 4).min(bytes.len());
        retained_ranges.push((exif_sub_ifd_offset, sub_end));

        for j in 0..sub_entries {
            let sub_pos = exif_sub_ifd_offset + 2 + j * 12;
            if sub_pos + 12 > bytes.len() {
                break;
            }
            let sub_tag = read_u16(bytes, sub_pos);
            let sub_type = read_u16(bytes, sub_pos + 2);
            let sub_count = read_u32(bytes, sub_pos + 4);

            let sub_bytes = (sub_count as usize).saturating_mul(get_tiff_type_size(sub_type));
            if sub_bytes > 4 {
                let sub_val_rel = read_u32(bytes, sub_pos + 8) as usize;
                if sub_val_rel >= 8 {
                    let sub_val_start = tiff_start + sub_val_rel;
                    let sub_val_end = sub_val_start + sub_bytes;
                    if sub_val_start >= tiff_start + 8 && sub_val_end <= bytes.len() {
                        retained_ranges.push((sub_val_start, sub_val_end));
                    }
                }
            }

            // 0x014a = SubIFDs pointer inside ExifSubIFD
            if sub_tag == 0x014a && (sub_type == 3 || sub_type == 4 || sub_type == 13) && sub_count >= 1 {
                let sub_ifd_offsets = read_uint_array(
                    bytes,
                    tiff_start,
                    sub_pos,
                    if sub_type == 13 { 4 } else { sub_type },
                    sub_count as usize,
                    is_le,
                );
                for sub_rel in sub_ifd_offsets {
                    if !retain_sub_ifd_tree(
                        bytes,
                        tiff_start,
                        sub_rel,
                        is_le,
                        &mut visited_sub_ifds,
                        &mut retained_ranges,
                        &mut candidate_ranges,
                    ) {
                        return false;
                    }
                }
            }

            // 0xA005 = InteroperabilityIFD pointer
            if sub_tag == 0xa005 && (sub_type == 3 || sub_type == 4) && sub_count == 1 {
                let interop_rel = if sub_type == 4 {
                    read_u32(bytes, sub_pos + 8) as usize
                } else {
                    read_u16(bytes, sub_pos + 8) as usize
                };
                if interop_rel >= 8 {
                    let interop_offset = tiff_start + interop_rel;
                    if interop_offset >= tiff_start + 8 && interop_offset + 2 <= bytes.len() {
                        let interop_entries = read_u16(bytes, interop_offset) as usize;
                        let interop_end = (interop_offset + 2 + interop_entries * 12 + 4).min(bytes.len());
                        retained_ranges.push((interop_offset, interop_end));
                        for m in 0..interop_entries {
                            let m_pos = interop_offset + 2 + m * 12;
                            if m_pos + 12 > bytes.len() {
                                break;
                            }
                            let m_type = read_u16(bytes, m_pos + 2);
                            let m_count = read_u32(bytes, m_pos + 4) as usize;
                            let m_bytes = m_count.saturating_mul(get_tiff_type_size(m_type));
                            if m_bytes > 4 {
                                let m_val_rel = read_u32(bytes, m_pos + 8) as usize;
                                if m_val_rel >= 8 {
                                    let m_val_start = tiff_start + m_val_rel;
                                    let m_val_end = m_val_start + m_bytes;
                                    if m_val_start >= tiff_start + 8 && m_val_end <= bytes.len() {
                                        retained_ranges.push((m_val_start, m_val_end));
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if sub_count == 1 {
                if sub_tag == 0xa002 {
                    if sub_type == 4 {
                        write_u32(bytes, sub_pos + 8, width);
                    } else if sub_type == 3 {
                        write_u16(bytes, sub_pos + 8, width.min(0xffff) as u16);
                    }
                } else if sub_tag == 0xa003 {
                    if sub_type == 4 {
                        write_u32(bytes, sub_pos + 8, height);
                    } else if sub_type == 3 {
                        write_u16(bytes, sub_pos + 8, height.min(0xffff) as u16);
                    }
                }
            }
        }
    }

    // On exported images, clear the embedded IFD1 thumbnail bytes and zero the IFD1 pointer
    let next_ifd_offset_pos = ifd0_offset + 2 + entries * 12;
    if next_ifd_offset_pos + 4 <= bytes.len() {
        let ifd1_rel = read_u32(bytes, next_ifd_offset_pos) as usize;
        if ifd1_rel >= 8 {
            let ifd1_offset = tiff_start + ifd1_rel;
            if ifd1_offset + 2 <= bytes.len() {
                let ifd1_entries = read_u16(bytes, ifd1_offset) as usize;
                let mut jpeg_offset = 0;
                let mut jpeg_length = 0;
                let mut strip_offsets: Vec<usize> = Vec::new();
                let mut strip_byte_counts: Vec<usize> = Vec::new();

                for k in 0..ifd1_entries {
                    let ifd1_entry_pos = ifd1_offset + 2 + k * 12;
                    if ifd1_entry_pos + 12 > bytes.len() {
                        break;
                    }
                    let tag = read_u16(bytes, ifd1_entry_pos);
                    let tag_type = read_u16(bytes, ifd1_entry_pos + 2);
                    let count = read_u32(bytes, ifd1_entry_pos + 4) as usize;

                    if tag == 0x0201 && count == 1 && (tag_type == 3 || tag_type == 4) {
                        jpeg_offset = if tag_type == 4 {
                            read_u32(bytes, ifd1_entry_pos + 8) as usize
                        } else {
                            read_u16(bytes, ifd1_entry_pos + 8) as usize
                        };
                    } else if tag == 0x0202 && count == 1 && (tag_type == 3 || tag_type == 4) {
                        jpeg_length = if tag_type == 4 {
                            read_u32(bytes, ifd1_entry_pos + 8) as usize
                        } else {
                            read_u16(bytes, ifd1_entry_pos + 8) as usize
                        };
                    } else if tag == 0x0111 && (tag_type == 3 || tag_type == 4) {
                        strip_offsets = read_uint_array(bytes, tiff_start, ifd1_entry_pos, tag_type, count, is_le);
                    } else if tag == 0x0117 && (tag_type == 3 || tag_type == 4) {
                        strip_byte_counts = read_uint_array(bytes, tiff_start, ifd1_entry_pos, tag_type, count, is_le);
                    }
                }

                if jpeg_offset > 0 && jpeg_length > 0 {
                    candidate_ranges.push((tiff_start + jpeg_offset, tiff_start + jpeg_offset + jpeg_length));
                }

                let strip_count = strip_offsets.len().min(strip_byte_counts.len());
                for s in 0..strip_count {
                    let s_off = strip_offsets[s];
                    let s_len = strip_byte_counts[s];
                    if s_off > 0 && s_len > 0 {
                        candidate_ranges.push((tiff_start + s_off, tiff_start + s_off + s_len));
                    }
                }
            }
        }
        write_u32(bytes, next_ifd_offset_pos, 0);
    }

    merge_ranges(&mut retained_ranges);
    for (cand_start, cand_end) in candidate_ranges {
        let clamped_end = cand_end.min(bytes.len());
        if cand_start >= tiff_start + 8 && cand_start < clamped_end {
            clear_disjoint_portions(bytes, cand_start, clamped_end, &retained_ranges);
        }
    }
    true
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
        if let Some(mut raw_exif) = exif.raw_app1_bytes.clone() {
            if !update_app1_exif_for_export(&mut raw_exif, img.width(), img.height(), exif.orientation) {
                return Err("Failed to update EXIF metadata for export".into());
            }
            let mut parsed_jpeg = Jpeg::from_bytes(jpeg_buf.clone().into())
                .map_err(|e| format!("JPEG parse error: {e}"))?;
            parsed_jpeg.set_exif(Some(raw_exif.into()));

            let parent = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
            let file_stem = dest.file_name().and_then(|n| n.to_str()).unwrap_or("output.jpg");
            let unique_nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let tmp_path = parent.join(format!(".{file_stem}.{}.{unique_nanos}.tmp", std::process::id()));

            let out_file = File::create(&tmp_path).map_err(|e| e.to_string())?;
            if let Err(e) = parsed_jpeg.encoder().write_to(&out_file) {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(format!("EXIF write error: {e}"));
            }
            if let Err(e) = out_file.sync_all() {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(format!("File sync error: {e}"));
            }
            drop(out_file);

            std::fs::rename(&tmp_path, dest).map_err(|e| {
                let _ = std::fs::remove_file(&tmp_path);
                format!("File rename error: {e}")
            })?;
            return Ok(());
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
                if self.cfg.split_compare
                    && ui.add(egui::Slider::new(&mut self.cfg.split_pct, 5.0..=95.0).text("Split Wipe (%)")).changed()
                {
                    self.dirty = true;
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
                let mut export_cfg = self.cfg;
                export_cfg.split_compare = false;
                let out = render_pipeline(src, &export_cfg, self.auto_detected_angle);
                match save_jpeg_preserving_exif(&out, &self.exif, &export_cfg, &dest) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_update_app1_exif_preserves_retained_data_and_clears_disjoint() {
        let mut app1 = vec![0u8; 120];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        app1[2] = 0x00;
        app1[3] = 120;
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        // 'II' little-endian, 42, first IFD at rel 8
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 (byte 18): 1 entry (0x0110 Model, type 2 ASCII, count 8, valRel 60)
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x0110u16.to_le_bytes()); // Model
        app1[e0 + 2..e0 + 4].copy_from_slice(&2u16.to_le_bytes()); // ASCII
        app1[e0 + 4..e0 + 8].copy_from_slice(&8u32.to_le_bytes()); // count 8
        app1[e0 + 8..e0 + 12].copy_from_slice(&60u32.to_le_bytes()); // valRel 60
        // IFD0 next pointer: IFD1 at rel 26
        app1[e0 + 12..e0 + 16].copy_from_slice(&26u32.to_le_bytes());

        // Pre-fill gap at rel 56..60 with 0xAA
        app1[tiff_start + 56..tiff_start + 60].fill(0xaa);
        // Fill Model string at tiff_start + 60 (byte 70) with marker bytes
        app1[tiff_start + 60..tiff_start + 68].copy_from_slice(b"MYCAMERA");
        // Pre-fill gap at rel 68..76 with 0xBB
        app1[tiff_start + 68..tiff_start + 76].fill(0xbb);

        // IFD1 at rel 26 (byte 36): 2 entries (JPEGInterchangeFormat rel 56, len 20 -> covers rel 56..76)
        let ifd1 = tiff_start + 26;
        app1[ifd1..ifd1 + 2].copy_from_slice(&2u16.to_le_bytes());
        let ifd1_e0 = ifd1 + 2;
        app1[ifd1_e0..ifd1_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[ifd1_e0 + 2..ifd1_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e0 + 4..ifd1_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e0 + 8..ifd1_e0 + 12].copy_from_slice(&56u32.to_le_bytes()); // starts at rel 56

        let ifd1_e1 = ifd1_e0 + 12;
        app1[ifd1_e1..ifd1_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[ifd1_e1 + 2..ifd1_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e1 + 4..ifd1_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e1 + 8..ifd1_e1 + 12].copy_from_slice(&20u32.to_le_bytes()); // len 20 -> covers rel 56..76

        update_app1_exif_for_export(&mut app1, 1920, 1080, 1);

        // Retained Model data must remain intact!
        assert_eq!(&app1[tiff_start + 60..tiff_start + 68], b"MYCAMERA");
        // Disjoint candidate portions must be cleared to 0
        for b in &app1[tiff_start + 56..tiff_start + 60] {
            assert_eq!(*b, 0x00);
        }
        for b in &app1[tiff_start + 68..tiff_start + 76] {
            assert_eq!(*b, 0x00);
        }
        // IFD1 pointer must be zeroed
        assert_eq!(&app1[e0 + 12..e0 + 16], &[0, 0, 0, 0]);
    }

    #[test]
    fn test_update_app1_exif_preserves_gps_and_interop_overlap() {
        let mut app1 = vec![0u8; 220];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        app1[2] = 0x00;
        app1[3] = 220;
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 (len 2 + 2*12 + 4 = 30 -> rel 8..38):
        // 2 entries: ExifSubIFD (0x8769) at rel 40, GPSInfo (0x8825) at rel 90
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&2u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x8769u16.to_le_bytes()); // ExifSubIFD
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&40u32.to_le_bytes()); // rel 40

        let e1 = e0 + 12;
        app1[e1..e1 + 2].copy_from_slice(&0x8825u16.to_le_bytes()); // GPSInfo
        app1[e1 + 2..e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e1 + 4..e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e1 + 8..e1 + 12].copy_from_slice(&90u32.to_le_bytes()); // rel 90

        // IFD0 next IFD: IFD1 at rel 140 (at rel 34..38)
        app1[e1 + 12..e1 + 16].copy_from_slice(&140u32.to_le_bytes());

        // ExifSubIFD at rel 40 (len 2 + 12 + 4 = 18 bytes -> rel 40..58):
        // 1 entry: InteroperabilityIFD (0xa005) at rel 64
        let sub_ifd = tiff_start + 40;
        app1[sub_ifd..sub_ifd + 2].copy_from_slice(&1u16.to_le_bytes());
        let sub_e0 = sub_ifd + 2;
        app1[sub_e0..sub_e0 + 2].copy_from_slice(&0xa005u16.to_le_bytes());
        app1[sub_e0 + 2..sub_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e0 + 4..sub_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub_e0 + 8..sub_e0 + 12].copy_from_slice(&64u32.to_le_bytes()); // rel 64
        app1[sub_e0 + 12..sub_e0 + 16].copy_from_slice(&0u32.to_le_bytes());

        // InteroperabilityIFD at rel 64 (len 2 + 12 + 4 = 18 bytes -> rel 64..82):
        // 1 entry: InteroperabilityIndex (0x0001) ASCII count 4 "R98\0"
        let interop = tiff_start + 64;
        app1[interop..interop + 2].copy_from_slice(&1u16.to_le_bytes());
        let int_e0 = interop + 2;
        app1[int_e0..int_e0 + 2].copy_from_slice(&0x0001u16.to_le_bytes());
        app1[int_e0 + 2..int_e0 + 4].copy_from_slice(&2u16.to_le_bytes());
        app1[int_e0 + 4..int_e0 + 8].copy_from_slice(&4u32.to_le_bytes());
        app1[int_e0 + 8..int_e0 + 12].copy_from_slice(b"R98\0");
        app1[int_e0 + 12..int_e0 + 16].copy_from_slice(&0u32.to_le_bytes());

        // GPSInfo at rel 90 (len 2 + 12 + 4 = 18 bytes -> rel 90..108):
        // 1 entry: GPSLatitudeRef (0x0001) ASCII count 2 "N\0"
        let gps = tiff_start + 90;
        app1[gps..gps + 2].copy_from_slice(&1u16.to_le_bytes());
        let gps_e0 = gps + 2;
        app1[gps_e0..gps_e0 + 2].copy_from_slice(&0x0001u16.to_le_bytes());
        app1[gps_e0 + 2..gps_e0 + 4].copy_from_slice(&2u16.to_le_bytes());
        app1[gps_e0 + 4..gps_e0 + 8].copy_from_slice(&2u32.to_le_bytes());
        app1[gps_e0 + 8..gps_e0 + 10].copy_from_slice(b"N\0");
        app1[gps_e0 + 12..gps_e0 + 16].copy_from_slice(&0u32.to_le_bytes());

        // IFD1 at rel 140 with thumbnail candidate covering rel 58..116
        let ifd1 = tiff_start + 140;
        app1[ifd1..ifd1 + 2].copy_from_slice(&2u16.to_le_bytes());
        let ifd1_e0 = ifd1 + 2;
        app1[ifd1_e0..ifd1_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[ifd1_e0 + 2..ifd1_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e0 + 4..ifd1_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e0 + 8..ifd1_e0 + 12].copy_from_slice(&58u32.to_le_bytes()); // rel 58

        let ifd1_e1 = ifd1_e0 + 12;
        app1[ifd1_e1..ifd1_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[ifd1_e1 + 2..ifd1_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e1 + 4..ifd1_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e1 + 8..ifd1_e1 + 12].copy_from_slice(&58u32.to_le_bytes()); // len 58 -> rel 58..116
        app1[ifd1_e1 + 12..ifd1_e1 + 16].copy_from_slice(&0u32.to_le_bytes());

        // Fill gap rel 58..64 with 0xAA
        app1[tiff_start + 58..tiff_start + 64].fill(0xaa);
        // Fill gap rel 82..90 with 0xBB
        app1[tiff_start + 82..tiff_start + 90].fill(0xbb);
        // Fill gap rel 108..116 with 0xCC
        app1[tiff_start + 108..tiff_start + 116].fill(0xcc);

        update_app1_exif_for_export(&mut app1, 1000, 1000, 1);

        // Assert Interop directory and value intact
        assert_eq!(&app1[int_e0 + 8..int_e0 + 12], b"R98\0");
        // Assert GPS directory and value intact
        assert_eq!(&app1[gps_e0 + 8..gps_e0 + 10], b"N\0");

        // Assert gaps are zeroed
        for b in &app1[tiff_start + 58..tiff_start + 64] {
            assert_eq!(*b, 0x00);
        }
        for b in &app1[tiff_start + 82..tiff_start + 90] {
            assert_eq!(*b, 0x00);
        }
        for b in &app1[tiff_start + 108..tiff_start + 116] {
            assert_eq!(*b, 0x00);
        }

        // Assert IFD1 pointer zeroed
        assert_eq!(&app1[e1 + 12..e1 + 16], &[0, 0, 0, 0]);
    }

    #[test]
    fn test_update_app1_exif_clears_non_overlapping_strips() {
        let mut app1 = vec![0u8; 120];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        app1[2] = 0x00;
        app1[3] = 120;
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8: 0 entries, next pointer to IFD1 at rel 20
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&0u16.to_le_bytes());
        app1[ifd0 + 2..ifd0 + 6].copy_from_slice(&20u32.to_le_bytes());

        // IFD1 at rel 20: StripOffsets (0x0111) rel 70, StripByteCounts (0x0117) 20
        let ifd1 = tiff_start + 20;
        app1[ifd1..ifd1 + 2].copy_from_slice(&2u16.to_le_bytes());
        let e0 = ifd1 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x0111u16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&70u32.to_le_bytes()); // strip offset rel 70

        let e1 = e0 + 12;
        app1[e1..e1 + 2].copy_from_slice(&0x0117u16.to_le_bytes());
        app1[e1 + 2..e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e1 + 4..e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e1 + 8..e1 + 12].copy_from_slice(&20u32.to_le_bytes()); // count 20

        // Pre-fill strip at rel 70..90 with 0xFF
        app1[tiff_start + 70..tiff_start + 90].fill(0xff);

        update_app1_exif_for_export(&mut app1, 1000, 1000, 1);

        // Disjoint strip should be completely zeroed
        for b in &app1[tiff_start + 70..tiff_start + 90] {
            assert_eq!(*b, 0x00);
        }
        // IFD1 pointer zeroed
        assert_eq!(&app1[ifd0 + 2..ifd0 + 6], &[0, 0, 0, 0]);
    }

    #[test]
    fn test_update_app1_exif_clears_external_strips() {
        let mut app1 = vec![0u8; 180];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        app1[2] = 0x00;
        app1[3] = 180;
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8: 0 entries, next pointer to IFD1 at rel 20
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&0u16.to_le_bytes());
        app1[ifd0 + 2..ifd0 + 6].copy_from_slice(&20u32.to_le_bytes());

        // IFD1 at rel 20: StripOffsets (0x0111) count 2 (external at rel 60)
        //                 StripByteCounts (0x0117) count 2 (external at rel 70)
        let ifd1 = tiff_start + 20;
        app1[ifd1..ifd1 + 2].copy_from_slice(&2u16.to_le_bytes());
        let e0 = ifd1 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x0111u16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes()); // LONG
        app1[e0 + 4..e0 + 8].copy_from_slice(&2u32.to_le_bytes()); // count 2 -> 8 bytes > 4
        app1[e0 + 8..e0 + 12].copy_from_slice(&60u32.to_le_bytes()); // valRel 60

        let e1 = e0 + 12;
        app1[e1..e1 + 2].copy_from_slice(&0x0117u16.to_le_bytes());
        app1[e1 + 2..e1 + 4].copy_from_slice(&4u16.to_le_bytes()); // LONG
        app1[e1 + 4..e1 + 8].copy_from_slice(&2u32.to_le_bytes()); // count 2 -> 8 bytes > 4
        app1[e1 + 8..e1 + 12].copy_from_slice(&70u32.to_le_bytes()); // valRel 70
        app1[e1 + 12..e1 + 16].copy_from_slice(&0u32.to_le_bytes());

        // External StripOffsets at rel 60: [100, 120]
        app1[tiff_start + 60..tiff_start + 64].copy_from_slice(&100u32.to_le_bytes());
        app1[tiff_start + 64..tiff_start + 68].copy_from_slice(&120u32.to_le_bytes());

        // External StripByteCounts at rel 70: [10, 15]
        app1[tiff_start + 70..tiff_start + 74].copy_from_slice(&10u32.to_le_bytes());
        app1[tiff_start + 74..tiff_start + 78].copy_from_slice(&15u32.to_le_bytes());

        // Pre-fill strip 1 at rel 100..110 with 0x11
        app1[tiff_start + 100..tiff_start + 110].fill(0x11);
        // Pre-fill strip 2 at rel 120..135 with 0x22
        app1[tiff_start + 120..tiff_start + 135].fill(0x22);

        update_app1_exif_for_export(&mut app1, 1000, 1000, 1);

        // Both referenced strips must be zeroed
        for b in &app1[tiff_start + 100..tiff_start + 110] {
            assert_eq!(*b, 0x00);
        }
        for b in &app1[tiff_start + 120..tiff_start + 135] {
            assert_eq!(*b, 0x00);
        }

        // IFD1 pointer zeroed
        assert_eq!(&app1[ifd0 + 2..ifd0 + 6], &[0, 0, 0, 0]);
    }

    #[test]
    fn test_update_app1_exif_preserves_sub_ifd_overlap() {
        let total_len = 180;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 (len 2 + 1*12 + 4 = 18 -> rel 8..26):
        // 1 entry: 0x014a (SubIFDs) pointing to SubIFD1 at rel 36
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes()); // SubIFDs
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes()); // LONG
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes()); // count 1
        app1[e0 + 8..e0 + 12].copy_from_slice(&36u32.to_le_bytes()); // rel 36

        // IFD0 next pointer: IFD1 at rel 100
        app1[e0 + 12..e0 + 16].copy_from_slice(&100u32.to_le_bytes());

        // SubIFD1 at rel 36 (len 2 + 1*12 + 4 = 18 -> rel 36..54):
        // 1 entry: 0x014a (SubIFDs) pointing to Child SubIFD2 at rel 58
        let sub_ifd1 = tiff_start + 36;
        app1[sub_ifd1..sub_ifd1 + 2].copy_from_slice(&1u16.to_le_bytes());
        let sub1_e0 = sub_ifd1 + 2;
        app1[sub1_e0..sub1_e0 + 2].copy_from_slice(&0x014au16.to_le_bytes()); // nested SubIFDs
        app1[sub1_e0 + 2..sub1_e0 + 4].copy_from_slice(&4u16.to_le_bytes()); // LONG
        app1[sub1_e0 + 4..sub1_e0 + 8].copy_from_slice(&1u32.to_le_bytes()); // count 1
        app1[sub1_e0 + 8..sub1_e0 + 12].copy_from_slice(&58u32.to_le_bytes()); // rel 58
        app1[sub1_e0 + 12..sub1_e0 + 16].copy_from_slice(&0u32.to_le_bytes());

        // Child SubIFD2 at rel 58 (len 2 + 1*12 + 4 = 18 -> rel 58..76):
        // Lies within IFD1 thumbnail candidate range rel 30..82
        // 1 entry: 0x0100 (ImageWidth) SHORT value 1920
        let child_ifd2 = tiff_start + 58;
        app1[child_ifd2..child_ifd2 + 2].copy_from_slice(&1u16.to_le_bytes());
        let child2_e0 = child_ifd2 + 2;
        app1[child2_e0..child2_e0 + 2].copy_from_slice(&0x0100u16.to_le_bytes());
        app1[child2_e0 + 2..child2_e0 + 4].copy_from_slice(&3u16.to_le_bytes()); // SHORT
        app1[child2_e0 + 4..child2_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[child2_e0 + 8..child2_e0 + 10].copy_from_slice(&1920u16.to_le_bytes());
        app1[child2_e0 + 12..child2_e0 + 16].copy_from_slice(&0u32.to_le_bytes());

        // IFD1 at rel 100 with thumbnail candidate covering rel 30..82 (overlaps SubIFD1 and Child SubIFD2)
        let ifd1 = tiff_start + 100;
        app1[ifd1..ifd1 + 2].copy_from_slice(&2u16.to_le_bytes());
        let ifd1_e0 = ifd1 + 2;
        app1[ifd1_e0..ifd1_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[ifd1_e0 + 2..ifd1_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e0 + 4..ifd1_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e0 + 8..ifd1_e0 + 12].copy_from_slice(&30u32.to_le_bytes()); // rel 30

        let ifd1_e1 = ifd1_e0 + 12;
        app1[ifd1_e1..ifd1_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[ifd1_e1 + 2..ifd1_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e1 + 4..ifd1_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e1 + 8..ifd1_e1 + 12].copy_from_slice(&52u32.to_le_bytes()); // len 52 -> rel 30..82
        app1[ifd1_e1 + 12..ifd1_e1 + 16].copy_from_slice(&0u32.to_le_bytes());

        // Fill gap rel 30..36 with 0xAA
        app1[tiff_start + 30..tiff_start + 36].fill(0xaa);
        // Fill gap rel 54..58 with 0xCC
        app1[tiff_start + 54..tiff_start + 58].fill(0xcc);
        // Fill gap rel 76..82 with 0xBB
        app1[tiff_start + 76..tiff_start + 82].fill(0xbb);

        update_app1_exif_for_export(&mut app1, 1000, 1000, 1);

        // SubIFD1 directory and entry must remain intact
        assert_eq!(&app1[sub1_e0..sub1_e0 + 2], &0x014au16.to_le_bytes());
        assert_eq!(&app1[sub1_e0 + 8..sub1_e0 + 12], &58u32.to_le_bytes());

        // Child SubIFD2 directory and entry must remain intact (verifies nested SubIFD traversal)
        assert_eq!(&app1[child2_e0..child2_e0 + 2], &0x0100u16.to_le_bytes());
        assert_eq!(&app1[child2_e0 + 8..child2_e0 + 10], &1920u16.to_le_bytes());

        // Disjoint gaps outside retained directories must be zeroed
        for b in &app1[tiff_start + 30..tiff_start + 36] {
            assert_eq!(*b, 0x00);
        }
        for b in &app1[tiff_start + 54..tiff_start + 58] {
            assert_eq!(*b, 0x00);
        }
        for b in &app1[tiff_start + 76..tiff_start + 82] {
            assert_eq!(*b, 0x00);
        }

        // IFD1 pointer zeroed
        assert_eq!(&app1[e0 + 12..e0 + 16], &[0, 0, 0, 0]);
    }

    #[test]
    fn test_update_app1_exif_sub_ifd_chained_next_and_strips() {
        let total_len = 160;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 (len 18 -> rel 8..26):
        // 1 entry: 0x014a (SubIFDs) pointing to SubIFD1 at rel 26
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes()); // rel 26
        app1[e0 + 12..e0 + 16].copy_from_slice(&110u32.to_le_bytes()); // IFD1 at rel 110

        // SubIFD1 at rel 26 (len 2 + 2*12 + 4 = 30 -> rel 26..56):
        // Entry 0: 0x0111 (StripOffsets) LONG count 1, value 74
        // Entry 1: 0x0117 (StripByteCounts) LONG count 1, value 10 (data at rel 74..84)
        // Next pointer: chained to SubIFD2 at rel 56
        let sub1 = tiff_start + 26;
        app1[sub1..sub1 + 2].copy_from_slice(&2u16.to_le_bytes());
        let sub1_e0 = sub1 + 2;
        app1[sub1_e0..sub1_e0 + 2].copy_from_slice(&0x0111u16.to_le_bytes());
        app1[sub1_e0 + 2..sub1_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub1_e0 + 4..sub1_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub1_e0 + 8..sub1_e0 + 12].copy_from_slice(&74u32.to_le_bytes()); // strip at rel 74

        let sub1_e1 = sub1_e0 + 12;
        app1[sub1_e1..sub1_e1 + 2].copy_from_slice(&0x0117u16.to_le_bytes());
        app1[sub1_e1 + 2..sub1_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub1_e1 + 4..sub1_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub1_e1 + 8..sub1_e1 + 12].copy_from_slice(&10u32.to_le_bytes()); // strip len 10 -> rel 74..84

        // SubIFD1 next IFD pointer -> SubIFD2 at rel 56
        app1[sub1_e1 + 12..sub1_e1 + 16].copy_from_slice(&56u32.to_le_bytes());

        // Chained SubIFD2 at rel 56 (len 2 + 1*12 + 4 = 18 -> rel 56..74):
        // Entry 0: 0x0100 (ImageWidth) SHORT value 800
        let sub2 = tiff_start + 56;
        app1[sub2..sub2 + 2].copy_from_slice(&1u16.to_le_bytes());
        let sub2_e0 = sub2 + 2;
        app1[sub2_e0..sub2_e0 + 2].copy_from_slice(&0x0100u16.to_le_bytes());
        app1[sub2_e0 + 2..sub2_e0 + 4].copy_from_slice(&3u16.to_le_bytes());
        app1[sub2_e0 + 4..sub2_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub2_e0 + 8..sub2_e0 + 10].copy_from_slice(&800u16.to_le_bytes());
        // Terminator at rel 70..74 left untouched (0)
        app1[sub2_e0 + 12..sub2_e0 + 16].copy_from_slice(&0u32.to_le_bytes());

        // Put pattern in strip data rel 74..84 (leaving offsets 70–74 untouched for SubIFD2 next-IFD terminator)
        app1[tiff_start + 74..tiff_start + 84].fill(0x55);

        // IFD1 at rel 110: thumbnail candidate covering rel 50..94
        // Overlaps SubIFD1 next ptr (50..56), SubIFD2 (56..74), terminator (70..74), and strip data (74..84)
        let ifd1 = tiff_start + 110;
        app1[ifd1..ifd1 + 2].copy_from_slice(&2u16.to_le_bytes());
        let ifd1_e0 = ifd1 + 2;
        app1[ifd1_e0..ifd1_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[ifd1_e0 + 2..ifd1_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e0 + 4..ifd1_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e0 + 8..ifd1_e0 + 12].copy_from_slice(&50u32.to_le_bytes()); // rel 50

        let ifd1_e1 = ifd1_e0 + 12;
        app1[ifd1_e1..ifd1_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[ifd1_e1 + 2..ifd1_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e1 + 4..ifd1_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e1 + 8..ifd1_e1 + 12].copy_from_slice(&44u32.to_le_bytes()); // len 44 -> rel 50..94
        app1[ifd1_e1 + 12..ifd1_e1 + 16].copy_from_slice(&0u32.to_le_bytes());

        // Fill gap rel 84..94 with 0xEE
        app1[tiff_start + 84..tiff_start + 94].fill(0xee);

        update_app1_exif_for_export(&mut app1, 1000, 1000, 1);

        // Chained SubIFD2 entry must remain intact
        assert_eq!(&app1[sub2_e0..sub2_e0 + 2], &0x0100u16.to_le_bytes());
        assert_eq!(&app1[sub2_e0 + 8..sub2_e0 + 10], &800u16.to_le_bytes());

        // SubIFD2 next-IFD terminator must remain zero
        assert_eq!(&app1[sub2_e0 + 12..sub2_e0 + 16], &[0, 0, 0, 0]);

        // SubIFD strip tag references must be zeroed
        assert_eq!(&app1[sub1_e0 + 4..sub1_e0 + 12], &[0; 8]);
        assert_eq!(&app1[sub1_e1 + 4..sub1_e1 + 12], &[0; 8]);

        // SubIFD strip data at rel 74..84 must be cleared to 0
        for b in &app1[tiff_start + 74..tiff_start + 84] {
            assert_eq!(*b, 0x00);
        }

        // Gap outside retained ranges rel 84..94 must be zeroed
        for b in &app1[tiff_start + 84..tiff_start + 94] {
            assert_eq!(*b, 0x00);
        }
    }

    #[test]
    fn test_update_app1_exif_clears_sub_ifd_jpeg_preview() {
        let total_len = 160;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 pointing to SubIFD at rel 26
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes());
        app1[e0 + 12..e0 + 16].copy_from_slice(&0u32.to_le_bytes()); // No IFD1

        // SubIFD at rel 26 (len 2 + 3*12 + 4 = 42 -> rel 26..68)
        // Entry 0: 0x0100 (ImageWidth) SHORT value 1200
        // Entry 1: 0x0201 (JPEGInterchangeFormat) LONG count 1, offset 70
        // Entry 2: 0x0202 (JPEGInterchangeFormatLength) LONG count 1, length 20 (data at rel 70..90)
        let sub = tiff_start + 26;
        app1[sub..sub + 2].copy_from_slice(&3u16.to_le_bytes());
        let sub_e0 = sub + 2;
        app1[sub_e0..sub_e0 + 2].copy_from_slice(&0x0100u16.to_le_bytes());
        app1[sub_e0 + 2..sub_e0 + 4].copy_from_slice(&3u16.to_le_bytes());
        app1[sub_e0 + 4..sub_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub_e0 + 8..sub_e0 + 10].copy_from_slice(&1200u16.to_le_bytes());

        let sub_e1 = sub_e0 + 12;
        app1[sub_e1..sub_e1 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[sub_e1 + 2..sub_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e1 + 4..sub_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub_e1 + 8..sub_e1 + 12].copy_from_slice(&70u32.to_le_bytes()); // preview offset 70

        let sub_e2 = sub_e1 + 12;
        app1[sub_e2..sub_e2 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[sub_e2 + 2..sub_e2 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e2 + 4..sub_e2 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub_e2 + 8..sub_e2 + 12].copy_from_slice(&20u32.to_le_bytes()); // preview length 20 -> rel 70..90
        app1[sub_e2 + 12..sub_e2 + 16].copy_from_slice(&0u32.to_le_bytes());

        // Fill preview data at rel 70..90 with dummy JPEG marker pattern
        app1[tiff_start + 70..tiff_start + 90].fill(0x33);

        update_app1_exif_for_export(&mut app1, 1000, 1000, 1);

        // SubIFD metadata (0x0100) must remain intact
        assert_eq!(&app1[sub_e0..sub_e0 + 2], &0x0100u16.to_le_bytes());
        assert_eq!(&app1[sub_e0 + 8..sub_e0 + 10], &1200u16.to_le_bytes());

        // SubIFD 0x0201 and 0x0202 tag references must be zeroed
        assert_eq!(&app1[sub_e1 + 4..sub_e1 + 12], &[0; 8]);
        assert_eq!(&app1[sub_e2 + 4..sub_e2 + 12], &[0; 8]);

        // Preview bytes at rel 70..90 must be zeroed
        for b in &app1[tiff_start + 70..tiff_start + 90] {
            assert_eq!(*b, 0x00);
        }
    }

    #[test]
    fn test_update_app1_exif_preserves_deep_sub_ifd() {
        // Construct a chain of 6 SubIFDs (depth 6)
        let total_len = 300;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 pointing to SubIFD 0 at rel 30, with IFD1 at rel 200
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&30u32.to_le_bytes()); // rel 30
        app1[e0 + 12..e0 + 16].copy_from_slice(&200u32.to_le_bytes()); // IFD1 at rel 200

        // Chain of SubIFDs: rel 30 -> 50 -> 70 -> 90 -> 110 -> 150 (depth 6)
        let offsets = [30, 50, 70, 90, 110, 150];
        for i in 0..5 {
            let cur = tiff_start + offsets[i];
            app1[cur..cur + 2].copy_from_slice(&1u16.to_le_bytes());
            let entry = cur + 2;
            app1[entry..entry + 2].copy_from_slice(&0x014au16.to_le_bytes());
            app1[entry + 2..entry + 4].copy_from_slice(&4u16.to_le_bytes());
            app1[entry + 4..entry + 8].copy_from_slice(&1u32.to_le_bytes());
            app1[entry + 8..entry + 12].copy_from_slice(&(offsets[i + 1] as u32).to_le_bytes());
            app1[entry + 12..entry + 16].copy_from_slice(&0u32.to_le_bytes());
        }

        // Deepest SubIFD at rel 150 (depth 6): len 18 -> rel 150..168
        let deep = tiff_start + 150;
        app1[deep..deep + 2].copy_from_slice(&1u16.to_le_bytes());
        let deep_e0 = deep + 2;
        app1[deep_e0..deep_e0 + 2].copy_from_slice(&0x0100u16.to_le_bytes());
        app1[deep_e0 + 2..deep_e0 + 4].copy_from_slice(&3u16.to_le_bytes());
        app1[deep_e0 + 4..deep_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[deep_e0 + 8..deep_e0 + 10].copy_from_slice(&4096u16.to_le_bytes());
        app1[deep_e0 + 12..deep_e0 + 16].copy_from_slice(&0u32.to_le_bytes());

        // IFD1 at rel 200: thumbnail candidate covering rel 140..180
        // Overlaps the deep SubIFD at rel 150..168!
        let ifd1 = tiff_start + 200;
        app1[ifd1..ifd1 + 2].copy_from_slice(&2u16.to_le_bytes());
        let ifd1_e0 = ifd1 + 2;
        app1[ifd1_e0..ifd1_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[ifd1_e0 + 2..ifd1_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e0 + 4..ifd1_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e0 + 8..ifd1_e0 + 12].copy_from_slice(&140u32.to_le_bytes()); // rel 140

        let ifd1_e1 = ifd1_e0 + 12;
        app1[ifd1_e1..ifd1_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[ifd1_e1 + 2..ifd1_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e1 + 4..ifd1_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e1 + 8..ifd1_e1 + 12].copy_from_slice(&40u32.to_le_bytes()); // len 40 -> rel 140..180
        app1[ifd1_e1 + 12..ifd1_e1 + 16].copy_from_slice(&0u32.to_le_bytes());

        // Gaps outside deep SubIFD:
        // rel 140..150 filled with 0xAA
        app1[tiff_start + 140..tiff_start + 150].fill(0xaa);
        // rel 168..180 filled with 0xBB
        app1[tiff_start + 168..tiff_start + 180].fill(0xbb);

        update_app1_exif_for_export(&mut app1, 1000, 1000, 1);

        // Deep SubIFD at depth 6 must be preserved!
        assert_eq!(&app1[deep_e0..deep_e0 + 2], &0x0100u16.to_le_bytes());
        assert_eq!(&app1[deep_e0 + 8..deep_e0 + 10], &4096u16.to_le_bytes());

        // Gaps outside retained deep SubIFD must be zeroed
        for b in &app1[tiff_start + 140..tiff_start + 150] {
            assert_eq!(*b, 0x00);
        }
        for b in &app1[tiff_start + 168..tiff_start + 180] {
            assert_eq!(*b, 0x00);
        }
    }

    #[test]
    fn test_compute_raw_crop_margins() {
        // Sensor width 100, right margin 1 -> expects crop of 1
        let (top, right, bottom, left) =
            compute_raw_crop_margins(100, 100, [0, 1, 0, 0], 50, 50).unwrap();
        assert_eq!(right, 1);
        assert_eq!(left, 0);
        assert_eq!(top, 0);
        assert_eq!(bottom, 0);

        // Sensor width 101, right margin 1 -> active width 100, out_w 50 -> expects crop of 0
        let (_, right, _, _) = compute_raw_crop_margins(101, 100, [0, 1, 0, 0], 50, 50).unwrap();
        assert_eq!(right, 0);

        // Sensor width 100, left margin 4, right margin 4 -> out_w 50 -> expects left 2, right 2
        let (_, right, _, left) = compute_raw_crop_margins(100, 100, [0, 4, 0, 4], 50, 50).unwrap();
        assert_eq!(left, 2);
        assert_eq!(right, 2);

        // Odd top margin 1 -> rounds up to 1
        let (top, _, _, _) = compute_raw_crop_margins(100, 100, [1, 0, 0, 0], 50, 50).unwrap();
        assert_eq!(top, 1);

        // Odd left margin 1 -> rounds up to 1
        let (_, _, _, left) = compute_raw_crop_margins(100, 100, [0, 0, 0, 1], 50, 50).unwrap();
        assert_eq!(left, 1);

        // Sensor height 100, bottom margin 1 -> expects bottom crop of 1
        let (top, _, bottom, _) = compute_raw_crop_margins(100, 100, [0, 0, 1, 0], 50, 50).unwrap();
        assert_eq!(bottom, 1);
        assert_eq!(top, 0);

        // Invalid raw margins exceeding sensor bounds should error
        assert!(compute_raw_crop_margins(100, 100, [60, 0, 50, 0], 50, 50).is_err());
        assert!(compute_raw_crop_margins(100, 100, [0, 60, 0, 50], 50, 50).is_err());
    }

    #[test]
    fn test_update_app1_exif_rejects_truncated_sub_ifd_table() {
        let total_len = 80;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 (len 18 -> rel 8..26)
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes()); // SubIFD at rel 26
        app1[e0 + 12..e0 + 16].copy_from_slice(&40u32.to_le_bytes()); // IFD1 at rel 40

        // SubIFD at rel 26: claims 20 entries (2 + 20*12 + 4 = 246 bytes), but total_len is only 80!
        let sub = tiff_start + 26;
        app1[sub..sub + 2].copy_from_slice(&20u16.to_le_bytes());

        // Fill bytes at rel 28..38 with dummy pattern 0x77
        app1[sub + 2..sub + 12].fill(0x77);

        // IFD1 at rel 40: candidate range covering rel 26..38 (overlapping truncated SubIFD)
        let ifd1 = tiff_start + 40;
        app1[ifd1..ifd1 + 2].copy_from_slice(&2u16.to_le_bytes());
        let ifd1_e0 = ifd1 + 2;
        app1[ifd1_e0..ifd1_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[ifd1_e0 + 2..ifd1_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e0 + 4..ifd1_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e0 + 8..ifd1_e0 + 12].copy_from_slice(&26u32.to_le_bytes()); // rel 26

        let ifd1_e1 = ifd1_e0 + 12;
        app1[ifd1_e1..ifd1_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[ifd1_e1 + 2..ifd1_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[ifd1_e1 + 4..ifd1_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[ifd1_e1 + 8..ifd1_e1 + 12].copy_from_slice(&12u32.to_le_bytes()); // len 12 -> rel 26..38
        app1[ifd1_e1 + 12..ifd1_e1 + 16].copy_from_slice(&0u32.to_le_bytes());

        assert!(update_app1_exif_for_export(&mut app1, 1000, 1000, 1));

        // Truncated SubIFD table was rejected and NOT retained, so candidate bytes at rel 26..38 must be zeroed!
        for b in &app1[sub..sub + 12] {
            assert_eq!(*b, 0x00);
        }
    }

    #[test]
    fn test_update_app1_exif_multi_jpeg_preview_clearing() {
        let total_len = 160;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 pointing to SubIFD at rel 26
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes());
        app1[e0 + 12..e0 + 16].copy_from_slice(&0u32.to_le_bytes());

        // SubIFD at rel 26 (len 2 + 2*12 + 4 = 30 -> rel 26..56)
        // Entry 0: 0x0201 (JPEGInterchangeFormat) LONG count 2, offset table at rel 56
        // Entry 1: 0x0202 (JPEGInterchangeFormatLength) LONG count 2, length table at rel 64
        let sub = tiff_start + 26;
        app1[sub..sub + 2].copy_from_slice(&2u16.to_le_bytes());
        let sub_e0 = sub + 2;
        app1[sub_e0..sub_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[sub_e0 + 2..sub_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e0 + 4..sub_e0 + 8].copy_from_slice(&2u32.to_le_bytes());
        app1[sub_e0 + 8..sub_e0 + 12].copy_from_slice(&56u32.to_le_bytes()); // table at rel 56

        let sub_e1 = sub_e0 + 12;
        app1[sub_e1..sub_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[sub_e1 + 2..sub_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e1 + 4..sub_e1 + 8].copy_from_slice(&2u32.to_le_bytes());
        app1[sub_e1 + 8..sub_e1 + 12].copy_from_slice(&64u32.to_le_bytes()); // table at rel 64
        app1[sub_e1 + 12..sub_e1 + 16].copy_from_slice(&0u32.to_le_bytes());

        // Offsets table at rel 56: [72, 86]
        app1[tiff_start + 56..tiff_start + 60].copy_from_slice(&72u32.to_le_bytes());
        app1[tiff_start + 60..tiff_start + 64].copy_from_slice(&86u32.to_le_bytes());

        // Lengths table at rel 64: [10, 10]
        app1[tiff_start + 64..tiff_start + 68].copy_from_slice(&10u32.to_le_bytes());
        app1[tiff_start + 68..tiff_start + 72].copy_from_slice(&10u32.to_le_bytes());

        // Fill preview slice 1 (rel 72..82) and preview slice 2 (rel 86..96)
        app1[tiff_start + 72..tiff_start + 82].fill(0x11);
        app1[tiff_start + 86..tiff_start + 96].fill(0x22);

        assert!(update_app1_exif_for_export(&mut app1, 1000, 1000, 1));

        // Both preview slices must be cleared to 0
        for b in &app1[tiff_start + 72..tiff_start + 82] {
            assert_eq!(*b, 0x00);
        }
        for b in &app1[tiff_start + 86..tiff_start + 96] {
            assert_eq!(*b, 0x00);
        }

        // Tag references must be zeroed
        assert_eq!(&app1[sub_e0 + 4..sub_e0 + 12], &[0; 8]);
        assert_eq!(&app1[sub_e1 + 4..sub_e1 + 12], &[0; 8]);
    }

    #[test]
    fn test_update_app1_exif_fails_when_directory_limit_exceeded() {
        // Construct a file with 260 SubIFDs in a chain
        let num_ifds = 260;
        let total_len = 10 + 8 + 18 + num_ifds * 18 + 100;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 pointing to SubIFD 0 at rel 26
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes());
        app1[e0 + 12..e0 + 16].copy_from_slice(&0u32.to_le_bytes());

        // Chain 260 SubIFDs
        for i in 0..num_ifds {
            let cur_rel = 26 + i * 18;
            let cur = tiff_start + cur_rel;
            app1[cur..cur + 2].copy_from_slice(&1u16.to_le_bytes());
            let entry = cur + 2;
            app1[entry..entry + 2].copy_from_slice(&0x0100u16.to_le_bytes());
            app1[entry + 2..entry + 4].copy_from_slice(&3u16.to_le_bytes());
            app1[entry + 4..entry + 8].copy_from_slice(&1u32.to_le_bytes());
            app1[entry + 8..entry + 10].copy_from_slice(&100u16.to_le_bytes());
            if i + 1 < num_ifds {
                let next_rel = (cur_rel + 18) as u32;
                app1[entry + 12..entry + 16].copy_from_slice(&next_rel.to_le_bytes());
            } else {
                app1[entry + 12..entry + 16].copy_from_slice(&0u32.to_le_bytes());
            }
        }

        // Limit of 256 visited directories must cause update_app1_exif_for_export to return false
        assert!(!update_app1_exif_for_export(&mut app1, 1000, 1000, 1));
    }

    #[test]
    fn test_update_app1_exif_truncated_sub_ifd_clears_previews_in_readable_prefix() {
        let total_len = 120;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 pointing to SubIFD at rel 26
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes()); // SubIFD at rel 26
        app1[e0 + 12..e0 + 16].copy_from_slice(&0u32.to_le_bytes()); // No IFD1

        // SubIFD at rel 26: claims 10 entries (2 + 10*12 + 4 = 126 bytes, needs total 26+126 = 152 > 110 avail).
        // Table is truncated!
        let sub = tiff_start + 26;
        app1[sub..sub + 2].copy_from_slice(&10u16.to_le_bytes());

        // Entry 0: 0x0201 (JPEGInterchangeFormat) LONG count 1, preview offset at rel 70
        let sub_e0 = sub + 2;
        app1[sub_e0..sub_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[sub_e0 + 2..sub_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e0 + 4..sub_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub_e0 + 8..sub_e0 + 12].copy_from_slice(&70u32.to_le_bytes()); // preview offset 70

        // Entry 1: 0x0202 (JPEGInterchangeFormatLength) LONG count 1, length 20 (rel 70..90)
        let sub_e1 = sub_e0 + 12;
        app1[sub_e1..sub_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[sub_e1 + 2..sub_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e1 + 4..sub_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub_e1 + 8..sub_e1 + 12].copy_from_slice(&20u32.to_le_bytes()); // preview length 20

        // Fill preview data at rel 70..90 with 0xaa
        app1[tiff_start + 70..tiff_start + 90].fill(0xaa);

        assert!(update_app1_exif_for_export(&mut app1, 1000, 1000, 1));

        // Preview bytes at rel 70..90 must be cleared to 0
        for b in &app1[tiff_start + 70..tiff_start + 90] {
            assert_eq!(*b, 0x00);
        }

        // SubIFD 0x0201 and 0x0202 tag references must be zeroed
        assert_eq!(&app1[sub_e0 + 4..sub_e0 + 12], &[0; 8]);
        assert_eq!(&app1[sub_e1 + 4..sub_e1 + 12], &[0; 8]);
    }

    #[test]
    fn test_update_app1_exif_rejects_sub_ifd_with_mismatched_jpeg_counts() {
        let total_len = 160;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 pointing to SubIFD at rel 26
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes());
        app1[e0 + 12..e0 + 16].copy_from_slice(&0u32.to_le_bytes());

        // SubIFD at rel 26: 0x0201 count 2, but 0x0202 count 1
        let sub = tiff_start + 26;
        app1[sub..sub + 2].copy_from_slice(&2u16.to_le_bytes());
        let sub_e0 = sub + 2;
        app1[sub_e0..sub_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[sub_e0 + 2..sub_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e0 + 4..sub_e0 + 8].copy_from_slice(&2u32.to_le_bytes());
        app1[sub_e0 + 8..sub_e0 + 12].copy_from_slice(&56u32.to_le_bytes()); // table at rel 56

        let sub_e1 = sub_e0 + 12;
        app1[sub_e1..sub_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[sub_e1 + 2..sub_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e1 + 4..sub_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub_e1 + 8..sub_e1 + 12].copy_from_slice(&10u32.to_le_bytes()); // single length

        // Offsets table at rel 56: [72, 86]
        app1[tiff_start + 56..tiff_start + 60].copy_from_slice(&72u32.to_le_bytes());
        app1[tiff_start + 60..tiff_start + 64].copy_from_slice(&86u32.to_le_bytes());

        assert!(!update_app1_exif_for_export(&mut app1, 1000, 1000, 1));
    }

    #[test]
    fn test_update_app1_exif_rejects_sub_ifd_with_mismatched_strip_counts() {
        let total_len = 160;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 pointing to SubIFD at rel 26
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes());
        app1[e0 + 12..e0 + 16].copy_from_slice(&0u32.to_le_bytes());

        // SubIFD at rel 26: 0x0111 (StripOffsets) count 2, but 0x0117 (StripByteCounts) count 1
        let sub = tiff_start + 26;
        app1[sub..sub + 2].copy_from_slice(&2u16.to_le_bytes());
        let sub_e0 = sub + 2;
        app1[sub_e0..sub_e0 + 2].copy_from_slice(&0x0111u16.to_le_bytes());
        app1[sub_e0 + 2..sub_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e0 + 4..sub_e0 + 8].copy_from_slice(&2u32.to_le_bytes());
        app1[sub_e0 + 8..sub_e0 + 12].copy_from_slice(&56u32.to_le_bytes()); // table at rel 56

        let sub_e1 = sub_e0 + 12;
        app1[sub_e1..sub_e1 + 2].copy_from_slice(&0x0117u16.to_le_bytes());
        app1[sub_e1 + 2..sub_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e1 + 4..sub_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub_e1 + 8..sub_e1 + 12].copy_from_slice(&10u32.to_le_bytes()); // single byte count

        // Offsets table at rel 56: [72, 86]
        app1[tiff_start + 56..tiff_start + 60].copy_from_slice(&72u32.to_le_bytes());
        app1[tiff_start + 60..tiff_start + 64].copy_from_slice(&86u32.to_le_bytes());

        assert!(!update_app1_exif_for_export(&mut app1, 1000, 1000, 1));
    }

    #[test]
    fn test_update_app1_exif_fails_when_preview_candidates_cap_exceeded() {
        let count = MAX_SUB_IFD_PREVIEW_CANDIDATES + 1;
        let total_len = 10 + 26 + 30 + count * 4 * 2 + 100;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 pointing to SubIFD at rel 26
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes());

        // SubIFD at rel 26
        let sub = tiff_start + 26;
        app1[sub..sub + 2].copy_from_slice(&2u16.to_le_bytes());
        let sub_e0 = sub + 2;
        app1[sub_e0..sub_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[sub_e0 + 2..sub_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e0 + 4..sub_e0 + 8].copy_from_slice(&(count as u32).to_le_bytes());
        let offsets_rel = 60;
        app1[sub_e0 + 8..sub_e0 + 12].copy_from_slice(&(offsets_rel as u32).to_le_bytes());

        let sub_e1 = sub_e0 + 12;
        app1[sub_e1..sub_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[sub_e1 + 2..sub_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e1 + 4..sub_e1 + 8].copy_from_slice(&(count as u32).to_le_bytes());
        let lengths_rel = offsets_rel + count * 4;
        app1[sub_e1 + 8..sub_e1 + 12].copy_from_slice(&(lengths_rel as u32).to_le_bytes());

        // Populate valid offsets and lengths
        for i in 0..count {
            let off = (lengths_rel + count * 4 + i * 4) as u32;
            app1[tiff_start + offsets_rel + i * 4..tiff_start + offsets_rel + (i + 1) * 4]
                .copy_from_slice(&off.to_le_bytes());
            app1[tiff_start + lengths_rel + i * 4..tiff_start + lengths_rel + (i + 1) * 4]
                .copy_from_slice(&4u32.to_le_bytes());
        }

        assert!(!update_app1_exif_for_export(&mut app1, 1000, 1000, 1));
    }

    #[test]
    fn test_update_app1_exif_fails_when_strip_candidates_cap_exceeded() {
        let count = MAX_SUB_IFD_PREVIEW_CANDIDATES + 1;
        let total_len = 10 + 26 + 30 + count * 4 * 2 + 100;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 pointing to SubIFD at rel 26
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes());

        // SubIFD at rel 26 using StripOffsets (0x0111) and StripByteCounts (0x0117)
        let sub = tiff_start + 26;
        app1[sub..sub + 2].copy_from_slice(&2u16.to_le_bytes());
        let sub_e0 = sub + 2;
        app1[sub_e0..sub_e0 + 2].copy_from_slice(&0x0111u16.to_le_bytes());
        app1[sub_e0 + 2..sub_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e0 + 4..sub_e0 + 8].copy_from_slice(&(count as u32).to_le_bytes());
        let offsets_rel = 60;
        app1[sub_e0 + 8..sub_e0 + 12].copy_from_slice(&(offsets_rel as u32).to_le_bytes());

        let sub_e1 = sub_e0 + 12;
        app1[sub_e1..sub_e1 + 2].copy_from_slice(&0x0117u16.to_le_bytes());
        app1[sub_e1 + 2..sub_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e1 + 4..sub_e1 + 8].copy_from_slice(&(count as u32).to_le_bytes());
        let lengths_rel = offsets_rel + count * 4;
        app1[sub_e1 + 8..sub_e1 + 12].copy_from_slice(&(lengths_rel as u32).to_le_bytes());

        for i in 0..count {
            let off = (lengths_rel + count * 4 + i * 4) as u32;
            app1[tiff_start + offsets_rel + i * 4..tiff_start + offsets_rel + (i + 1) * 4]
                .copy_from_slice(&off.to_le_bytes());
            app1[tiff_start + lengths_rel + i * 4..tiff_start + lengths_rel + (i + 1) * 4]
                .copy_from_slice(&4u32.to_le_bytes());
        }

        assert!(!update_app1_exif_for_export(&mut app1, 1000, 1000, 1));
    }

    #[test]
    fn test_update_app1_exif_traverses_sub_ifd_in_exif_sub_ifd() {
        let total_len = 160;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");

        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 pointing to ExifSubIFD (0x8769) at rel 26
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x8769u16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes()); // ExifSubIFD at rel 26

        // ExifSubIFD at rel 26 pointing to SubIFD (0x014a) at rel 50
        let exif_sub = tiff_start + 26;
        app1[exif_sub..exif_sub + 2].copy_from_slice(&1u16.to_le_bytes());
        let exif_e0 = exif_sub + 2;
        app1[exif_e0..exif_e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[exif_e0 + 2..exif_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[exif_e0 + 4..exif_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[exif_e0 + 8..exif_e0 + 12].copy_from_slice(&50u32.to_le_bytes()); // SubIFD at rel 50

        // SubIFD at rel 50: preview at rel 90, len 15
        let sub = tiff_start + 50;
        app1[sub..sub + 2].copy_from_slice(&2u16.to_le_bytes());
        let sub_e0 = sub + 2;
        app1[sub_e0..sub_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[sub_e0 + 2..sub_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e0 + 4..sub_e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub_e0 + 8..sub_e0 + 12].copy_from_slice(&90u32.to_le_bytes()); // preview offset 90

        let sub_e1 = sub_e0 + 12;
        app1[sub_e1..sub_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[sub_e1 + 2..sub_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e1 + 4..sub_e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[sub_e1 + 8..sub_e1 + 12].copy_from_slice(&15u32.to_le_bytes()); // preview length 15

        // Fill preview data at rel 90..105 with 0x33
        app1[tiff_start + 90..tiff_start + 105].fill(0x33);

        assert!(update_app1_exif_for_export(&mut app1, 1000, 1000, 1));

        // Preview bytes at rel 90..105 must be cleared to 0
        for b in &app1[tiff_start + 90..tiff_start + 105] {
            assert_eq!(*b, 0x00);
        }

        // SubIFD tags must be zeroed
        assert_eq!(&app1[sub_e0 + 4..sub_e0 + 12], &[0; 8]);
        assert_eq!(&app1[sub_e1 + 4..sub_e1 + 12], &[0; 8]);
    }

    #[test]
    fn test_save_jpeg_preserving_exif_fails_on_exif_update_failure() {
        let img = RgbaImage::new(10, 10);
        let mut exif = ExifSummary::default();
        // Malformed EXIF where 0x0201 and 0x0202 counts differ (update_app1_exif_for_export returns false)
        let total_len = 160;
        let mut app1 = vec![0u8; total_len];
        app1[0] = 0xff;
        app1[1] = 0xe1;
        let marker_len = (total_len - 2) as u16;
        app1[2..4].copy_from_slice(&marker_len.to_be_bytes());
        app1[4..10].copy_from_slice(b"Exif\0\0");
        let tiff_start = 10;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&1u16.to_le_bytes());
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x014au16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&26u32.to_le_bytes());
        let sub = tiff_start + 26;
        app1[sub..sub + 2].copy_from_slice(&2u16.to_le_bytes());
        let sub_e0 = sub + 2;
        app1[sub_e0..sub_e0 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        app1[sub_e0 + 2..sub_e0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e0 + 4..sub_e0 + 8].copy_from_slice(&2u32.to_le_bytes()); // count 2
        app1[sub_e0 + 8..sub_e0 + 12].copy_from_slice(&56u32.to_le_bytes());
        let sub_e1 = sub_e0 + 12;
        app1[sub_e1..sub_e1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        app1[sub_e1 + 2..sub_e1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[sub_e1 + 4..sub_e1 + 8].copy_from_slice(&1u32.to_le_bytes()); // count 1 (mismatch)
        app1[sub_e1 + 8..sub_e1 + 12].copy_from_slice(&10u32.to_le_bytes());

        exif.raw_app1_bytes = Some(app1);

        let mut cfg = ProcessConfig::default();
        cfg.preserve_exif = true;

        let dest = std::env::temp_dir().join("test_save_jpeg_preserving_exif_err.jpg");
        if dest.exists() {
            let _ = std::fs::remove_file(&dest);
        }

        let res = save_jpeg_preserving_exif(&img, &exif, &cfg, &dest);
        assert!(res.is_err());
        assert!(!dest.exists());
    }

    #[test]
    fn test_save_jpeg_preserving_exif_succeeds_and_updates_metadata() {
        let img = RgbaImage::from_pixel(32, 24, Rgba([200, 100, 50, 255]));
        let mut exif = ExifSummary::default();
        exif.orientation = 6; // Source had 90° CW orientation, should be reset to 1 on export

        // Construct valid raw_app1_bytes (Exif\0\0 + TIFF header + IFD0 + ExifSubIFD)
        let mut app1 = vec![0u8; 160];
        app1[0..6].copy_from_slice(b"Exif\0\0");
        let tiff_start = 6;
        app1[tiff_start..tiff_start + 2].copy_from_slice(b"II");
        app1[tiff_start + 2..tiff_start + 4].copy_from_slice(&42u16.to_le_bytes());
        app1[tiff_start + 4..tiff_start + 8].copy_from_slice(&8u32.to_le_bytes());

        // IFD0 at rel 8 (5 entries: ImageWidth 0x0100, ImageLength 0x0101, Model 0x0110, Orientation 0x0112, ExifSubIFD 0x8769)
        let ifd0 = tiff_start + 8;
        app1[ifd0..ifd0 + 2].copy_from_slice(&5u16.to_le_bytes());

        // Entry 0: 0x0100 ImageWidth = 100 (will be updated to 32)
        let e0 = ifd0 + 2;
        app1[e0..e0 + 2].copy_from_slice(&0x0100u16.to_le_bytes());
        app1[e0 + 2..e0 + 4].copy_from_slice(&4u16.to_le_bytes()); // LONG
        app1[e0 + 4..e0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e0 + 8..e0 + 12].copy_from_slice(&100u32.to_le_bytes());

        // Entry 1: 0x0101 ImageLength = 100 (will be updated to 24)
        let e1 = e0 + 12;
        app1[e1..e1 + 2].copy_from_slice(&0x0101u16.to_le_bytes());
        app1[e1 + 2..e1 + 4].copy_from_slice(&4u16.to_le_bytes()); // LONG
        app1[e1 + 4..e1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e1 + 8..e1 + 12].copy_from_slice(&100u32.to_le_bytes());

        // Entry 2: 0x0110 Model = "TESTCAM\0" at rel 120
        let e2 = e1 + 12;
        app1[e2..e2 + 2].copy_from_slice(&0x0110u16.to_le_bytes());
        app1[e2 + 2..e2 + 4].copy_from_slice(&2u16.to_le_bytes()); // ASCII
        app1[e2 + 4..e2 + 8].copy_from_slice(&8u32.to_le_bytes());
        app1[e2 + 8..e2 + 12].copy_from_slice(&120u32.to_le_bytes());
        app1[tiff_start + 120..tiff_start + 128].copy_from_slice(b"TESTCAM\0");

        // Entry 3: 0x0112 Orientation = 6 (will be reset to 1)
        let e3 = e2 + 12;
        app1[e3..e3 + 2].copy_from_slice(&0x0112u16.to_le_bytes());
        app1[e3 + 2..e3 + 4].copy_from_slice(&3u16.to_le_bytes()); // SHORT
        app1[e3 + 4..e3 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e3 + 8..e3 + 10].copy_from_slice(&6u16.to_le_bytes());

        // Entry 4: 0x8769 ExifSubIFD at rel 80
        let e4 = e3 + 12;
        app1[e4..e4 + 2].copy_from_slice(&0x8769u16.to_le_bytes());
        app1[e4 + 2..e4 + 4].copy_from_slice(&4u16.to_le_bytes()); // LONG
        app1[e4 + 4..e4 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[e4 + 8..e4 + 12].copy_from_slice(&80u32.to_le_bytes());
        app1[e4 + 12..e4 + 16].copy_from_slice(&0u32.to_le_bytes()); // next IFD = 0

        // ExifSubIFD at rel 80 (2 entries: PixelXDimension 0xA002, PixelYDimension 0xA003)
        let sub = tiff_start + 80;
        app1[sub..sub + 2].copy_from_slice(&2u16.to_le_bytes());
        let s0 = sub + 2;
        app1[s0..s0 + 2].copy_from_slice(&0xa002u16.to_le_bytes());
        app1[s0 + 2..s0 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[s0 + 4..s0 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[s0 + 8..s0 + 12].copy_from_slice(&100u32.to_le_bytes());

        let s1 = s0 + 12;
        app1[s1..s1 + 2].copy_from_slice(&0xa003u16.to_le_bytes());
        app1[s1 + 2..s1 + 4].copy_from_slice(&4u16.to_le_bytes());
        app1[s1 + 4..s1 + 8].copy_from_slice(&1u32.to_le_bytes());
        app1[s1 + 8..s1 + 12].copy_from_slice(&100u32.to_le_bytes());
        app1[s1 + 12..s1 + 16].copy_from_slice(&0u32.to_le_bytes());

        exif.raw_app1_bytes = Some(app1);

        let mut cfg = ProcessConfig::default();
        cfg.preserve_exif = true;

        let dest = std::env::temp_dir().join("test_save_jpeg_preserving_exif_ok.jpg");
        if dest.exists() {
            let _ = std::fs::remove_file(&dest);
        }

        let res = save_jpeg_preserving_exif(&img, &exif, &cfg, &dest);
        assert!(res.is_ok(), "Expected save_jpeg_preserving_exif to succeed, got: {:?}", res);
        assert!(dest.exists());

        let saved_bytes = std::fs::read(&dest).expect("Failed to read saved destination JPEG");
        let parsed_summary = parse_exif_from_bytes(&saved_bytes);
        assert_eq!(parsed_summary.camera_model, "TESTCAM");
        assert_eq!(parsed_summary.orientation, 1);

        let saved_exif = parsed_summary.raw_app1_bytes.expect("Saved JPEG should contain EXIF APP1 bytes");
        let saved_tiff = if saved_exif.starts_with(b"Exif\0\0") { 6 } else { 0 };
        let saved_ifd0 = saved_tiff + 8;
        let saved_e0 = saved_ifd0 + 2;
        let saved_e1 = saved_e0 + 12;
        let saved_sub = saved_tiff + 80;
        let saved_s0 = saved_sub + 2;
        let saved_s1 = saved_s0 + 12;

        // Verify updated ImageWidth (32) and ImageLength (24) in IFD0 and ExifSubIFD
        assert_eq!(u32::from_le_bytes(saved_exif[saved_e0 + 8..saved_e0 + 12].try_into().unwrap()), 32);
        assert_eq!(u32::from_le_bytes(saved_exif[saved_e1 + 8..saved_e1 + 12].try_into().unwrap()), 24);
        assert_eq!(u32::from_le_bytes(saved_exif[saved_s0 + 8..saved_s0 + 12].try_into().unwrap()), 32);
        assert_eq!(u32::from_le_bytes(saved_exif[saved_s1 + 8..saved_s1 + 12].try_into().unwrap()), 24);

        let _ = std::fs::remove_file(&dest);
    }
}