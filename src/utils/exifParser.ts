import { ExifData } from './geometry';

/**
 * Pure binary EXIF / TIFF IFD parser for JPEG (.jpg/.jpeg) and TIFF-based RAW (.dng/.cr2/.nef/.arw).
 * Zero external dependencies. Also extracts raw APP1 segment bytes for lossless JPEG re-injection.
 */

export interface ParsedFileMetadata {
  exif: ExifData;
  rawApp1Segment: Uint8Array | null;
  isRawContainer: boolean;
}

const DEFAULT_FALLBACK_EXIF: ExifData = {
  cameraModel: '',
  lensModel: '',
  focalLength: '',
  aperture: '',
  shutterSpeed: '',
  iso: '',
  dateTimeOriginal: '',
  colorSpace: 'sRGB',
};

export const SUPPORTED_RAW_EXTENSIONS = [
  'cr2',
  'nef',
  'arw',
  'dng',
  'raf',
  'orf',
  'rw2',
] as const;

export const SUPPORTED_IMAGE_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  ...SUPPORTED_RAW_EXTENSIONS,
] as const;

export const SUPPORTED_IMAGE_ACCEPT = SUPPORTED_IMAGE_EXTENSIONS.map((ext) => `.${ext}`).join(',');

export function isRawFileExtension(ext: string): boolean {
  return (SUPPORTED_RAW_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function isSupportedImageOrRawFileName(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return (SUPPORTED_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

export function parseExifFromArrayBuffer(
  buffer: ArrayBuffer,
  fileName: string
): ParsedFileMetadata {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const ext = fileName.split('.').pop()?.toLowerCase() || 'jpg';
  const isRawContainer = isRawFileExtension(ext);

  let rawApp1Segment: Uint8Array | null = null;
  let tiffOffset = -1;
  let maxTiffOffset = bytes.length;

  // Check JPEG SOI marker 0xFFD8
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break; // SOS or EOI
      const segLength = view.getUint16(offset + 2, false);
      if (segLength < 2 || offset + 2 + segLength > bytes.length) break;

      // APP1 marker (0xFFE1) with full "Exif\0\0" identifier
      if (
        marker === 0xe1 &&
        offset + 10 < bytes.length &&
        bytes[offset + 4] === 0x45 && // E
        bytes[offset + 5] === 0x78 && // x
        bytes[offset + 6] === 0x69 && // i
        bytes[offset + 7] === 0x66 && // f
        bytes[offset + 8] === 0x00 &&
        bytes[offset + 9] === 0x00
      ) {
        rawApp1Segment = bytes.slice(offset, offset + 2 + segLength);
        tiffOffset = offset + 10;
        maxTiffOffset = offset + 2 + segLength;
        break;
      }
      offset += 2 + segLength;
    }
  } else if (
    bytes.length > 8 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d))
  ) {
    // TIFF-based RAW header (II or MM)
    tiffOffset = 0;
    maxTiffOffset = view.byteLength;
  }

  const parsedTags = tiffOffset >= 0 ? readTiffIfdTags(view, tiffOffset, maxTiffOffset) : {};

  const exif: ExifData = {
    cameraModel: parsedTags.model || (isRawContainer ? `RAW Sensor (${ext.toUpperCase()})` : DEFAULT_FALLBACK_EXIF.cameraModel),
    lensModel: parsedTags.lens || DEFAULT_FALLBACK_EXIF.lensModel,
    focalLength: parsedTags.focalLength || DEFAULT_FALLBACK_EXIF.focalLength,
    aperture: parsedTags.aperture || DEFAULT_FALLBACK_EXIF.aperture,
    shutterSpeed: parsedTags.shutterSpeed || DEFAULT_FALLBACK_EXIF.shutterSpeed,
    iso: parsedTags.iso || DEFAULT_FALLBACK_EXIF.iso,
    dateTimeOriginal: parsedTags.dateTime || DEFAULT_FALLBACK_EXIF.dateTimeOriginal,
    colorSpace: isRawContainer ? '14-bit Linear RAW → sRGB' : 'sRGB IEC61966-2.1',
    rawFormat: isRawContainer ? ext.toUpperCase() : 'JPEG',
  };

  return { exif, rawApp1Segment, isRawContainer };
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * Shared work counter for JPEG stream walks. Each marker step and each entropy-coded byte
 * costs one unit, so a crafted buffer with many overlapping SOI starts cannot make the
 * fallback scan quadratic in the buffer size.
 */
interface ScanBudget {
  remaining: number;
}

interface JpegStreamScanResult {
  valid: boolean;
  endOffset: number;
  nestedSoiOffset: number;
  skippedRanges: ByteRange[];
  /** Marker byte of the first SOF frame header (0xC0..0xCF), or -1 when none was seen. */
  sofMarker: number;
  budgetExhausted: boolean;
  /** APPn payload ranges of a valid stream; nested previews may live there (e.g. MPF in APP2). */
  appRanges: ByteRange[];
}

/**
 * Walks a JPEG stream from `start` up to `maxEnd`, supporting both single-scan
 * and progressive/multi-scan JPEGs with length-delimited markers between scans.
 */
function scanJpegStream(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  maxEnd: number,
  budget?: ScanBudget
): JpegStreamScanResult {
  const invalid: JpegStreamScanResult = {
    valid: false,
    endOffset: -1,
    nestedSoiOffset: -1,
    skippedRanges: [],
    sofMarker: -1,
    budgetExhausted: false,
    appRanges: [],
  };
  if (
    start < 0 ||
    maxEnd - start < 16 ||
    maxEnd > bytes.length ||
    bytes[start] !== 0xff ||
    bytes[start + 1] !== 0xd8 ||
    bytes[start + 2] !== 0xff
  ) {
    return invalid;
  }

  let cursor = start + 2;
  let hasSof = false;
  let hasSos = false;
  let sofMarker = -1;
  const skippedRanges: ByteRange[] = [];
  const appRanges: ByteRange[] = [];
  const exhausted = (): JpegStreamScanResult => ({ ...invalid, budgetExhausted: true });

  while (cursor + 1 < maxEnd) {
    if (budget && --budget.remaining < 0) return exhausted();
    if (bytes[cursor] !== 0xff) return invalid;
    while (cursor < maxEnd && bytes[cursor] === 0xff) {
      // Every 0xFF fill byte costs one unit, so long fill runs cannot bypass the budget
      if (budget && --budget.remaining < 0) return exhausted();
      cursor++;
    }
    if (cursor >= maxEnd) return invalid;

    const marker = bytes[cursor];
    cursor++;

    if (marker === 0x00) return invalid;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0xd8) {
      return { ...invalid, nestedSoiOffset: cursor - 2, skippedRanges };
    }
    if (marker === 0xd9) {
      return hasSof && hasSos
        ? { ...invalid, valid: true, endOffset: cursor, sofMarker, appRanges }
        : invalid;
    }
    if (marker < 0xc0 || marker > 0xfe) {
      return invalid;
    }

    if (cursor + 2 > maxEnd) return invalid;
    const segLen = view.getUint16(cursor, false);
    if (segLen < 2 || cursor + segLen > maxEnd) return invalid;

    const isSofMarker =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isSofMarker) {
      if (segLen < 7 || cursor + 7 > maxEnd) return invalid;
      const frameHeight = view.getUint16(cursor + 3, false);
      const frameWidth = view.getUint16(cursor + 5, false);
      if (frameWidth <= 0 || frameHeight <= 0) return invalid;
      hasSof = true;
      if (sofMarker < 0) sofMarker = marker;
      if (segLen > 2) {
        skippedRanges.push({ start: cursor + 2, end: cursor + segLen });
      }
      cursor += segLen;
    } else if (marker === 0xda) {
      if (!hasSof || segLen < 6) return invalid;
      hasSos = true;
      if (segLen > 2) {
        skippedRanges.push({ start: cursor + 2, end: cursor + segLen });
      }
      let scan = cursor + segLen;
      let nextMarkerCursor = -1;

      while (scan + 1 < maxEnd) {
        if (budget && --budget.remaining < 0) return exhausted();
        if (bytes[scan] === 0xff) {
          let nextPos = scan + 1;
          while (nextPos < maxEnd && bytes[nextPos] === 0xff) {
            if (budget && --budget.remaining < 0) return exhausted();
            nextPos++;
          }
          if (nextPos >= maxEnd) return invalid;
          const next = bytes[nextPos];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            scan = nextPos + 1;
            continue;
          }
          if (next === 0xd8) {
            // Unescaped nested SOI inside entropy data indicates a truncated/corrupt stream
            return { ...invalid, nestedSoiOffset: nextPos - 1, skippedRanges };
          }
          if (next === 0xd9) {
            return { ...invalid, valid: true, endOffset: nextPos + 1, sofMarker, appRanges };
          }
          // Non-RST marker ends current scan's entropy data; resume marker loop to skip its segment
          nextMarkerCursor = nextPos - 1;
          break;
        }
        scan++;
      }

      if (nextMarkerCursor < 0) return invalid;
      cursor = nextMarkerCursor;
    } else {
      if (segLen > 2) {
        skippedRanges.push({ start: cursor + 2, end: cursor + segLen });
        if (marker >= 0xe0 && marker <= 0xef) {
          appRanges.push({ start: cursor + 2, end: cursor + segLen });
        }
      }
      cursor += segLen;
    }
  }

  return invalid;
}

