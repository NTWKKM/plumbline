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

export function parseExifFromArrayBuffer(
  buffer: ArrayBuffer,
  fileName: string
): ParsedFileMetadata {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const ext = fileName.split('.').pop()?.toLowerCase() || 'jpg';
  const isRawContainer = ['cr2', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2'].includes(ext);

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
    dataOffset = tiffStart + valRel;
  }
  if (dataOffset < tiffStart || dataOffset + totalBytes > segmentLength) return [];
  const results: number[] = [];
  for (let i = 0; i < count; i++) {
    const val = type === 3
      ? view.getUint16(dataOffset + i * 2, littleEndian)
      : view.getUint32(dataOffset + i * 4, littleEndian);
    results.push(val);
  }
  return results;
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
      interface ByteRange {
        start: number;
        end: number;
      }
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
          const valStart = tiffStart + valRel;
          const valEnd = valStart + totalBytes;
          if (valStart >= tiffStart && valEnd <= segment.length) {
            retainedRanges.push({ start: valStart, end: valEnd });
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
          exifSubIfdOffset = tiffStart + subRel;
        }

        // 0x8825 = GPSInfo IFD pointer
        if (tag === 0x8825 && (type === 3 || type === 4) && count === 1) {
          const gpsRel = type === 4
            ? view.getUint32(entryPos + 8, littleEndian)
            : view.getUint16(entryPos + 8, littleEndian);
          const gpsOffset = tiffStart + gpsRel;
          if (gpsOffset >= tiffStart && gpsOffset + 2 <= segment.length) {
            const gpsEntries = view.getUint16(gpsOffset, littleEndian);
            retainedRanges.push({
              start: gpsOffset,
              end: Math.min(segment.length, gpsOffset + 2 + gpsEntries * 12 + 4),
            });
            for (let g = 0; g < gpsEntries; g++) {
              const gPos = gpsOffset + 2 + g * 12;
              if (gPos + 12 > segment.length) break;
              const gType = view.getUint16(gPos + 2, littleEndian);
              const gCount = view.getUint32(gPos + 4, littleEndian);
              const gBytes = gCount * getTiffTypeSize(gType);
              if (gBytes > 4) {
                const gValRel = view.getUint32(gPos + 8, littleEndian);
                const gValStart = tiffStart + gValRel;
                if (gValStart >= tiffStart && gValStart + gBytes <= segment.length) {
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
      if (exifSubIfdOffset > 0 && exifSubIfdOffset + 2 <= segment.length) {
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
            const subValStart = tiffStart + subValRel;
            const subValEnd = subValStart + subTotalBytes;
            if (subValStart >= tiffStart && subValEnd <= segment.length) {
              retainedRanges.push({ start: subValStart, end: subValEnd });
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

            const candidateRanges: ByteRange[] = [];
            if (jpegOffset >= 0 && jpegLength > 0) {
              candidateRanges.push({
                start: tiffStart + jpegOffset,
                end: tiffStart + jpegOffset + jpegLength,
              });
            }

            const numStrips = Math.min(stripOffsets.length, stripByteCounts.length);
            for (let s = 0; s < numStrips; s++) {
              const sOffset = stripOffsets[s];
              const sLen = stripByteCounts[s];
              if (sOffset >= 0 && sLen > 0) {
                candidateRanges.push({
                  start: tiffStart + sOffset,
                  end: tiffStart + sOffset + sLen,
                });
              }
            }

            // Zero out embedded thumbnail byte ranges only when within bounds and disjoint from all retained TIFF data
            for (const cand of candidateRanges) {
              if (cand.start >= tiffStart && cand.end <= segment.length && cand.start < cand.end) {
                const overlapsRetained = retainedRanges.some(
                  (r) => cand.start < r.end && cand.end > r.start
                );
                if (!overlapsRetained) {
                  segment.fill(0, cand.start, cand.end);
                }
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