/** Test-only access to the stream walker so budget behaviour can be asserted deterministically. */
export function scanJpegStreamForTest(
  bytes: Uint8Array,
  start: number,
  maxEnd: number,
  budget?: { remaining: number }
): { valid: boolean; endOffset: number; budgetExhausted: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const res = scanJpegStream(bytes, view, start, maxEnd, budget);
  return { valid: res.valid, endOffset: res.endOffset, budgetExhausted: res.budgetExhausted };
}

/**
 * Validates that a byte slice contains a structurally complete JPEG stream:
 * SOI (0xFFD8), at least one SOF frame header with non-zero dimensions,
 * an SOS scan header (0xFFDA), and an EOI marker (0xFFD9).
 */
export function isValidJpegSlice(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  length: number
): boolean {
  const end = start + length;
  if (start < 0 || length < 16 || end > bytes.length) {
    return false;
  }
  return scanJpegStream(bytes, view, start, end).valid;
}

/**
 * Frame types browser image decoders support: baseline (SOF0), extended sequential
 * Huffman (SOF1), and progressive Huffman (SOF2). Lossless (SOF3, used for DNG/NEF raw
 * sensor data), hierarchical, and arithmetic-coded frames are structurally valid JPEG
 * but never decode in createImageBitmap, so they are excluded from preview candidates.
 */
const BROWSER_DECODABLE_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2]);

function isDecodablePreviewScan(res: JpegStreamScanResult): boolean {
  return res.valid && BROWSER_DECODABLE_SOF_MARKERS.has(res.sofMarker);
}

/** Upper bound on browser decode attempts per RAW file (indexed + scanned candidates). */
export const MAX_RAW_PREVIEW_DECODE_ATTEMPTS = 8;

/** Minimum embedded stream size accepted by the buffer scan (filters tiny thumbnails/noise). */
const MIN_SCANNED_PREVIEW_BYTES = 512;

interface TiffHeader {
  littleEndian: boolean;
  firstIfd: number;
}

/**
 * Reads a TIFF-family header at offset 0. Besides standard TIFF/DNG/CR2/NEF/ARW (magic 42),
 * accepts Olympus ORF ('IIRO' 0x4F52, 'IIRS' 0x5352) and Panasonic RW2 ('IIU\0' 0x0055),
 * which use standard IFD layouts behind a vendor magic number.
 */
function readTiffHeader(bytes: Uint8Array, view: DataView): TiffHeader | null {
  if (bytes.length < 8) return null;
  const isTiffLE = bytes[0] === 0x49 && bytes[1] === 0x49;
  const isTiffBE = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!isTiffLE && !isTiffBE) return null;
  const littleEndian = isTiffLE;
  const magic = view.getUint16(2, littleEndian);
  if (magic !== 42 && magic !== 0x4f52 && magic !== 0x5352 && magic !== 0x0055) return null;
  return { littleEndian, firstIfd: view.getUint32(4, littleEndian) };
}

interface CandidateSlice {
  start: number;
  length: number;
}

function collectTiffIfdJpegCandidates(
  bytes: Uint8Array,
  view: DataView,
  seenOffsets: Set<string>
): CandidateSlice[] {
  const candidates: CandidateSlice[] = [];
  const recordCandidate = (start: number, length: number) => {
    const end = start + length;
    if (start < 0 || length < 16 || end > bytes.length) return;
    // Rejects lossless (SOF3) raw sensor strips so the real preview is tried first
    const res = scanJpegStream(bytes, view, start, end);
    if (!isDecodablePreviewScan(res)) return;
    // Trim padding after EOI so the slice and its key match the same stream found by the scan
    const streamLength = res.endOffset - start;
    const key = `${start}:${streamLength}`;
    if (seenOffsets.has(key)) return;
    seenOffsets.add(key);
    candidates.push({ start, length: streamLength });
  };

  // Inspect TIFF-based RAW IFD directories (IFD0, SubIFDs 0x014A, and chained IFDs)
  const header = readTiffHeader(bytes, view);
  if (header) {
    const { littleEndian } = header;
    const queue: number[] = [];
    const visited = new Set<number>();
    const firstIfd = header.firstIfd;
    if (firstIfd >= 8 && firstIfd + 2 <= bytes.length) {
      queue.push(firstIfd);
    }

    while (queue.length > 0 && visited.size < 64) {
      const ifdOffset = queue.shift()!;
      if (visited.has(ifdOffset) || ifdOffset < 8 || ifdOffset + 2 > bytes.length) continue;
      visited.add(ifdOffset);

      const entries = view.getUint16(ifdOffset, littleEndian);
      let jpegOffset = -1;
      let jpegLength = 0;
      let stripOffsets: number[] = [];
      let stripCounts: number[] = [];

      for (let i = 0; i < entries; i++) {
        const entryPos = ifdOffset + 2 + i * 12;
        if (entryPos + 12 > bytes.length) break;
        const tag = view.getUint16(entryPos, littleEndian);
        const type = view.getUint16(entryPos + 2, littleEndian);
        const count = view.getUint32(entryPos + 4, littleEndian);

        if (tag === 0x0201 && count === 1 && (type === 3 || type === 4)) {
          jpegOffset =
            type === 4
              ? view.getUint32(entryPos + 8, littleEndian)
              : view.getUint16(entryPos + 8, littleEndian);
        } else if (tag === 0x0202 && count === 1 && (type === 3 || type === 4)) {
          jpegLength =
            type === 4
              ? view.getUint32(entryPos + 8, littleEndian)
              : view.getUint16(entryPos + 8, littleEndian);
        } else if (tag === 0x0111 && (type === 3 || type === 4)) {
          stripOffsets = readUintArray(view, 0, entryPos, type, count, littleEndian, bytes.length);
        } else if (tag === 0x0117 && (type === 3 || type === 4)) {
          stripCounts = readUintArray(view, 0, entryPos, type, count, littleEndian, bytes.length);
        } else if (tag === 0x002e && type === 7 && count > 4) {
          // Panasonic RW2 JpgFromRaw: UNDEFINED bytes whose value field is the preview offset
          recordCandidate(view.getUint32(entryPos + 8, littleEndian), count);
        } else if (tag === 0x014a && (type === 3 || type === 4 || type === 13)) {
          const subOffsets = readUintArray(
            view,
            0,
            entryPos,
            type === 13 ? 4 : type,
            count,
            littleEndian,
            bytes.length
          );
          for (const sub of subOffsets) {
            if (!visited.has(sub) && sub >= 8 && sub + 2 <= bytes.length) {
              queue.push(sub);
            }
          }
        }
      }

      if (jpegOffset >= 0 && jpegLength > 0) {
        recordCandidate(jpegOffset, jpegLength);
      }
      if (stripOffsets.length === 1 && stripCounts.length === 1) {
        recordCandidate(stripOffsets[0], stripCounts[0]);
      }

      const nextIfdPos = ifdOffset + 2 + entries * 12;
      if (nextIfdPos + 4 <= bytes.length) {
        const nextIfd = view.getUint32(nextIfdPos, littleEndian);
        if (nextIfd >= 8 && nextIfd + 2 <= bytes.length && !visited.has(nextIfd)) {
          queue.push(nextIfd);
        }
      }
    }
  }

  candidates.sort((a, b) => b.length - a.length);
  return candidates;
}

function createScanBudget(bytes: Uint8Array): ScanBudget {
  // Linear work cap across all stream walks; once spent, keep what was found so far
  return { remaining: 4 * bytes.length + (1 << 20) };
}

interface BufferScanResult {
  candidates: CandidateSlice[];
  /** APP payloads inside accepted streams, revisited only if earlier candidates fail to decode. */
  deferred: ByteRange[];
}

function scanRawBufferForJpegCandidates(
  bytes: Uint8Array,
  view: DataView,
  seenOffsets: Set<string>,
  budget: ScanBudget = createScanBudget(bytes)
): BufferScanResult {
  const candidates: CandidateSlice[] = [];
  const deferred: ByteRange[] = [];

  // Locate the last EOI (0xFF 0xD9) once so candidates after it are rejected without rescanning
  let lastEoiOffset = -1;
  for (let i = bytes.length - 2; i >= 0; i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
      lastEoiOffset = i;
      break;
    }
  }
  if (lastEoiOffset <= 0) return { candidates, deferred };

  const scanBound = Math.min(bytes.length, lastEoiOffset + 2);
  let maxAcceptedEnd = 0;
  const stack: ByteRange[] = [{ start: 0, end: lastEoiOffset }];

  scanLoop: while (stack.length > 0) {
    const range = stack.pop()!;
    let pos = Math.max(range.start, maxAcceptedEnd);
    while (pos < range.end && pos + 4 < bytes.length && pos < lastEoiOffset) {
      if (bytes[pos] === 0xff && bytes[pos + 1] === 0xd8 && bytes[pos + 2] === 0xff) {
        const res = scanJpegStream(bytes, view, pos, scanBound, budget);
        if (res.budgetExhausted) break scanLoop;
        if (res.nestedSoiOffset > pos) {
          if (res.skippedRanges.length === 0) {
            pos = res.nestedSoiOffset;
            continue;
          }
          // Re-check skipped segment payloads for candidate starts before advancing to nested SOI
          if (res.nestedSoiOffset < range.end) {
            stack.push({ start: res.nestedSoiOffset, end: range.end });
          }
          for (let i = res.skippedRanges.length - 1; i >= 0; i--) {
            const seg = res.skippedRanges[i];
            const segStart = Math.max(seg.start, pos + 1);
            const segEnd = Math.min(seg.end, range.end, res.nestedSoiOffset);
            if (segStart < segEnd) {
              stack.push({ start: segStart, end: segEnd });
            }
          }
          break;
        }
        if (res.valid && res.endOffset > pos) {
          const streamLen = res.endOffset - pos;
          if (streamLen >= MIN_SCANNED_PREVIEW_BYTES && isDecodablePreviewScan(res)) {
            const key = `${pos}:${streamLen}`;
            if (!seenOffsets.has(key)) {
              seenOffsets.add(key);
              candidates.push({ start: pos, length: streamLen });
            }
          }
          deferred.push(...res.appRanges);
          maxAcceptedEnd = Math.max(maxAcceptedEnd, res.endOffset);
          pos = res.endOffset;
          continue;
        }
      }
      pos++;
    }
  }

  candidates.sort((a, b) => b.length - a.length);
  return { candidates, deferred };
}

/**
 * Test-only entry to the buffer scan with a caller-owned budget, so tests can assert that every
 * stream walk in one scan draws from the same budget and stops when it is spent.
 */
export function scanRawBufferForTest(
  bytes: Uint8Array,
  budget: { remaining: number }
): { candidateCount: number; budgetExhausted: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { candidates } = scanRawBufferForJpegCandidates(bytes, view, new Set<string>(), budget);
  return { candidateCount: candidates.length, budgetExhausted: budget.remaining < 0 };
}

/** Finds decodable streams that start and end inside deferred APP payload ranges. */
function scanDeferredRanges(
  bytes: Uint8Array,
  view: DataView,
  ranges: ByteRange[],
  seenOffsets: Set<string>,
  budget: ScanBudget
): CandidateSlice[] {
  const candidates: CandidateSlice[] = [];
  outer: for (const range of ranges) {
    let pos = range.start;
    while (pos + 4 < range.end) {
      if (bytes[pos] === 0xff && bytes[pos + 1] === 0xd8 && bytes[pos + 2] === 0xff) {
        const res = scanJpegStream(bytes, view, pos, range.end, budget);
        if (res.budgetExhausted) break outer;
        if (res.valid && res.endOffset > pos) {
          const streamLen = res.endOffset - pos;
          const key = `${pos}:${streamLen}`;
          if (
            streamLen >= MIN_SCANNED_PREVIEW_BYTES &&
            isDecodablePreviewScan(res) &&
            !seenOffsets.has(key)
          ) {
            seenOffsets.add(key);
            candidates.push({ start: pos, length: streamLen });
          }
          pos = res.endOffset;
          continue;
        }
      }
      if (budget && --budget.remaining < 0) break outer;
      pos++;
    }
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates;
}

/**
 * Reads the Orientation tag (0x0112) from IFD0 of a TIFF-family RAW container.
 * Returns 1 (normal) when the container is not TIFF-based or the tag is absent/invalid.
 */
export function readRawContainerOrientation(buffer: ArrayBuffer): number {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const header = readTiffHeader(bytes, view);
  if (!header) return 1;
  const { littleEndian, firstIfd } = header;
  if (firstIfd < 8 || firstIfd + 2 > bytes.length) return 1;
  const entries = view.getUint16(firstIfd, littleEndian);
  for (let i = 0; i < entries; i++) {
    const entryPos = firstIfd + 2 + i * 12;
    if (entryPos + 12 > bytes.length) break;
    if (view.getUint16(entryPos, littleEndian) !== 0x0112) continue;
    const type = view.getUint16(entryPos + 2, littleEndian);
    const count = view.getUint32(entryPos + 4, littleEndian);
    if (type !== 3 || count !== 1) return 1;
    const value = view.getUint16(entryPos + 8, littleEndian);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/**
 * Returns the Orientation (1..8) from the first Exif APP1 of a JPEG, or 0 when there is no
 * Exif APP1, no Orientation entry in IFD0, or the entry is malformed or out of range.
 */
export function readJpegExifOrientation(jpeg: Uint8Array): number {
  let offset = 2;
  while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
    const marker = jpeg[offset + 1];
    if (marker === 0xda || marker === 0xd9) return 0;
    const segLen = (jpeg[offset + 2] << 8) | jpeg[offset + 3];
    if (segLen < 2) return 0;
    if (
      marker === 0xe1 &&
      offset + 10 <= jpeg.length &&
      jpeg[offset + 4] === 0x45 &&
      jpeg[offset + 5] === 0x78 &&
      jpeg[offset + 6] === 0x69 &&
      jpeg[offset + 7] === 0x66 &&
      jpeg[offset + 8] === 0x00 &&
      jpeg[offset + 9] === 0x00
    ) {
      const segEnd = Math.min(jpeg.length, offset + 2 + segLen);
      const tiff = offset + 10;
      if (tiff + 8 > segEnd) return 0;
      const v = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
      const le = jpeg[tiff] === 0x49 && jpeg[tiff + 1] === 0x49;
      if (!le && !(jpeg[tiff] === 0x4d && jpeg[tiff + 1] === 0x4d)) return 0;
      const ifd0 = tiff + v.getUint32(tiff + 4, le);
      if (ifd0 + 2 > segEnd) return 0;
      const entries = v.getUint16(ifd0, le);
      for (let i = 0; i < entries; i++) {
        const e = ifd0 + 2 + i * 12;
        if (e + 12 > segEnd) return 0;
        if (v.getUint16(e, le) !== 0x0112) continue;
        if (v.getUint16(e + 2, le) !== 3 || v.getUint32(e + 4, le) !== 1) return 0;
        const value = v.getUint16(e + 8, le);
        return value >= 1 && value <= 8 ? value : 0;
      }
      return 0;
    }
    offset += 2 + segLen;
  }
  return 0;
}

/**
 * Losslessly tags an embedded RAW preview with the container's EXIF Orientation by inserting a
 * minimal APP1 Exif segment right after SOI, so browsers rotate it on decode (image-orientation:
 * from-image). Previews whose own Exif APP1 carries a valid Orientation are returned unchanged,
 * since the camera wrote it for that stream. When a preview has Exif but no valid Orientation,
 * the minimal segment goes first: decoders read orientation from the first Exif APP1.
 */
export function withJpegOrientation(
  jpeg: Uint8Array<ArrayBuffer>,
  orientation: number
): Uint8Array<ArrayBuffer> {
  if (orientation < 2 || orientation > 8) return jpeg;
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  if (readJpegExifOrientation(jpeg) > 0) return jpeg;

  // FFE1 + len(34) + "Exif\0\0" + TIFF header (II, 42, IFD0@8) + 1 entry + next-IFD 0
  const app1 = new Uint8Array(36);
  const v = new DataView(app1.buffer);
  app1.set([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  const tiff = 10;
  v.setUint16(tiff, 0x4949, false);
  v.setUint16(tiff + 2, 42, true);
  v.setUint32(tiff + 4, 8, true);
  v.setUint16(tiff + 8, 1, true);
  v.setUint16(tiff + 10, 0x0112, true);
  v.setUint16(tiff + 12, 3, true);
  v.setUint32(tiff + 14, 1, true);
  v.setUint16(tiff + 18, orientation, true);
  v.setUint32(tiff + 22, 0, true);

  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

function sliceToJpegBlob(bytes: Uint8Array, candidate: CandidateSlice, orientation = 1): Blob {
  const jpeg = withJpegOrientation(
    bytes.slice(candidate.start, candidate.start + candidate.length),
    orientation
  );
  return new Blob([jpeg], { type: 'image/jpeg' });
}

/**
 * Yields embedded preview candidates in the order the importer tries them: TIFF-indexed
 * previews first (largest-first), then the buffer scan, which runs lazily only when the
 * consumer asks for more candidates. Both phases share one de-duplication set.
 */
function* iterateRawPreviewCandidates(bytes: Uint8Array): Generator<CandidateSlice> {
  if (bytes.length < 16) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seenOffsets = new Set<string>();
  yield* collectTiffIfdJpegCandidates(bytes, view, seenOffsets);
  const budget = createScanBudget(bytes);
  const { candidates, deferred } = scanRawBufferForJpegCandidates(bytes, view, seenOffsets, budget);
  yield* candidates;
  // Reached only when every enclosing candidate above failed to decode (or none existed)
  if (deferred.length > 0) {
    yield* scanDeferredRanges(bytes, view, deferred, seenOffsets, budget);
  }
}

/**
 * Extracts all browser-decodable embedded JPEG previews from a RAW/TIFF container
 * (e.g. .DNG, .CR2, .NEF, .ARW, .RAF, .ORF, .RW2) in the order
 * `extractDecodableEmbeddedJpegFromRawBuffer` tries them: TIFF-indexed previews
 * largest-first, then scanned streams largest-first.
 */
export function extractEmbeddedJpegCandidatesFromRawBuffer(buffer: ArrayBuffer): Blob[] {
  const bytes = new Uint8Array(buffer);
  return Array.from(iterateRawPreviewCandidates(bytes), (c) => sliceToJpegBlob(bytes, c));
}

/**
 * Extracts the first embedded JPEG preview candidate from a RAW/TIFF container, without
 * verifying that the browser can decode it.
 */
export function extractEmbeddedJpegFromRawBuffer(buffer: ArrayBuffer): Blob | null {
  const candidates = extractEmbeddedJpegCandidatesFromRawBuffer(buffer);
  return candidates[0] ?? null;
}

/**
 * Discovers and verifies the best decodable embedded JPEG preview from a RAW/TIFF buffer.
 * Tries TIFF-indexed candidates first (no buffer scan when one decodes), then scanned streams,
 * stopping after MAX_RAW_PREVIEW_DECODE_ATTEMPTS decodes. The returned preview carries the RAW
 * container's EXIF Orientation so portrait shots display upright.
 */
export async function extractDecodableEmbeddedJpegFromRawBuffer(
  buffer: ArrayBuffer
): Promise<Blob | null> {
  const bytes = new Uint8Array(buffer);
  const orientation = readRawContainerOrientation(buffer);
  let attempts = 0;
  for (const candidate of iterateRawPreviewCandidates(bytes)) {
    attempts += 1;
    const blob = sliceToJpegBlob(bytes, candidate, orientation);
    if (await verifyDecodableImageBlob(blob)) {
      return blob;
    }
    // Break before for...of resumes the generator, so no further scan work runs past the cap
    if (attempts >= MAX_RAW_PREVIEW_DECODE_ATTEMPTS) break;
  }
  return null;
}

/**
 * Verifies with the runtime browser image decoder (createImageBitmap or Image) that a Blob
 * decodes to non-zero pixel dimensions before adding it to the studio queue.
 */
export async function verifyDecodableImageBlob(blob: Blob): Promise<boolean> {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(blob);
      const ok = bitmap.width > 0 && bitmap.height > 0;
      if (typeof bitmap.close === 'function') {
        bitmap.close();
      }
      return ok;
    } catch {
      return false;
    }
  }

  if (typeof globalThis.Image === 'function' && typeof URL.createObjectURL === 'function') {
    const tempUrl = URL.createObjectURL(blob);
    try {
      return await new Promise<boolean>((resolve) => {
        const img = new globalThis.Image();
        img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0);
        img.onerror = () => resolve(false);
        img.src = tempUrl;
      });
    } finally {
      URL.revokeObjectURL(tempUrl);
    }
  }

  // Fallback for non-DOM environments without createImageBitmap/Image
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  return isDecodablePreviewScan(scanJpegStream(bytes, new DataView(buf), 0, bytes.length));
}

function readTiffIfdTags(
  view: DataView,
  tiffStart: number,
  maxOffset: number = view.byteLength
): Partial<{
  model: string;
  lens: string;
  focalLength: string;
  aperture: string;
  shutterSpeed: string;
  iso: string;
  dateTime: string;
}> {
  const result: Partial<{
    model: string;
    lens: string;
    focalLength: string;
    aperture: string;
    shutterSpeed: string;
    iso: string;
    dateTime: string;
  }> = {};

  try {
    const validMax = Math.min(view.byteLength, maxOffset);
    if (tiffStart + 8 > validMax) return result;
    const littleEndian = view.getUint16(tiffStart, false) === 0x4949;
    const firstIfdRel = view.getUint32(tiffStart + 4, littleEndian);
    const ifd0Offset = tiffStart + firstIfdRel;
    if (ifd0Offset + 2 > validMax) return result;

    let exifSubIfdOffset = -1;

    const readAscii = (valOffset: number, count: number): string => {
      if (valOffset < 0 || valOffset + count > validMax) return '';
      let str = '';
      for (let i = 0; i < count; i++) {
        const ch = view.getUint8(valOffset + i);
        if (ch === 0) break;
        if (ch >= 32 && ch <= 126) str += String.fromCharCode(ch);
      }
      return str.trim();
    };

    const readRational = (valOffset: number): number | null => {
      if (valOffset < 0 || valOffset + 8 > validMax) return null;
      const num = view.getUint32(valOffset, littleEndian);
      const den = view.getUint32(valOffset + 4, littleEndian);
      return den === 0 ? null : num / den;
    };

    const parseIfd = (ifdPos: number) => {
      if (ifdPos + 2 > validMax) return;
      const entries = view.getUint16(ifdPos, littleEndian);
      for (let i = 0; i < entries; i++) {
        const entryPos = ifdPos + 2 + i * 12;
        if (entryPos + 12 > validMax) break;
        const tag = view.getUint16(entryPos, littleEndian);
        const type = view.getUint16(entryPos + 2, littleEndian);
        const count = view.getUint32(entryPos + 4, littleEndian);
        const valRel = view.getUint32(entryPos + 8, littleEndian);
        const valOffset = tiffStart + valRel;

        // 0x0110 = Model
        if (tag === 0x0110 && type === 2) {
          result.model = count <= 4 ? readAscii(entryPos + 8, count) : readAscii(valOffset, Math.min(count, 64));
        }
        // 0x8769 = ExifOffset
        if (tag === 0x8769) {
          exifSubIfdOffset = tiffStart + valRel;
        }
        // 0x829A = ExposureTime
        if (tag === 0x829a && type === 5) {
          if (valOffset + 8 <= validMax) {
            const num = view.getUint32(valOffset, littleEndian);
            const den = view.getUint32(valOffset + 4, littleEndian);
            if (num > 0 && den > 0) {
              result.shutterSpeed = num >= den ? `${(num / den).toFixed(1)}s` : `1/${Math.round(den / num)}s`;
            }
          }
        }
        // 0x829D = FNumber
        if (tag === 0x829d && type === 5) {
          const r = readRational(valOffset);
          if (r !== null) result.aperture = `f/${Number(r.toFixed(1))}`;
        }
        // 0x8827 = ISO
        if (tag === 0x8827) {
          let isoVal = 0;
          if (type === 3) {
            // SHORT: inline if count is 1 or 2, from valOffset when count > 2
            if (count === 1 || count === 2) {
              isoVal = view.getUint16(entryPos + 8, littleEndian);
            } else if (count > 2) {
              if (valOffset >= 0 && valOffset + 2 <= validMax) {
                isoVal = view.getUint16(valOffset, littleEndian);
              }
            }
          } else {
            isoVal = valRel;
          }
          if (isoVal > 0 && isoVal < 409600) result.iso = String(isoVal);
        }
        // 0x9003 = DateTimeOriginal
        if (tag === 0x9003 && type === 2 && count > 4) {
          result.dateTime = readAscii(valOffset, Math.min(count, 32));
        }
        // 0x920A = FocalLength
        if (tag === 0x920a && type === 5) {
          const r = readRational(valOffset);
          if (r !== null) result.focalLength = `${Math.round(r)}mm`;
        }
        // 0xA434 = LensModel
        if (tag === 0xa434 && type === 2 && count > 4) {
          result.lens = readAscii(valOffset, Math.min(count, 64));
        }
      }
    };

    parseIfd(ifd0Offset);
    if (exifSubIfdOffset > 0) {
      parseIfd(exifSubIfdOffset);
    }
  } catch {
    // Fallback cleanly if malformed header
  }

  return result;
}

export interface InjectExifResult {
  blob: Blob;
  exifPreserved: boolean;
}

export interface ExportDimensions {
  width: number;
  height: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

/**
 * Returns the byte size of standard TIFF field types.
 */
function getTiffTypeSize(type: number): number {
  switch (type) {
    case 1: // BYTE
    case 2: // ASCII
    case 6: // SBYTE
    case 7: // UNDEFINED
      return 1;
    case 3: // SHORT
    case 8: // SSHORT
      return 2;
    case 4: // LONG
    case 9: // SLONG
    case 11: // FLOAT
      return 4;
    case 5: // RATIONAL
    case 10: // SRATIONAL
    case 12: // DOUBLE
      return 8;
    default:
      return 0;
  }
}

/**
 * Reads an array of unsigned integer values (SHORT or LONG) from a TIFF directory entry.
 */
function readUintArray(
  view: DataView,
  tiffStart: number,
  entryPos: number,
  type: number,
  count: number,
  littleEndian: boolean,
  segmentLength: number
): number[] {
  if (count <= 0 || (type !== 3 && type !== 4)) return [];
  const typeSize = type === 3 ? 2 : 4;
  const totalBytes = count * typeSize;
  let dataOffset: number;
  if (totalBytes <= 4) {
    dataOffset = entryPos + 8;
  } else {
    if (entryPos + 12 > segmentLength) return [];
    const valRel = view.getUint32(entryPos + 8, littleEndian);
    if (valRel < 8) return [];
    dataOffset = tiffStart + valRel;
  }
  if (dataOffset < tiffStart + 8 || dataOffset + totalBytes > segmentLength) return [];
  const results: number[] = [];
  for (let i = 0; i < count; i++) {
    const val = type === 3
      ? view.getUint16(dataOffset + i * 2, littleEndian)
      : view.getUint32(dataOffset + i * 4, littleEndian);
    results.push(val);
  }
  return results;
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * Clears bytes in `range` that are strictly disjoint from any of the intervals in `retained`.
 */
function clearDisjointPortions(
  segment: Uint8Array,
  range: ByteRange,
  retained: ByteRange[]
): void {
  const overlaps: ByteRange[] = [];
  for (const r of retained) {
    const oStart = Math.max(range.start, r.start);
    const oEnd = Math.min(range.end, r.end);
    if (oStart < oEnd) {
      overlaps.push({ start: oStart, end: oEnd });
    }
  }

  if (overlaps.length === 0) {
    segment.fill(0, range.start, range.end);
    return;
  }

  overlaps.sort((a, b) => a.start - b.start);

  const merged: ByteRange[] = [{ start: overlaps[0].start, end: overlaps[0].end }];
  for (let i = 1; i < overlaps.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = overlaps[i];
    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ start: curr.start, end: curr.end });
    }
  }

  let cursor = range.start;
  for (const m of merged) {
    if (m.start > cursor) {
      segment.fill(0, cursor, m.start);
    }
    cursor = Math.max(cursor, m.end);
  }
  if (cursor < range.end) {
    segment.fill(0, cursor, range.end);
  }
}

/**
 * Losslessly injects an original JPEG APP1 EXIF segment into a freshly encoded JPEG Blob,
 * resetting Orientation (tag 0x0112) to 1 (normal) to prevent double-rotation in viewers.
 * Updates PixelXDimension / PixelYDimension to match export canvas, clears embedded IFD1
 * thumbnail byte ranges, and zeros the IFD1 thumbnail pointer on rendered exports.
 */
export async function injectApp1ExifIntoJpegBlob(
  jpegBlob: Blob,
  rawApp1Segment: Uint8Array | null,
  exportDimensions?: ExportDimensions
): Promise<InjectExifResult> {
  if (!rawApp1Segment || rawApp1Segment.length < 18) {
    return { blob: jpegBlob, exifPreserved: false };
  }
  const buf = await jpegBlob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { blob: jpegBlob, exifPreserved: false };
  }

  // Clone APP1 segment so caller's buffer is not mutated
  const segment = new Uint8Array(rawApp1Segment);

  // Check APP1 marker and "Exif\0\0" header
  if (
    segment[0] === 0xff &&
    segment[1] === 0xe1 &&
    segment[4] === 0x45 &&
    segment[5] === 0x78 &&
    segment[6] === 0x69 &&
    segment[7] === 0x66 &&
    segment[8] === 0x00 &&
    segment[9] === 0x00 &&
    segment.length >= 18
  ) {
    const tiffStart = 10;
    const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
    const littleEndian = view.getUint16(tiffStart, false) === 0x4949;
    const firstIfdRel = view.getUint32(tiffStart + 4, littleEndian);
    const ifd0Offset = tiffStart + firstIfdRel;

    if (ifd0Offset >= 0 && ifd0Offset + 2 <= segment.length) {
      const entries = view.getUint16(ifd0Offset, littleEndian);
      let exifSubIfdOffset = -1;

      // Track retained TIFF byte ranges to ensure thumbnail scrub is completely disjoint
      const retainedRanges: ByteRange[] = [];
      retainedRanges.push({ start: 0, end: tiffStart });
      retainedRanges.push({ start: tiffStart, end: tiffStart + 8 });
      retainedRanges.push({
        start: ifd0Offset,
        end: Math.min(segment.length, ifd0Offset + 2 + entries * 12 + 4),
      });

      for (let i = 0; i < entries; i++) {
        const entryPos = ifd0Offset + 2 + i * 12;
        if (entryPos + 12 > segment.length) break;
        const tag = view.getUint16(entryPos, littleEndian);
        const type = view.getUint16(entryPos + 2, littleEndian);
        const count = view.getUint32(entryPos + 4, littleEndian);

        // Record out-of-line value storage as retained
        const typeSize = getTiffTypeSize(type);
        const totalBytes = count * typeSize;
        if (totalBytes > 4) {
          const valRel = view.getUint32(entryPos + 8, littleEndian);
          if (valRel >= 8) {
            const valStart = tiffStart + valRel;
            const valEnd = valStart + totalBytes;
            if (valStart >= tiffStart + 8 && valEnd <= segment.length) {
              retainedRanges.push({ start: valStart, end: valEnd });
            }
          }
        }

        // 0x0112 = Orientation tag: only modify if inline SHORT with count 1
        if (tag === 0x0112 && type === 3 && count === 1) {
          view.setUint16(entryPos + 8, 1, littleEndian);
        }

        // 0x8769 = ExifSubIFD pointer
        if (tag === 0x8769 && (type === 3 || type === 4) && count === 1) {
          const subRel = type === 4
            ? view.getUint32(entryPos + 8, littleEndian)
            : view.getUint16(entryPos + 8, littleEndian);
          if (subRel >= 8) {
            exifSubIfdOffset = tiffStart + subRel;
          }
        }

        // 0x8825 = GPSInfo IFD pointer
        if (tag === 0x8825 && (type === 3 || type === 4) && count === 1) {
          const gpsRel = type === 4
            ? view.getUint32(entryPos + 8, littleEndian)
            : view.getUint16(entryPos + 8, littleEndian);
          if (gpsRel < 8 || tiffStart + gpsRel + 2 > segment.length) {
            return { blob: jpegBlob, exifPreserved: false };
          }
          const gpsOffset = tiffStart + gpsRel;
          const gpsEntries = view.getUint16(gpsOffset, littleEndian);
          const gpsEnd = gpsOffset + 2 + gpsEntries * 12 + 4;
          if (gpsEnd > segment.length) {
            return { blob: jpegBlob, exifPreserved: false };
          }
          retainedRanges.push({
            start: gpsOffset,
            end: gpsEnd,
          });
              for (let g = 0; g < gpsEntries; g++) {
                const gPos = gpsOffset + 2 + g * 12;
                if (gPos + 12 > segment.length) break;
                const gType = view.getUint16(gPos + 2, littleEndian);
                const gCount = view.getUint32(gPos + 4, littleEndian);
                const gBytes = gCount * getTiffTypeSize(gType);
                if (gBytes > 4) {
                  const gValRel = view.getUint32(gPos + 8, littleEndian);
                  if (gValRel >= 8) {
                    const gValStart = tiffStart + gValRel;
                    if (gValStart >= tiffStart + 8 && gValStart + gBytes <= segment.length) {
                      retainedRanges.push({ start: gValStart, end: gValStart + gBytes });
                    }
                  }
                }
              }
        }

        // 0x0100 / 0x0101 = ImageWidth / ImageLength in IFD0 if present
        if (exportDimensions && count === 1) {
          if (tag === 0x0100) {
            if (type === 4) view.setUint32(entryPos + 8, exportDimensions.width, littleEndian);
            else if (type === 3) view.setUint16(entryPos + 8, Math.min(exportDimensions.width, 0xffff), littleEndian);
          } else if (tag === 0x0101) {
            if (type === 4) view.setUint32(entryPos + 8, exportDimensions.height, littleEndian);
            else if (type === 3) view.setUint16(entryPos + 8, Math.min(exportDimensions.height, 0xffff), littleEndian);
          }
        }
      }

      // Update PixelXDimension (0xA002) and PixelYDimension (0xA003) in ExifSubIFD if present
      // and establish all ExifSubIFD structures and referenced data as retained ranges
      if (exifSubIfdOffset >= tiffStart + 8 && exifSubIfdOffset + 2 <= segment.length) {
        const subEntries = view.getUint16(exifSubIfdOffset, littleEndian);
        retainedRanges.push({
          start: exifSubIfdOffset,
          end: Math.min(segment.length, exifSubIfdOffset + 2 + subEntries * 12 + 4),
        });
        for (let j = 0; j < subEntries; j++) {
          const subEntryPos = exifSubIfdOffset + 2 + j * 12;
          if (subEntryPos + 12 > segment.length) break;
          const subTag = view.getUint16(subEntryPos, littleEndian);
          const subType = view.getUint16(subEntryPos + 2, littleEndian);
          const subCount = view.getUint32(subEntryPos + 4, littleEndian);

          const subTypeSize = getTiffTypeSize(subType);
          const subTotalBytes = subCount * subTypeSize;
          if (subTotalBytes > 4) {
            const subValRel = view.getUint32(subEntryPos + 8, littleEndian);
            if (subValRel >= 8) {
              const subValStart = tiffStart + subValRel;
              const subValEnd = subValStart + subTotalBytes;
              if (subValStart >= tiffStart + 8 && subValEnd <= segment.length) {
                retainedRanges.push({ start: subValStart, end: subValEnd });
              }
            }
          }

          // 0xA005 = InteroperabilityIFD pointer
          if (subTag === 0xa005 && (subType === 3 || subType === 4) && subCount === 1) {
            const interopRel = subType === 4
              ? view.getUint32(subEntryPos + 8, littleEndian)
              : view.getUint16(subEntryPos + 8, littleEndian);
            if (interopRel >= 8) {
              const interopOffset = tiffStart + interopRel;
              if (interopOffset >= tiffStart + 8 && interopOffset + 2 <= segment.length) {
                const interopEntries = view.getUint16(interopOffset, littleEndian);
                retainedRanges.push({
                  start: interopOffset,
                  end: Math.min(segment.length, interopOffset + 2 + interopEntries * 12 + 4),
                });
                for (let m = 0; m < interopEntries; m++) {
                  const mPos = interopOffset + 2 + m * 12;
                  if (mPos + 12 > segment.length) break;
                  const mType = view.getUint16(mPos + 2, littleEndian);
                  const mCount = view.getUint32(mPos + 4, littleEndian);
                  const mBytes = mCount * getTiffTypeSize(mType);
                  if (mBytes > 4) {
                    const mValRel = view.getUint32(mPos + 8, littleEndian);
                    if (mValRel >= 8) {
                      const mValStart = tiffStart + mValRel;
                      if (mValStart >= tiffStart + 8 && mValStart + mBytes <= segment.length) {
                        retainedRanges.push({ start: mValStart, end: mValStart + mBytes });
                      }
                    }
                  }
                }
              }
            }
          }

          if (exportDimensions && subCount === 1) {
            if (subTag === 0xa002) {
              if (subType === 4) view.setUint32(subEntryPos + 8, exportDimensions.width, littleEndian);
              else if (subType === 3) view.setUint16(subEntryPos + 8, Math.min(exportDimensions.width, 0xffff), littleEndian);
            } else if (subTag === 0xa003) {
              if (subType === 4) view.setUint32(subEntryPos + 8, exportDimensions.height, littleEndian);
              else if (subType === 3) view.setUint16(subEntryPos + 8, Math.min(exportDimensions.height, 0xffff), littleEndian);
            }
          }
        }
      }

      // On exported images, clear the embedded IFD1 thumbnail bytes (verifying bounds and disjointness)
      // and zero the IFD1 pointer
      const nextIfdOffsetPos = ifd0Offset + 2 + entries * 12;
      if (exportDimensions && nextIfdOffsetPos + 4 <= segment.length) {
        const ifd1Rel = view.getUint32(nextIfdOffsetPos, littleEndian);
        if (ifd1Rel > 0) {
          const ifd1Offset = tiffStart + ifd1Rel;
          if (ifd1Offset + 2 <= segment.length) {
            const ifd1Entries = view.getUint16(ifd1Offset, littleEndian);
            let jpegOffset = -1;
            let jpegLength = 0;
            let stripOffsets: number[] = [];
            let stripByteCounts: number[] = [];

            for (let k = 0; k < ifd1Entries; k++) {
              const ifd1EntryPos = ifd1Offset + 2 + k * 12;
              if (ifd1EntryPos + 12 > segment.length) break;
              const tag = view.getUint16(ifd1EntryPos, littleEndian);
              const type = view.getUint16(ifd1EntryPos + 2, littleEndian);
              const count = view.getUint32(ifd1EntryPos + 4, littleEndian);

              // 0x0201 = JPEGInterchangeFormat, 0x0202 = JPEGInterchangeFormatLength
              if (tag === 0x0201 && count === 1 && (type === 3 || type === 4)) {
                jpegOffset = type === 4
                  ? view.getUint32(ifd1EntryPos + 8, littleEndian)
                  : view.getUint16(ifd1EntryPos + 8, littleEndian);
              } else if (tag === 0x0202 && count === 1 && (type === 3 || type === 4)) {
                jpegLength = type === 4
                  ? view.getUint32(ifd1EntryPos + 8, littleEndian)
                  : view.getUint16(ifd1EntryPos + 8, littleEndian);
              } else if (tag === 0x0111 && (type === 3 || type === 4)) {
                // Read all strip offsets
                stripOffsets = readUintArray(view, tiffStart, ifd1EntryPos, type, count, littleEndian, segment.length);
              } else if (tag === 0x0117 && (type === 3 || type === 4)) {
                // Read all strip byte counts
                stripByteCounts = readUintArray(view, tiffStart, ifd1EntryPos, type, count, littleEndian, segment.length);
              }
            }

            if (stripOffsets.length !== stripByteCounts.length) {
              return { blob: jpegBlob, exifPreserved: false };
            }

            const candidateRanges: ByteRange[] = [];
            if (jpegOffset >= 0 && jpegLength > 0) {
              candidateRanges.push({
                start: tiffStart + jpegOffset,
                end: tiffStart + jpegOffset + jpegLength,
              });
            }

            for (let s = 0; s < stripOffsets.length; s++) {
              const sOffset = stripOffsets[s];
              const sLen = stripByteCounts[s];
              if (sOffset >= 0 && sLen > 0) {
                candidateRanges.push({
                  start: tiffStart + sOffset,
                  end: tiffStart + sOffset + sLen,
                });
              }
            }

            // Zero out embedded thumbnail byte ranges outside retained TIFF data
            for (const cand of candidateRanges) {
              const clampedEnd = Math.min(cand.end, segment.length);
              if (cand.start >= tiffStart && cand.start < clampedEnd) {
                clearDisjointPortions(segment, { start: cand.start, end: clampedEnd }, retainedRanges);
              }
            }
          }
        }
        view.setUint32(nextIfdOffsetPos, 0, littleEndian);
      }
    }
  }

  // Splice rawApp1Segment immediately after SOI (0xFFD8)
  const merged = new Uint8Array(bytes.length + segment.length);
  merged.set(bytes.slice(0, 2), 0);
  merged.set(segment, 2);
  merged.set(bytes.slice(2), 2 + segment.length);
  return { blob: new Blob([merged], { type: 'image/jpeg' }), exifPreserved: true };
}
