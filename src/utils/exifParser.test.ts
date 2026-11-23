import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExifFromArrayBuffer,
  injectApp1ExifIntoJpegBlob,
  extractEmbeddedJpegFromRawBuffer,
  extractEmbeddedJpegCandidatesFromRawBuffer,
  extractDecodableEmbeddedJpegFromRawBuffer,
  verifyDecodableImageBlob,
  readRawContainerOrientation,
  withJpegOrientation,
  MAX_RAW_PREVIEW_DECODE_ATTEMPTS,
  readJpegExifOrientation,
  scanJpegStreamForTest,
} from './exifParser';

test('parseExifFromArrayBuffer returns empty fields for missing metadata instead of fabricated Sony defaults', () => {
  // Empty ArrayBuffer has no EXIF headers
  const emptyBuf = new ArrayBuffer(64);
  const result = parseExifFromArrayBuffer(emptyBuf, 'test.jpg');

  assert.equal(result.exif.cameraModel, '');
  assert.equal(result.exif.lensModel, '');
  assert.equal(result.exif.focalLength, '');
  assert.equal(result.exif.aperture, '');
  assert.equal(result.exif.shutterSpeed, '');
  assert.equal(result.exif.iso, '');
  assert.equal(result.exif.dateTimeOriginal, '');
  assert.equal(result.exif.colorSpace, 'sRGB IEC61966-2.1');
  assert.equal(result.rawApp1Segment, null);
  assert.equal(result.isRawContainer, false);
});

test('parseExifFromArrayBuffer identifies RAW container extensions and sets colorSpace', () => {
  const emptyBuf = new ArrayBuffer(64);
  const result = parseExifFromArrayBuffer(emptyBuf, 'photo.dng');

  assert.equal(result.isRawContainer, true);
  assert.equal(result.exif.rawFormat, 'DNG');
  assert.equal(result.exif.colorSpace, '14-bit Linear RAW → sRGB');
  assert.equal(result.exif.cameraModel, 'RAW Sensor (DNG)');
});

test('injectApp1ExifIntoJpegBlob resets Orientation tag 0x0112 to 1 and returns exifPreserved true', async () => {
  // Construct minimal valid APP1 segment with EXIF and Orientation = 6 (rotated 90 deg CW)
  // TIFF Header:
  // 10: 'II' (0x49, 0x49)
  // 12: 42 (0x002A)
  // 14: IFD0 offset = 8 (0x00000008 -> byte 18)
  // 18: entry count = 1 (0x0001)
  // 20: entry 1: Tag 0x0112, Type 3 (SHORT), Count 1, Value 6 (0x0006)
  // 32: next IFD = 0
  const app1 = new Uint8Array(36);
  // Marker FF E1 + length (34 bytes = 0x0022)
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = 0x00;
  app1[3] = 0x22;
  // 'Exif\0\0'
  app1[4] = 0x45;
  app1[5] = 0x78;
  app1[6] = 0x69;
  app1[7] = 0x66;
  app1[8] = 0x00;
  app1[9] = 0x00;
  // TIFF 'II' + 42 + IFD0 offset = 8
  app1[10] = 0x49;
  app1[11] = 0x49;
  app1[12] = 0x2a;
  app1[13] = 0x00;
  app1[14] = 0x08;
  app1[15] = 0x00;
  app1[16] = 0x00;
  app1[17] = 0x00;
  // Entries = 1
  app1[18] = 0x01;
  app1[19] = 0x00;
  // Entry 0: tag 0x0112 (Orientation), type 3 (SHORT), count 1, value 6
  app1[20] = 0x12;
  app1[21] = 0x01;
  app1[22] = 0x03;
  app1[23] = 0x00;
  app1[24] = 0x01;
  app1[25] = 0x00;
  app1[26] = 0x00;
  app1[27] = 0x00;
  app1[28] = 0x06; // Orientation = 6
  app1[29] = 0x00;
  app1[30] = 0x00;
  app1[31] = 0x00;

  // Minimal JPEG Blob: SOI (FF D8) + EOI (FF D9)
  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  const result = await injectApp1ExifIntoJpegBlob(dummyBlob, app1);
  assert.equal(result.exifPreserved, true);

  const injectedBytes = new Uint8Array(await result.blob.arrayBuffer());
  assert.equal(injectedBytes.byteLength, dummyBlob.size + app1.length);
  assert.equal(injectedBytes[0], 0xff);
  assert.equal(injectedBytes[1], 0xd8);
  // Spliced segment starts at byte 2
  assert.equal(injectedBytes[2], 0xff);
  assert.equal(injectedBytes[3], 0xe1);
  // APP1 segment length bytes at offsets 4 and 5
  assert.equal(injectedBytes[4], app1[2]);
  assert.equal(injectedBytes[5], app1[3]);

  // Check that Orientation tag value at byte 2 + 28 was reset to 1
  assert.equal(injectedBytes[2 + 28], 0x01);
  assert.equal(injectedBytes[2 + 29], 0x00);
});

test('injectApp1ExifIntoJpegBlob zeroes out IFD1 thumbnail pointer on exported images', async () => {
  const app1 = new Uint8Array(40);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = 0x00;
  app1[3] = 40;
  // 'Exif\0\0'
  app1[4] = 0x45;
  app1[5] = 0x78;
  app1[6] = 0x69;
  app1[7] = 0x66;
  app1[8] = 0x00;
  app1[9] = 0x00;
  // TIFF 'II' + 42 + IFD0 offset = 8
  app1[10] = 0x49;
  app1[11] = 0x49;
  app1[12] = 0x2a;
  app1[13] = 0x00;
  app1[14] = 0x08;
  app1[15] = 0x00;
  app1[16] = 0x00;
  app1[17] = 0x00;
  // Entries = 1
  app1[18] = 0x01;
  app1[19] = 0x00;
  // Entry 0: tag 0x0112 (Orientation), type 3 (SHORT), count 1, value 6
  app1[20] = 0x12;
  app1[21] = 0x01;
  app1[22] = 0x03;
  app1[23] = 0x00;
  app1[24] = 0x01;
  app1[25] = 0x00;
  app1[26] = 0x00;
  app1[27] = 0x00;
  app1[28] = 0x06;
  app1[29] = 0x00;
  app1[30] = 0x00;
  app1[31] = 0x00;
  // Next IFD (IFD1 thumbnail pointer at offset 32: 0x00000100)
  app1[32] = 0x00;
  app1[33] = 0x01;
  app1[34] = 0x00;
  app1[35] = 0x00;

  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  // When dimensions differ, thumbnail offset at 2 + 32 should be zeroed
  const resultDiff = await injectApp1ExifIntoJpegBlob(dummyBlob, app1, {
    width: 3000,
    height: 3000,
    sourceWidth: 2000,
    sourceHeight: 1500,
  });
  const bytesDiff = new Uint8Array(await resultDiff.blob.arrayBuffer());
  const viewDiff = new DataView(bytesDiff.buffer);
  assert.equal(viewDiff.getUint32(2 + 32, true), 0);

  // Even when dimensions match, thumbnail offset should still be cleared for re-rendered output
  const resultSame = await injectApp1ExifIntoJpegBlob(dummyBlob, app1, {
    width: 2000,
    height: 1500,
    sourceWidth: 2000,
    sourceHeight: 1500,
  });
  const bytesSame = new Uint8Array(await resultSame.blob.arrayBuffer());
  const viewSame = new DataView(bytesSame.buffer);
  assert.equal(viewSame.getUint32(2 + 32, true), 0);

  // When exportDimensions is not supplied, thumbnail offset should be preserved
  const resultNoDims = await injectApp1ExifIntoJpegBlob(dummyBlob, app1);
  const bytesNoDims = new Uint8Array(await resultNoDims.blob.arrayBuffer());
  const viewNoDims = new DataView(bytesNoDims.buffer);
  assert.equal(viewNoDims.getUint32(2 + 32, true), 0x0100);
});

test('injectApp1ExifIntoJpegBlob returns exifPreserved false when rawApp1Segment is null or shorter than 18 bytes', async () => {
  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  // Null input
  const resultNull = await injectApp1ExifIntoJpegBlob(dummyBlob, null);
  assert.equal(resultNull.exifPreserved, false);
  assert.equal(resultNull.blob, dummyBlob);

  // Short input (< 18 bytes)
  const shortSegment = new Uint8Array([0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  const resultShort = await injectApp1ExifIntoJpegBlob(dummyBlob, shortSegment);
  assert.equal(resultShort.exifPreserved, false);
  assert.equal(resultShort.blob, dummyBlob);
});

test('injectApp1ExifIntoJpegBlob clears embedded IFD1 thumbnail byte range when exportDimensions is provided', async () => {
  // Construct a buffer with APP1 header (10 bytes), TIFF header (8 bytes), IFD0 (18 bytes), IFD1 (26 bytes), and Thumbnail data (16 bytes)
  const totalLen = 100;
  const app1 = new Uint8Array(totalLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = 0x00;
  app1[3] = totalLen - 2;
  // 'Exif\0\0'
  app1[4] = 0x45;
  app1[5] = 0x78;
  app1[6] = 0x69;
  app1[7] = 0x66;
  app1[8] = 0x00;
  app1[9] = 0x00;

  // TIFF Header at byte 10
  const tiffStart = 10;
  app1[tiffStart] = 0x49; // 'II'
  app1[tiffStart + 1] = 0x49;
  app1[tiffStart + 2] = 0x2a; // 42
  app1[tiffStart + 3] = 0x00;
  // IFD0 offset = 8 (relative to TIFF header -> byte 18)
  app1[tiffStart + 4] = 0x08;
  app1[tiffStart + 5] = 0x00;
  app1[tiffStart + 6] = 0x00;
  app1[tiffStart + 7] = 0x00;

  // IFD0 at byte 18: 0 entries
  const ifd0Pos = tiffStart + 8; // byte 18
  app1[ifd0Pos] = 0x00;
  app1[ifd0Pos + 1] = 0x00;
  // Next IFD (IFD1 pointer) at ifd0Pos + 2: offset relative to TIFF header
  // Let IFD1 start at relative offset 20 (byte 30)
  const ifd1Rel = 20;
  const nextIfdPos = ifd0Pos + 2;
  app1[nextIfdPos] = ifd1Rel;
  app1[nextIfdPos + 1] = 0x00;
  app1[nextIfdPos + 2] = 0x00;
  app1[nextIfdPos + 3] = 0x00;

  // IFD1 at byte 30 (tiffStart + 20): 2 entries (JPEGInterchangeFormat and JPEGInterchangeFormatLength)
  const ifd1Pos = tiffStart + ifd1Rel; // byte 30
  app1[ifd1Pos] = 0x02; // 2 entries
  app1[ifd1Pos + 1] = 0x00;

  // Entry 0: tag 0x0201 (JPEGInterchangeFormat), type 4 (LONG), count 1, offset relative to TIFF = 60 (byte 70)
  const entry0Pos = ifd1Pos + 2; // byte 32
  app1[entry0Pos] = 0x01;
  app1[entry0Pos + 1] = 0x02;
  app1[entry0Pos + 2] = 0x04;
  app1[entry0Pos + 3] = 0x00;
  app1[entry0Pos + 4] = 0x01;
  app1[entry0Pos + 5] = 0x00;
  app1[entry0Pos + 6] = 0x00;
  app1[entry0Pos + 7] = 0x00;
  const thumbRel = 60; // byte 70
  app1[entry0Pos + 8] = thumbRel;
  app1[entry0Pos + 9] = 0x00;
  app1[entry0Pos + 10] = 0x00;
  app1[entry0Pos + 11] = 0x00;

  // Entry 1: tag 0x0202 (JPEGInterchangeFormatLength), type 4 (LONG), count 1, length = 16
  const entry1Pos = entry0Pos + 12; // byte 44
  app1[entry1Pos] = 0x02;
  app1[entry1Pos + 1] = 0x02;
  app1[entry1Pos + 2] = 0x04;
  app1[entry1Pos + 3] = 0x00;
  app1[entry1Pos + 4] = 0x01;
  app1[entry1Pos + 5] = 0x00;
  app1[entry1Pos + 6] = 0x00;
  app1[entry1Pos + 7] = 0x00;
  const thumbLen = 16;
  app1[entry1Pos + 8] = thumbLen;
  app1[entry1Pos + 9] = 0x00;
  app1[entry1Pos + 10] = 0x00;
  app1[entry1Pos + 11] = 0x00;

  // Fill thumbnail byte range (byte 70 to 86) with dummy pattern (0xAA)
  const thumbAbsPos = tiffStart + thumbRel; // byte 70
  app1.fill(0xaa, thumbAbsPos, thumbAbsPos + thumbLen);

  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  const result = await injectApp1ExifIntoJpegBlob(dummyBlob, app1, {
    width: 2400,
    height: 1600,
    sourceWidth: 2400,
    sourceHeight: 1600,
  });

  const injectedBytes = new Uint8Array(await result.blob.arrayBuffer());
  // The APP1 segment starts at byte 2 of the JPEG (after SOI)
  const injectedThumbPos = 2 + thumbAbsPos;
  for (let i = injectedThumbPos; i < injectedThumbPos + thumbLen; i++) {
    assert.equal(injectedBytes[i], 0x00, `Expected byte at ${i} to be cleared to 0x00`);
  }

  // Pointer at nextIfdPos should also be zeroed
  const injectedNextIfdPos = 2 + nextIfdPos;
  const view = new DataView(injectedBytes.buffer);
  assert.equal(view.getUint32(injectedNextIfdPos, true), 0);
});

test('injectApp1ExifIntoJpegBlob clears multiple strip thumbnail ranges from StripOffsets and StripByteCounts', async () => {
  const totalLen = 120;
  const app1 = new Uint8Array(totalLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = 0x00;
  app1[3] = totalLen - 2;
  // 'Exif\0\0'
  app1[4] = 0x45;
  app1[5] = 0x78;
  app1[6] = 0x69;
  app1[7] = 0x66;
  app1[8] = 0x00;
  app1[9] = 0x00;

  const tiffStart = 10;
  app1[tiffStart] = 0x49; // 'II'
  app1[tiffStart + 1] = 0x49;
  app1[tiffStart + 2] = 0x2a; // 42
  app1[tiffStart + 3] = 0x00;
  // IFD0 offset = 8 (relative to TIFF header -> byte 18)
  app1[tiffStart + 4] = 0x08;
  app1[tiffStart + 5] = 0x00;
  app1[tiffStart + 6] = 0x00;
  app1[tiffStart + 7] = 0x00;

  // IFD0 at byte 18: 0 entries
  const ifd0Pos = tiffStart + 8;
  app1[ifd0Pos] = 0x00;
  app1[ifd0Pos + 1] = 0x00;
  // IFD1 pointer at ifd0Pos + 2: offset relative to TIFF = 20 (byte 30)
  const ifd1Rel = 20;
  const nextIfdPos = ifd0Pos + 2;
  app1[nextIfdPos] = ifd1Rel;

  // IFD1 at byte 30: 2 entries (StripOffsets and StripByteCounts)
  const ifd1Pos = tiffStart + ifd1Rel;
  app1[ifd1Pos] = 0x02; // 2 entries
  app1[ifd1Pos + 1] = 0x00;

  // Entry 0: tag 0x0111 (StripOffsets), type 4 (LONG), count 2, value offset = 30 (byte 40 from TIFF -> byte 50)
  const entry0Pos = ifd1Pos + 2;
  const view1 = new DataView(app1.buffer);
  view1.setUint16(entry0Pos, 0x0111, true);
  view1.setUint16(entry0Pos + 2, 4, true); // LONG
  view1.setUint32(entry0Pos + 4, 2, true); // count 2
  view1.setUint32(entry0Pos + 8, 50, true); // offset relative to TIFF header -> byte 60

  // Entry 1: tag 0x0117 (StripByteCounts), type 4 (LONG), count 2, value offset = 60 (byte 70)
  const entry1Pos = entry0Pos + 12;
  view1.setUint16(entry1Pos, 0x0117, true);
  view1.setUint16(entry1Pos + 2, 4, true); // LONG
  view1.setUint32(entry1Pos + 4, 2, true); // count 2
  view1.setUint32(entry1Pos + 8, 60, true); // offset relative to TIFF header -> byte 70

  // StripOffsets array at byte 60: strip 0 at rel offset 70 (byte 80), strip 1 at rel offset 80 (byte 90)
  view1.setUint32(tiffStart + 50, 70, true);
  view1.setUint32(tiffStart + 54, 80, true);

  // StripByteCounts array at byte 70: strip 0 len = 10, strip 1 len = 10
  view1.setUint32(tiffStart + 60, 10, true);
  view1.setUint32(tiffStart + 64, 10, true);

  // Fill strips at byte 80..90 and 90..100 with 0xBB
  app1.fill(0xbb, tiffStart + 70, tiffStart + 70 + 10);
  app1.fill(0xbb, tiffStart + 80, tiffStart + 80 + 10);

  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  const result = await injectApp1ExifIntoJpegBlob(dummyBlob, app1, {
    width: 2000,
    height: 2000,
  });

  const injected = new Uint8Array(await result.blob.arrayBuffer());
  // Both strips should be cleared to 0
  for (let i = 2 + tiffStart + 70; i < 2 + tiffStart + 90; i++) {
    assert.equal(injected[i], 0x00, `Expected strip byte at ${i} to be zeroed`);
  }
});

test('injectApp1ExifIntoJpegBlob preserves retained data if candidate thumbnail range overlaps IFD0', async () => {
  const totalLen = 140;
  const app1 = new Uint8Array(totalLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = 0x00;
  app1[3] = totalLen - 2;
  app1[4] = 0x45;
  app1[5] = 0x78;
  app1[6] = 0x69;
  app1[7] = 0x66;
  app1[8] = 0x00;
  app1[9] = 0x00;

  const tiffStart = 10;
  const view1 = new DataView(app1.buffer);
  view1.setUint16(tiffStart, 0x4949, false); // 'II'
  view1.setUint16(tiffStart + 2, 42, true);
  view1.setUint32(tiffStart + 4, 8, true); // IFD0 at rel 8

  const ifd0Pos = tiffStart + 8;
  view1.setUint16(ifd0Pos, 1, true); // 1 entry
  // Entry 0: Tag 0x010E (ImageDescription), type 2 (ASCII), count 8, valRel 60
  const entry0Pos = ifd0Pos + 2;
  view1.setUint16(entry0Pos, 0x010e, true);
  view1.setUint16(entry0Pos + 2, 2, true);
  view1.setUint32(entry0Pos + 4, 8, true);
  view1.setUint32(entry0Pos + 8, 60, true); // valRel = 60 (out-of-line value at tiffStart + 60..68)

  const ifd0Next = entry0Pos + 12;
  view1.setUint32(ifd0Next, 26, true); // IFD1 at rel 26

  // In IFD1, set a JPEGInterchangeFormat spanning rel 56 to 76 (overlapping value at rel 60..68)
  const ifd1Pos = tiffStart + 26;
  view1.setUint16(ifd1Pos, 2, true); // 2 entries
  const ifd1Entry0 = ifd1Pos + 2;
  view1.setUint16(ifd1Entry0, 0x0201, true); // JPEGInterchangeFormat
  view1.setUint16(ifd1Entry0 + 2, 4, true);
  view1.setUint32(ifd1Entry0 + 4, 1, true);
  view1.setUint32(ifd1Entry0 + 8, 56, true); // offset = 56

  const ifd1Entry1 = ifd1Entry0 + 12;
  view1.setUint16(ifd1Entry1, 0x0202, true); // JPEGInterchangeFormatLength
  view1.setUint16(ifd1Entry1 + 2, 4, true);
  view1.setUint32(ifd1Entry1 + 4, 1, true);
  view1.setUint32(ifd1Entry1 + 8, 20, true); // length = 20 (ends at 76)

  view1.setUint32(ifd1Entry1 + 12, 0, true); // IFD1 next pointer = 0

  // Pre-fill gap before retained value (rel 56..60) with 0x99
  app1.fill(0x99, tiffStart + 56, tiffStart + 60);
  // Retained IFD0 entry value at rel 60..68 with marker bytes
  app1[tiffStart + 60] = 0xfe;
  app1[tiffStart + 61] = 0xed;
  app1[tiffStart + 62] = 0xba;
  app1[tiffStart + 63] = 0xbe;
  app1[tiffStart + 64] = 0xca;
  app1[tiffStart + 65] = 0xfe;
  app1[tiffStart + 66] = 0xde;
  app1[tiffStart + 67] = 0xad;
  // Pre-fill gap after retained value (rel 68..76) with 0x88
  app1.fill(0x88, tiffStart + 68, tiffStart + 76);

  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  const result = await injectApp1ExifIntoJpegBlob(dummyBlob, app1, {
    width: 1000,
    height: 1000,
  });

  const injected = new Uint8Array(await result.blob.arrayBuffer());
  // The disjoint portions before and after retained value should be cleared to 0
  assert.equal(injected[2 + tiffStart + 56], 0x00);
  assert.equal(injected[2 + tiffStart + 59], 0x00);
  assert.equal(injected[2 + tiffStart + 68], 0x00);
  assert.equal(injected[2 + tiffStart + 75], 0x00);

  // The retained IFD0 value must NOT have been zeroed!
  assert.equal(injected[2 + tiffStart + 60], 0xfe);
  assert.equal(injected[2 + tiffStart + 61], 0xed);
  assert.equal(injected[2 + tiffStart + 66], 0xde);
  assert.equal(injected[2 + tiffStart + 67], 0xad);
});

test('injectApp1ExifIntoJpegBlob rejects mismatched strip count', async () => {
  const totalLen = 100;
  const app1 = new Uint8Array(totalLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = 0x00;
  app1[3] = totalLen - 2;
  app1[4] = 0x45;
  app1[5] = 0x78;
  app1[6] = 0x69;
  app1[7] = 0x66;
  app1[8] = 0x00;
  app1[9] = 0x00;

  const tiffStart = 10;
  const view1 = new DataView(app1.buffer);
  view1.setUint16(tiffStart, 0x4949, false); // 'II'
  view1.setUint16(tiffStart + 2, 42, true);
  view1.setUint32(tiffStart + 4, 8, true); // IFD0 at rel 8

  const ifd0Pos = tiffStart + 8;
  view1.setUint16(ifd0Pos, 0, true); // 0 entries
  view1.setUint32(ifd0Pos + 2, 20, true); // IFD1 at rel 20

  const ifd1Pos = tiffStart + 20;
  view1.setUint16(ifd1Pos, 2, true); // 2 entries
  const entry0Pos = ifd1Pos + 2;
  view1.setUint16(entry0Pos, 0x0111, true); // StripOffsets
  view1.setUint16(entry0Pos + 2, 4, true);
  view1.setUint32(entry0Pos + 4, 1, true); // count 1 (inline)
  view1.setUint32(entry0Pos + 8, 70, true);

  const entry1Pos = entry0Pos + 12;
  view1.setUint16(entry1Pos, 0x0117, true); // StripByteCounts
  view1.setUint16(entry1Pos + 2, 4, true);
  view1.setUint32(entry1Pos + 4, 2, true); // count 2 -> MISMATCH!
  view1.setUint32(entry1Pos + 8, 50, true);

  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  const result = await injectApp1ExifIntoJpegBlob(dummyBlob, app1, {
    width: 2000,
    height: 2000,
  });

  assert.equal(result.exifPreserved, false);
  assert.equal(result.blob, dummyBlob);
});

test('injectApp1ExifIntoJpegBlob preserves 0xA005 InteroperabilityIFD directory and values', async () => {
  const totalLen = 200;
  const app1 = new Uint8Array(totalLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = 0x00;
  app1[3] = totalLen - 2;
  app1[4] = 0x45;
  app1[5] = 0x78;
  app1[6] = 0x69;
  app1[7] = 0x66;
  app1[8] = 0x00;
  app1[9] = 0x00;

  const tiffStart = 10;
  const view1 = new DataView(app1.buffer);
  view1.setUint16(tiffStart, 0x4949, false); // 'II'
  view1.setUint16(tiffStart + 2, 42, true);
  view1.setUint32(tiffStart + 4, 8, true); // IFD0 at rel 8

  const ifd0Pos = tiffStart + 8;
  view1.setUint16(ifd0Pos, 1, true); // 1 entry: ExifSubIFD pointer
  const ifd0Entry0 = ifd0Pos + 2;
  view1.setUint16(ifd0Entry0, 0x8769, true); // ExifSubIFD
  view1.setUint16(ifd0Entry0 + 2, 4, true);
  view1.setUint32(ifd0Entry0 + 4, 1, true);
  view1.setUint32(ifd0Entry0 + 8, 26, true); // ExifSubIFD at rel 26
  view1.setUint32(ifd0Entry0 + 12, 130, true); // IFD1 at rel 130

  // ExifSubIFD at rel 26 (len: 2 + 12 + 4 = 18 bytes -> rel 26..44)
  const subIfdPos = tiffStart + 26;
  view1.setUint16(subIfdPos, 1, true); // 1 entry: InteroperabilityIFD pointer
  const subEntry0 = subIfdPos + 2;
  view1.setUint16(subEntry0, 0xa005, true); // InteroperabilityIFD
  view1.setUint16(subEntry0 + 2, 4, true);
  view1.setUint32(subEntry0 + 4, 1, true);
  view1.setUint32(subEntry0 + 8, 50, true); // InteroperabilityIFD at rel 50
  view1.setUint32(subEntry0 + 12, 0, true);

  // InteroperabilityIFD at rel 50 (len: 2 + 2*12 + 4 = 30 bytes -> rel 50..80)
  const interopPos = tiffStart + 50;
  view1.setUint16(interopPos, 2, true); // 2 entries: InteroperabilityIndex + out-of-line value entry
  const interopEntry0 = interopPos + 2;
  view1.setUint16(interopEntry0, 0x0001, true);
  view1.setUint16(interopEntry0 + 2, 2, true); // ASCII
  view1.setUint32(interopEntry0 + 4, 4, true);
  // 'R98\0' inline
  view1.setUint8(interopEntry0 + 8, 0x52);
  view1.setUint8(interopEntry0 + 9, 0x39);
  view1.setUint8(interopEntry0 + 10, 0x38);
  view1.setUint8(interopEntry0 + 11, 0x00);

  const interopEntry1 = interopPos + 14;
  view1.setUint16(interopEntry1, 0x1000, true); // RelatedImageFileFormat
  view1.setUint16(interopEntry1 + 2, 2, true); // ASCII
  view1.setUint32(interopEntry1 + 4, 6, true); // 6 bytes > 4 -> out-of-line
  view1.setUint32(interopEntry1 + 8, 90, true); // stored at rel 90 (tiffStart + 90)
  view1.setUint32(interopPos + 26, 0, true); // next IFD offset = 0

  // Out-of-line ASCII data at rel 90..96 ('TEST1\0')
  const valPos = tiffStart + 90;
  app1.set([0x54, 0x45, 0x53, 0x54, 0x31, 0x00], valPos);

  // IFD1 at rel 130, with candidate thumbnail covering rel 44..110 (overlapping InteroperabilityIFD rel 50..80 and value rel 90..96)
  const ifd1Pos = tiffStart + 130;
  view1.setUint16(ifd1Pos, 2, true);
  const ifd1Entry0 = ifd1Pos + 2;
  view1.setUint16(ifd1Entry0, 0x0201, true);
  view1.setUint16(ifd1Entry0 + 2, 4, true);
  view1.setUint32(ifd1Entry0 + 4, 1, true);
  view1.setUint32(ifd1Entry0 + 8, 44, true); // starts at rel 44

  const ifd1Entry1 = ifd1Entry0 + 12;
  view1.setUint16(ifd1Entry1, 0x0202, true);
  view1.setUint16(ifd1Entry1 + 2, 4, true);
  view1.setUint32(ifd1Entry1 + 4, 1, true);
  view1.setUint32(ifd1Entry1 + 8, 66, true); // ends at rel 110 (44 + 66)
  view1.setUint32(ifd1Entry1 + 12, 0, true);

  // Pre-fill gap at rel 44..50 with 0x77
  app1.fill(0x77, tiffStart + 44, tiffStart + 50);
  // Pre-fill gap at rel 80..90 with 0x88
  app1.fill(0x88, tiffStart + 80, tiffStart + 90);
  // Pre-fill gap at rel 96..110 with 0x66
  app1.fill(0x66, tiffStart + 96, tiffStart + 110);

  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  const result = await injectApp1ExifIntoJpegBlob(dummyBlob, app1, {
    width: 1000,
    height: 1000,
  });

  const injected = new Uint8Array(await result.blob.arrayBuffer());
  // The gap at rel 44..50 should be cleared to 0
  assert.equal(injected[2 + tiffStart + 44], 0x00);
  assert.equal(injected[2 + tiffStart + 49], 0x00);

  // InteroperabilityIFD directory entries should be preserved intact
  const viewInj = new DataView(injected.buffer, injected.byteOffset, injected.byteLength);
  assert.equal(viewInj.getUint16(2 + interopEntry0, true), 0x0001);
  assert.equal(viewInj.getUint16(2 + interopEntry0 + 2, true), 2);
  assert.equal(viewInj.getUint32(2 + interopEntry0 + 4, true), 4);
  assert.equal(injected[2 + interopEntry0 + 8], 0x52);
  assert.equal(injected[2 + interopEntry0 + 9], 0x39);
  assert.equal(injected[2 + interopEntry0 + 10], 0x38);

  // Second entry preserved
  assert.equal(viewInj.getUint16(2 + interopEntry1, true), 0x1000);
  assert.equal(viewInj.getUint16(2 + interopEntry1 + 2, true), 2);
  assert.equal(viewInj.getUint32(2 + interopEntry1 + 4, true), 6);
  assert.equal(viewInj.getUint32(2 + interopEntry1 + 8, true), 90);

  // The gap at rel 80..90 should be cleared to 0
  assert.equal(injected[2 + tiffStart + 80], 0x00);
  assert.equal(injected[2 + tiffStart + 89], 0x00);

  // Out-of-line value at rel 90..96 ('TEST1\0') must remain intact
  assert.equal(injected[2 + valPos], 0x54);
  assert.equal(injected[2 + valPos + 1], 0x45);
  assert.equal(injected[2 + valPos + 2], 0x53);
  assert.equal(injected[2 + valPos + 3], 0x54);
  assert.equal(injected[2 + valPos + 4], 0x31);
  assert.equal(injected[2 + valPos + 5], 0x00);

  // The gap at rel 96..110 should be cleared to 0
  assert.equal(injected[2 + tiffStart + 96], 0x00);
  assert.equal(injected[2 + tiffStart + 109], 0x00);
});

test('injectApp1ExifIntoJpegBlob rejects truncated GPS directory extent', async () => {
  const totalLen = 60;
  const app1 = new Uint8Array(totalLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = 0x00;
  app1[3] = totalLen - 2;
  app1[4] = 0x45;
  app1[5] = 0x78;
  app1[6] = 0x69;
  app1[7] = 0x66;
  app1[8] = 0x00;
  app1[9] = 0x00;

  const tiffStart = 10;
  const view1 = new DataView(app1.buffer);
  view1.setUint16(tiffStart, 0x4949, false); // 'II'
  view1.setUint16(tiffStart + 2, 42, true);
  view1.setUint32(tiffStart + 4, 8, true); // IFD0 at rel 8

  const ifd0Pos = tiffStart + 8;
  view1.setUint16(ifd0Pos, 1, true); // 1 entry: GPSInfo pointer
  const ifd0Entry0 = ifd0Pos + 2;
  view1.setUint16(ifd0Entry0, 0x8825, true); // GPSInfo
  view1.setUint16(ifd0Entry0 + 2, 4, true);
  view1.setUint32(ifd0Entry0 + 4, 1, true);
  view1.setUint32(ifd0Entry0 + 8, 26, true); // GPSInfo at rel 26
  view1.setUint32(ifd0Entry0 + 12, 0, true);

  // GPSInfo at rel 26 reports 10 entries (needs 2 + 10*12 + 4 = 126 bytes, but segment only has totalLen=60)
  const gpsPos = tiffStart + 26;
  view1.setUint16(gpsPos, 10, true);

  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  const result = await injectApp1ExifIntoJpegBlob(dummyBlob, app1, {
    width: 1000,
    height: 1000,
  });

  assert.equal(result.exifPreserved, false);
  assert.equal(result.blob, dummyBlob);
});

test('injectApp1ExifIntoJpegBlob preserves valid in-bounds GPS directory and entries', async () => {
  const totalLen = 140;
  const app1 = new Uint8Array(totalLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = 0x00;
  app1[3] = totalLen - 2;
  app1[4] = 0x45;
  app1[5] = 0x78;
  app1[6] = 0x69;
  app1[7] = 0x66;
  app1[8] = 0x00;
  app1[9] = 0x00;

  const tiffStart = 10;
  const view1 = new DataView(app1.buffer);
  view1.setUint16(tiffStart, 0x4949, false); // 'II'
  view1.setUint16(tiffStart + 2, 42, true);
  view1.setUint32(tiffStart + 4, 8, true); // IFD0 at rel 8

  const ifd0Pos = tiffStart + 8;
  view1.setUint16(ifd0Pos, 1, true); // 1 entry: GPSInfo pointer
  const ifd0Entry0 = ifd0Pos + 2;
  view1.setUint16(ifd0Entry0, 0x8825, true); // GPSInfo
  view1.setUint16(ifd0Entry0 + 2, 4, true);
  view1.setUint32(ifd0Entry0 + 4, 1, true);
  view1.setUint32(ifd0Entry0 + 8, 26, true); // GPSInfo at rel 26
  view1.setUint32(ifd0Entry0 + 12, 70, true); // IFD1 at rel 70

  // GPS directory at rel 26 (len: 2 + 1*12 + 4 = 18 bytes -> rel 26..44)
  const gpsPos = tiffStart + 26;
  view1.setUint16(gpsPos, 1, true); // 1 entry: GPSLatitudeRef
  const gpsEntry0 = gpsPos + 2;
  view1.setUint16(gpsEntry0, 0x0001, true); // GPSLatitudeRef
  view1.setUint16(gpsEntry0 + 2, 2, true); // ASCII
  view1.setUint32(gpsEntry0 + 4, 2, true); // count 2 ('N\0')
  view1.setUint8(gpsEntry0 + 8, 0x4e); // 'N'
  view1.setUint8(gpsEntry0 + 9, 0x00);
  view1.setUint32(gpsPos + 14, 0, true); // next IFD offset 0

  // IFD1 at rel 70 with thumbnail covering rel 30..60 (overlapping GPS directory at rel 26..44)
  const ifd1Pos = tiffStart + 70;
  view1.setUint16(ifd1Pos, 2, true);
  const ifd1Entry0 = ifd1Pos + 2;
  view1.setUint16(ifd1Entry0, 0x0201, true);
  view1.setUint16(ifd1Entry0 + 2, 4, true);
  view1.setUint32(ifd1Entry0 + 4, 1, true);
  view1.setUint32(ifd1Entry0 + 8, 30, true); // thumbnail starts at rel 30

  const ifd1Entry1 = ifd1Entry0 + 12;
  view1.setUint16(ifd1Entry1, 0x0202, true);
  view1.setUint16(ifd1Entry1 + 2, 4, true);
  view1.setUint32(ifd1Entry1 + 4, 1, true);
  view1.setUint32(ifd1Entry1 + 8, 30, true); // len 30 -> covers rel 30..60
  view1.setUint32(ifd1Entry1 + 12, 0, true);

  // Pre-fill gap outside GPS directory at rel 44..60 with 0xEE
  app1.fill(0xee, tiffStart + 44, tiffStart + 60);

  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  const result = await injectApp1ExifIntoJpegBlob(dummyBlob, app1, {
    width: 1000,
    height: 1000,
  });

  assert.equal(result.exifPreserved, true);
  const injected = new Uint8Array(await result.blob.arrayBuffer());
  const viewInj = new DataView(injected.buffer, injected.byteOffset, injected.byteLength);
  // Verify GPS directory preserved despite thumbnail overlap
  assert.equal(viewInj.getUint16(2 + gpsPos, true), 1);
  assert.equal(viewInj.getUint16(2 + gpsEntry0, true), 0x0001);
  assert.equal(viewInj.getUint16(2 + gpsEntry0 + 2, true), 2);
  assert.equal(viewInj.getUint32(2 + gpsEntry0 + 4, true), 2);
  assert.equal(injected[2 + gpsEntry0 + 8], 0x4e); // 'N'
  // Verify thumbnail gap outside GPS directory was cleared
  assert.equal(injected[2 + tiffStart + 44], 0x00);
  assert.equal(injected[2 + tiffStart + 59], 0x00);
});

test('injectApp1ExifIntoJpegBlob rejects out-of-segment GPS pointer', async () => {
  const totalLen = 60;
  const app1 = new Uint8Array(totalLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = 0x00;
  app1[3] = totalLen - 2;
  app1[4] = 0x45;
  app1[5] = 0x78;
  app1[6] = 0x69;
  app1[7] = 0x66;
  app1[8] = 0x00;
  app1[9] = 0x00;

  const tiffStart = 10;
  const view1 = new DataView(app1.buffer);
  view1.setUint16(tiffStart, 0x4949, false); // 'II'
  view1.setUint16(tiffStart + 2, 42, true);
  view1.setUint32(tiffStart + 4, 8, true); // IFD0 at rel 8

  const ifd0Pos = tiffStart + 8;
  view1.setUint16(ifd0Pos, 1, true);
  const ifd0Entry0 = ifd0Pos + 2;
  view1.setUint16(ifd0Entry0, 0x8825, true); // GPSInfo
  view1.setUint16(ifd0Entry0 + 2, 4, true);
  view1.setUint32(ifd0Entry0 + 4, 1, true);
  view1.setUint32(ifd0Entry0 + 8, 200, true); // GPSInfo offset 200 > segment length
  view1.setUint32(ifd0Entry0 + 12, 0, true);

  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  const result = await injectApp1ExifIntoJpegBlob(dummyBlob, app1, {
    width: 1000,
    height: 1000,
  });

  assert.equal(result.exifPreserved, false);
  assert.equal(result.blob, dummyBlob);
});

test('injectApp1ExifIntoJpegBlob clamps thumbnail range ending past segment', async () => {
  const totalLen = 80;
  const app1 = new Uint8Array(totalLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = 0x00;
  app1[3] = totalLen - 2;
  app1[4] = 0x45;
  app1[5] = 0x78;
  app1[6] = 0x69;
  app1[7] = 0x66;
  app1[8] = 0x00;
  app1[9] = 0x00;

  const tiffStart = 10;
  const view1 = new DataView(app1.buffer);
  view1.setUint16(tiffStart, 0x4949, false); // 'II'
  view1.setUint16(tiffStart + 2, 42, true);
  view1.setUint32(tiffStart + 4, 8, true); // IFD0 at rel 8

  const ifd0Pos = tiffStart + 8;
  view1.setUint16(ifd0Pos, 0, true); // 0 entries
  view1.setUint32(ifd0Pos + 2, 20, true); // IFD1 at rel 20

  const ifd1Pos = tiffStart + 20;
  view1.setUint16(ifd1Pos, 2, true);
  const entry0Pos = ifd1Pos + 2;
  view1.setUint16(entry0Pos, 0x0201, true); // JPEGInterchangeFormat
  view1.setUint16(entry0Pos + 2, 4, true);
  view1.setUint32(entry0Pos + 4, 1, true);
  view1.setUint32(entry0Pos + 8, 50, true); // starts at rel 50 (byte 60)

  const entry1Pos = entry0Pos + 12;
  view1.setUint16(entry1Pos, 0x0202, true); // JPEGInterchangeFormatLength
  view1.setUint16(entry1Pos + 2, 4, true);
  view1.setUint32(entry1Pos + 4, 1, true);
  view1.setUint32(entry1Pos + 8, 100, true); // length = 100 (extends far beyond segment.length 80)
  view1.setUint32(entry1Pos + 12, 0, true);

  // Pre-fill byte 60..80 with 0xEE
  app1.fill(0xee, tiffStart + 50, totalLen);

  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  const result = await injectApp1ExifIntoJpegBlob(dummyBlob, app1, {
    width: 1000,
    height: 1000,
  });

  assert.equal(result.exifPreserved, true);
  const injected = new Uint8Array(await result.blob.arrayBuffer());
  // The in-bounds portion of thumbnail range (byte 60..80) should be cleared
  for (let i = 2 + tiffStart + 50; i < 2 + totalLen; i++) {
    assert.equal(injected[i], 0x00, `Expected byte at ${i} to be zeroed`);
  }
});

test('extractEmbeddedJpegFromRawBuffer rejects SOF-missing and SOS-missing candidates independently and handles fallback scanning', async () => {
  // Valid minimal structural JPEG stream: SOI + SOF0 (16x16) + SOS + scan data + EOI
  const validJpeg = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, // SOF0: 16x16, 3 components
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00, // SOS
    0xab, 0xcd, 0xef, // entropy scan bytes
    0xff, 0xd9, // EOI
  ]);

  // Well-formed JPEG marker sequence with APP0 + SOS + EOI, but missing SOF (reaches !hasSof check)
  const missingSofCandidate = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, // APP0 (16 bytes total)
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00, // SOS
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, // scan bytes (makes fixture larger than validJpeg)
    0xff, 0xd9, // EOI
  ]);

  // Well-formed JPEG marker sequence with SOF0 + APP0 + EOI, but missing SOS (reaches EOI-before-SOS check)
  const missingSosCandidate = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, // SOF0: 16x16
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xe0, 0x00, 0x10, // APP0 (16 bytes total)
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xd9, // EOI before any SOS
  ]);

  const makeSingleIfdRaw = (payload: Uint8Array): ArrayBuffer => {
    const out = new Uint8Array(40 + payload.length);
    const v = new DataView(out.buffer);
    v.setUint16(0, 0x4949, false);
    v.setUint16(2, 42, true);
    v.setUint32(4, 8, true);
    v.setUint16(8, 2, true);
    v.setUint16(10, 0x0201, true);
    v.setUint16(12, 4, true);
    v.setUint32(14, 1, true);
    v.setUint32(18, 40, true);
    v.setUint16(22, 0x0202, true);
    v.setUint16(24, 4, true);
    v.setUint32(26, 1, true);
    v.setUint32(30, payload.length, true);
    v.setUint32(34, 0, true);
    out.set(payload, 40);
    return out.buffer;
  };

  // Independently verify missing-SOF and missing-SOS rejection
  assert.equal(extractEmbeddedJpegFromRawBuffer(makeSingleIfdRaw(missingSofCandidate)), null);
  assert.equal(extractEmbeddedJpegFromRawBuffer(makeSingleIfdRaw(missingSosCandidate)), null);

  // Construct synthetic TIFF/DNG buffer:
  // IFD0 points to the larger missingSofCandidate; IFD1 points to the valid structural JPEG.
  const buf = new Uint8Array(74 + missingSofCandidate.length + validJpeg.length);
  const view = new DataView(buf.buffer);
  view.setUint16(0, 0x4949, false); // 'II'
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true); // IFD0 at 8

  const invalidOffset = 74;
  const validOffset = invalidOffset + missingSofCandidate.length;

  // IFD0 at 8: 2 entries pointing to missingSofCandidate, next IFD at 44
  view.setUint16(8, 2, true);
  view.setUint16(10, 0x0201, true);
  view.setUint16(12, 4, true);
  view.setUint32(14, 1, true);
  view.setUint32(18, invalidOffset, true);
  view.setUint16(22, 0x0202, true);
  view.setUint16(24, 4, true);
  view.setUint32(26, 1, true);
  view.setUint32(30, missingSofCandidate.length, true);
  view.setUint32(34, 44, true); // IFD1 at 44

  // IFD1 at 44: 2 entries pointing to validJpeg
  view.setUint16(44, 2, true);
  view.setUint16(46, 0x0201, true);
  view.setUint16(48, 4, true);
  view.setUint32(50, 1, true);
  view.setUint32(54, validOffset, true);
  view.setUint16(58, 0x0202, true);
  view.setUint16(60, 4, true);
  view.setUint32(62, 1, true);
  view.setUint32(66, validJpeg.length, true);
  view.setUint32(70, 0, true);

  buf.set(missingSofCandidate, invalidOffset);
  buf.set(validJpeg, validOffset);

  const candidates = extractEmbeddedJpegCandidatesFromRawBuffer(buf.buffer);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].size, validJpeg.length);

  const preview = extractEmbeddedJpegFromRawBuffer(buf.buffer);
  assert.ok(preview instanceof Blob);
  assert.equal(preview.type, 'image/jpeg');
  assert.equal(preview.size, validJpeg.length);

  // Fallback stream scan (>= 512 bytes): malformed candidate followed by valid JPEG with consecutive 0xFF fill bytes
  const fallbackPreview = new Uint8Array(560);
  fallbackPreview[0] = 0xff;
  fallbackPreview[1] = 0xd8;
  fallbackPreview[2] = 0xff;
  fallbackPreview[3] = 0xff; // 0xFF fill byte before SOF0
  fallbackPreview[4] = 0xc0;
  fallbackPreview.set([0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00], 5);
  fallbackPreview[22] = 0xff;
  fallbackPreview[23] = 0xda;
  fallbackPreview.set([0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00], 24);
  fallbackPreview[558] = 0xff;
  fallbackPreview[559] = 0xd9;

  const rafWrapper = new Uint8Array(24 + fallbackPreview.length + 32);
  // Precede with a malformed SOI header before the real stream
  rafWrapper[8] = 0xff;
  rafWrapper[9] = 0xd8;
  rafWrapper[10] = 0xff;
  rafWrapper[11] = 0xe1;
  rafWrapper[12] = 0xff; // huge invalid segLen that breaks header parse
  rafWrapper[13] = 0xff;
  rafWrapper.set(fallbackPreview, 24);
  // Trailing SOI after the last EOI must not hang or match
  rafWrapper[24 + fallbackPreview.length + 4] = 0xff;
  rafWrapper[24 + fallbackPreview.length + 5] = 0xd8;
  rafWrapper[24 + fallbackPreview.length + 6] = 0xff;

  const fallbackFound = extractEmbeddedJpegFromRawBuffer(rafWrapper.buffer);
  assert.ok(fallbackFound instanceof Blob);
  assert.equal(fallbackFound.size, fallbackPreview.length);

  // Truncated-scan candidate (valid SOI + SOF0 + SOS + scan data, missing EOI) followed by valid JPEG
  const truncatedScanPrefix = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, // SOF0: 16x16
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00, // SOS
    0x12, 0x34, 0x56, 0x78, // truncated scan without EOI
  ]);

  const truncatedScanWrapper = new Uint8Array(16 + truncatedScanPrefix.length + fallbackPreview.length + 16);
  truncatedScanWrapper.set(truncatedScanPrefix, 16);
  truncatedScanWrapper.set(fallbackPreview, 16 + truncatedScanPrefix.length);

  const recoveredFromTruncated = extractEmbeddedJpegFromRawBuffer(truncatedScanWrapper.buffer);
  assert.ok(recoveredFromTruncated instanceof Blob);
  assert.equal(recoveredFromTruncated.size, fallbackPreview.length);

  // Multi-scan / progressive JPEG: SOI + SOF2 + SOS (scan 1) + DHT + SOS (scan 2, with 0xFF 0x00) + EOI
  const makeProgressiveJpeg = (totalLength: number): Uint8Array => {
    const bufOut = new Uint8Array(totalLength);
    bufOut[0] = 0xff;
    bufOut[1] = 0xd8; // SOI
    bufOut[2] = 0xff;
    bufOut[3] = 0xc2; // SOF2 (progressive)
    bufOut.set(
      [0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00],
      4
    );
    bufOut[21] = 0xff;
    bufOut[22] = 0xda; // SOS scan 1
    bufOut.set([0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00], 23);
    bufOut[35] = 0x12;
    bufOut[36] = 0x34;
    // Length-delimited DHT segment between scans (contains 0xFF 0xD8 payload bytes inside segment body)
    bufOut[37] = 0xff;
    bufOut[38] = 0xc4; // DHT
    bufOut[39] = 0x00;
    bufOut[40] = 0x08; // 8-byte segment
    bufOut[41] = 0x10;
    bufOut[42] = 0xff;
    bufOut[43] = 0xd8; // payload bytes inside DHT (must be skipped by segLen, not treated as nested SOI)
    bufOut[47] = 0xff;
    bufOut[48] = 0xda; // SOS scan 2
    bufOut.set([0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x3f, 0x00], 49);
    bufOut[60] = 0xff;
    bufOut[61] = 0x00; // stuffed 0xFF inside scan 2 entropy data
    bufOut[totalLength - 2] = 0xff;
    bufOut[totalLength - 1] = 0xd9; // EOI
    return bufOut;
  };

  // Use < 512 bytes for IFD assertion so extraction proves TIFF IFD discovery rather than fallback scanning
  const progressiveIfdJpeg = makeProgressiveJpeg(128);
  const progIfdResult = extractEmbeddedJpegFromRawBuffer(makeSingleIfdRaw(progressiveIfdJpeg));
  assert.ok(progIfdResult instanceof Blob);
  assert.equal(progIfdResult.size, progressiveIfdJpeg.length);

  // Retain 560-byte fixture (>= 512) for the fallback-scanning assertion
  const progressiveJpeg = makeProgressiveJpeg(560);
  const progFallbackBuf = new Uint8Array(16 + progressiveJpeg.length + 16);
  progFallbackBuf.set(progressiveJpeg, 16);
  const progFallbackResult = extractEmbeddedJpegFromRawBuffer(progFallbackBuf.buffer);
  assert.ok(progFallbackResult instanceof Blob);
  assert.equal(progFallbackResult.size, progressiveJpeg.length);

  // Rejected enclosing JPEG with APP1 payload containing a valid JPEG followed by a nested SOI:
  // must reconsider candidate starts inside the skipped APP1 payload before jumping to nested SOI
  const app1SegLen = 2 + 8 + fallbackPreview.length + 8;
  const enclosingWithNestedAppPreview = new Uint8Array(16 + 4 + app1SegLen + 32);
  enclosingWithNestedAppPreview[8] = 0xff;
  enclosingWithNestedAppPreview[9] = 0xd8; // enclosing SOI
  enclosingWithNestedAppPreview[10] = 0xff;
  enclosingWithNestedAppPreview[11] = 0xe1; // APP1
  enclosingWithNestedAppPreview[12] = (app1SegLen >> 8) & 0xff;
  enclosingWithNestedAppPreview[13] = app1SegLen & 0xff;
  enclosingWithNestedAppPreview.set(fallbackPreview, 14 + 8);
  const afterApp1 = 14 + app1SegLen;
  enclosingWithNestedAppPreview[afterApp1] = 0xff;
  enclosingWithNestedAppPreview[afterApp1 + 1] = 0xd8; // nested SOI after APP1 rejects enclosing JPEG
  enclosingWithNestedAppPreview[afterApp1 + 2] = 0xff;
  enclosingWithNestedAppPreview[afterApp1 + 3] = 0xd9;

  const recoveredFromSkippedApp = extractEmbeddedJpegFromRawBuffer(
    enclosingWithNestedAppPreview.buffer
  );
  assert.ok(recoveredFromSkippedApp instanceof Blob);
  assert.equal(recoveredFromSkippedApp.size, fallbackPreview.length);

  // Accepted enclosing JPEG whose APP1 payload also contains a >=512-byte JPEG preserves fast path
  const acceptedEnclosingLen = 4 + app1SegLen + 600;
  const acceptedEnclosingBuf = new Uint8Array(16 + acceptedEnclosingLen + 16);
  const encStart = 16;
  acceptedEnclosingBuf[encStart] = 0xff;
  acceptedEnclosingBuf[encStart + 1] = 0xd8; // SOI
  acceptedEnclosingBuf[encStart + 2] = 0xff;
  acceptedEnclosingBuf[encStart + 3] = 0xe1; // APP1
  acceptedEnclosingBuf[encStart + 4] = (app1SegLen >> 8) & 0xff;
  acceptedEnclosingBuf[encStart + 5] = app1SegLen & 0xff;
  acceptedEnclosingBuf.set(fallbackPreview, encStart + 6 + 8);
  const encSof = encStart + 4 + app1SegLen;
  acceptedEnclosingBuf[encSof] = 0xff;
  acceptedEnclosingBuf[encSof + 1] = 0xc0; // SOF0
  acceptedEnclosingBuf.set(
    [0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00],
    encSof + 2
  );
  acceptedEnclosingBuf[encSof + 19] = 0xff;
  acceptedEnclosingBuf[encSof + 20] = 0xda; // SOS
  acceptedEnclosingBuf.set(
    [0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00],
    encSof + 21
  );
  acceptedEnclosingBuf[encStart + acceptedEnclosingLen - 2] = 0xff;
  acceptedEnclosingBuf[encStart + acceptedEnclosingLen - 1] = 0xd9; // EOI

  // The accepted enclosing stream comes first; the preview inside its APP1 payload is kept as a
  // deferred fallback, offered only after every enclosing candidate has been tried
  const fastPathCandidates = extractEmbeddedJpegCandidatesFromRawBuffer(acceptedEnclosingBuf.buffer);
  assert.equal(fastPathCandidates.length, 2);
  assert.equal(fastPathCandidates[0].size, acceptedEnclosingLen);
  assert.equal(fastPathCandidates[1].size, fallbackPreview.length);

  // Test browser-decoder verification with valid and failing decode responses
  const origDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  try {
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: async (blob: Blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        // Simulate real browser decoder rejecting malformed candidate bytes
        if (bytes.length === validJpeg.length && bytes[2] === 0xff && bytes[3] === 0xc0) {
          return { width: 16, height: 16, close: () => {} };
        }
        throw new Error('Invalid image bitstream');
      },
    });

    assert.equal(await verifyDecodableImageBlob(preview), true);
    assert.equal(
      await verifyDecodableImageBlob(new Blob([missingSofCandidate], { type: 'image/jpeg' })),
      false
    );
    assert.equal(
      await verifyDecodableImageBlob(new Blob([missingSosCandidate], { type: 'image/jpeg' })),
      false
    );
  } finally {
    if (origDescriptor) {
      Object.defineProperty(globalThis, 'createImageBitmap', origDescriptor);
    } else {
      delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    }
  }
});

test('extractDecodableEmbeddedJpegFromRawBuffer tries indexed candidates first and falls back to buffer scan when none decodes', async () => {
  const makeSizedJpeg = (size: number, tagByte: number): Uint8Array => {
    const jpeg = new Uint8Array(size);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8; // SOI
    jpeg[2] = 0xff;
    jpeg[3] = 0xc0; // SOF0
    jpeg.set(
      [0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00],
      4
    );
    jpeg[21] = 0xff;
    jpeg[22] = 0xda; // SOS
    jpeg.set([0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00], 23);
    jpeg[35] = tagByte;
    jpeg[size - 2] = 0xff;
    jpeg[size - 1] = 0xd9; // EOI
    return jpeg;
  };

  const makeIfdWithTrailingBuffer = (ifdPayload: Uint8Array, trailingPayload: Uint8Array): ArrayBuffer => {
    const out = new Uint8Array(40 + ifdPayload.length + 16 + trailingPayload.length + 16);
    const v = new DataView(out.buffer);
    v.setUint16(0, 0x4949, false);
    v.setUint16(2, 42, true);
    v.setUint32(4, 8, true);
    v.setUint16(8, 2, true);
    v.setUint16(10, 0x0201, true);
    v.setUint16(12, 4, true);
    v.setUint32(14, 1, true);
    v.setUint32(18, 40, true);
    v.setUint16(22, 0x0202, true);
    v.setUint16(24, 4, true);
    v.setUint32(26, 1, true);
    v.setUint32(30, ifdPayload.length, true);
    v.setUint32(34, 0, true);
    out.set(ifdPayload, 40);
    out.set(trailingPayload, 40 + ifdPayload.length + 16);
    return out.buffer;
  };

  const indexedGood = makeSizedJpeg(600, 0x11);
  const indexedUnreadable = makeSizedJpeg(600, 0xee);
  const unindexedLarger = makeSizedJpeg(700, 0x22);

  const origDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  try {
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      writable: true,
      value: async (blob: Blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes[35] === 0xee) {
          throw new Error('Corrupt indexed preview bitstream');
        }
        return { width: 16, height: 16, close: () => {} };
      },
    });

    // 1. Fast path: decodable indexed candidate (>= 512) returns immediately without scanning for larger unindexed one
    const fastPathResult = await extractDecodableEmbeddedJpegFromRawBuffer(
      makeIfdWithTrailingBuffer(indexedGood, unindexedLarger)
    );
    assert.ok(fastPathResult instanceof Blob);
    assert.equal(fastPathResult.size, indexedGood.length);

    // 2. Fallback path: indexed candidate (>= 512) fails decode, so buffer scan discovers unindexed decodable preview
    const fallbackResult = await extractDecodableEmbeddedJpegFromRawBuffer(
      makeIfdWithTrailingBuffer(indexedUnreadable, unindexedLarger)
    );
    assert.ok(fallbackResult instanceof Blob);
    assert.equal(fallbackResult.size, unindexedLarger.length);
  } finally {
    if (origDescriptor) {
      Object.defineProperty(globalThis, 'createImageBitmap', origDescriptor);
    } else {
      delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    }
  }
});

// ---- RAW preview hardening: SOF filtering, decode cap, scan budget, vendor TIFF magic, orientation ----

const makeFrameJpeg = (size: number, sofMarker = 0xc0, tagByte = 0x11): Uint8Array<ArrayBuffer> => {
  const jpeg = new Uint8Array(size);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8; // SOI
  jpeg[2] = 0xff;
  jpeg[3] = sofMarker;
  jpeg.set(
    [0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00],
    4
  );
  jpeg[21] = 0xff;
  jpeg[22] = 0xda; // SOS
  jpeg.set([0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00], 23);
  jpeg[35] = tagByte;
  jpeg[size - 2] = 0xff;
  jpeg[size - 1] = 0xd9; // EOI
  return jpeg;
};

/**
 * Little-endian TIFF-family container whose IFD0 holds Orientation plus one pointer pair per named
 * slot: `strip` via StripOffsets/StripByteCounts, `preview` via JPEGInterchangeFormat(Length),
 * and `jpgFromRaw` via the Panasonic RW2 0x002E UNDEFINED tag. Each tag appears at most once.
 */
const makeTiffContainer = (
  {
    strip,
    preview,
    jpgFromRaw,
  }: { strip?: Uint8Array; preview?: Uint8Array; jpgFromRaw?: Uint8Array },
  { magic = 42, orientation }: { magic?: number; orientation?: number } = {}
): ArrayBuffer => {
  const pairs = [
    strip ? { payload: strip, offTag: 0x0111, lenTag: 0x0117 } : null,
    preview ? { payload: preview, offTag: 0x0201, lenTag: 0x0202 } : null,
  ].filter((p): p is { payload: Uint8Array; offTag: number; lenTag: number } => p !== null);
  const entryCount = pairs.length * 2 + (jpgFromRaw ? 1 : 0) + (orientation ? 1 : 0);
  const ifdSize = 2 + entryCount * 12 + 4;
  const dataStart = 8 + ifdSize;
  const payloadBytes =
    pairs.reduce((sum, p) => sum + p.payload.length, 0) + (jpgFromRaw?.length ?? 0);
  const out = new Uint8Array(dataStart + payloadBytes);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0x4949, false);
  v.setUint16(2, magic, true);
  v.setUint32(4, 8, true);
  v.setUint16(8, entryCount, true);
  let entry = 10;
  let offset = dataStart;
  if (jpgFromRaw) {
    v.setUint16(entry, 0x002e, true);
    v.setUint16(entry + 2, 7, true); // UNDEFINED
    v.setUint32(entry + 4, jpgFromRaw.length, true);
    v.setUint32(entry + 8, offset, true);
    entry += 12;
    out.set(jpgFromRaw, offset);
    offset += jpgFromRaw.length;
  }
  if (orientation) {
    v.setUint16(entry, 0x0112, true);
    v.setUint16(entry + 2, 3, true);
    v.setUint32(entry + 4, 1, true);
    v.setUint16(entry + 8, orientation, true);
    entry += 12;
  }
  for (const { payload, offTag, lenTag } of pairs) {
    v.setUint16(entry, offTag, true);
    v.setUint16(entry + 2, 4, true);
    v.setUint32(entry + 4, 1, true);
    v.setUint32(entry + 8, offset, true);
    v.setUint16(entry + 12, lenTag, true);
    v.setUint16(entry + 14, 4, true);
    v.setUint32(entry + 16, 1, true);
    v.setUint32(entry + 20, payload.length, true);
    entry += 24;
    out.set(payload, offset);
    offset += payload.length;
  }
  v.setUint32(entry, 0, true); // next IFD
  return out.buffer;
};

const withMockedImageBitmap = async (
  decoder: (bytes: Uint8Array) => boolean,
  body: () => Promise<void>
) => {
  const origDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    writable: true,
    value: async (blob: Blob) => {
      if (!decoder(new Uint8Array(await blob.arrayBuffer()))) throw new Error('decode failed');
      return { width: 16, height: 16, close: () => {} };
    },
  });
  try {
    await body();
  } finally {
    if (origDescriptor) {
      Object.defineProperty(globalThis, 'createImageBitmap', origDescriptor);
    } else {
      delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    }
  }
};

test('RAW preview candidates skip lossless SOF3 sensor strips so the real preview is tried first', () => {
  const losslessStrip = makeFrameJpeg(4000, 0xc3); // larger, structurally valid, not browser-decodable
  const preview = makeFrameJpeg(900, 0xc0);
  const candidates = extractEmbeddedJpegCandidatesFromRawBuffer(makeTiffContainer({ strip: losslessStrip, preview }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].size, preview.length);
});

test('extractDecodableEmbeddedJpegFromRawBuffer stops after MAX_RAW_PREVIEW_DECODE_ATTEMPTS failing decodes', async () => {
  const streams = Array.from({ length: MAX_RAW_PREVIEW_DECODE_ATTEMPTS + 6 }, (_, i) =>
    makeFrameJpeg(600 + i * 10, 0xc0, 0xee)
  );
  const wrapper = new Uint8Array(16 + streams.reduce((s, p) => s + p.length + 8, 0));
  let offset = 16;
  for (const s of streams) {
    wrapper.set(s, offset);
    offset += s.length + 8;
  }
  let decodeCalls = 0;
  await withMockedImageBitmap(
    () => {
      decodeCalls += 1;
      return false;
    },
    async () => {
      assert.equal(await extractDecodableEmbeddedJpegFromRawBuffer(wrapper.buffer), null);
    }
  );
  assert.equal(decodeCalls, MAX_RAW_PREVIEW_DECODE_ATTEMPTS);
});

test('fallback scan stays linear on a crafted buffer of nested APP segments over one long entropy run', () => {
  // k SOI+APP1 headers, each APP1 payload swallowing the next header, all funnelling into one
  // SOF/SOS with a long entropy run and no EOI until the very end: quadratic without a work budget.
  const k = 4000;
  const header = 6; // FF D8 FF E1 len(2)
  const entropyLen = 2_000_000;
  const tailStart = k * header;
  const buf = new Uint8Array(tailStart + 40 + entropyLen + 6);
  for (let i = 0; i < k; i++) {
    const at = i * header;
    const segLen = tailStart - at - 4; // payload runs up to the shared SOF
    buf.set([0xff, 0xd8, 0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff], at);
  }
  buf.set(
    [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00],
    tailStart
  );
  buf.set([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x3f, 0x00], tailStart + 19);
  buf.fill(0x5a, tailStart + 33, tailStart + 33 + entropyLen);
  // Unescaped nested SOI ends the run (rejecting every enclosing stream), then the only EOI
  buf.set([0xff, 0xd8, 0xff, 0xd9], buf.length - 4);

  // Every enclosing stream is rejected by the nested SOI, so the scan finds nothing and terminates
  assert.deepEqual(extractEmbeddedJpegCandidatesFromRawBuffer(buf.buffer), []);
});

test('scan budget stops a stream walk at the exact entropy-byte boundary', () => {
  const jpeg = makeFrameJpeg(600);
  // Marker steps: SOI->SOF, SOF->SOS; then one unit per entropy byte until the EOI
  const generous = { remaining: 10_000 };
  const full = scanJpegStreamForTest(jpeg, 0, jpeg.length, generous);
  assert.equal(full.valid, true);
  assert.equal(full.endOffset, jpeg.length);
  const spent = 10_000 - generous.remaining;

  const exact = { remaining: spent };
  assert.equal(scanJpegStreamForTest(jpeg, 0, jpeg.length, exact).valid, true);
  assert.equal(exact.remaining, 0);

  const short = { remaining: spent - 1 };
  const cut = scanJpegStreamForTest(jpeg, 0, jpeg.length, short);
  assert.equal(cut.valid, false);
  assert.equal(cut.budgetExhausted, true);
});

test('scan budget charges every 0xFF fill byte, in marker padding and before EOI', () => {
  const fill = 64;
  const base = makeFrameJpeg(600);
  // Same stream with `fill` extra 0xFF fill bytes before the SOF marker and before EOI
  const padded = new Uint8Array(base.length + fill * 2);
  padded.set(base.subarray(0, 2), 0);
  padded.fill(0xff, 2, 2 + fill);
  padded.set(base.subarray(2, base.length - 2), 2 + fill);
  padded.fill(0xff, padded.length - 2 - fill, padded.length - 2);
  padded.set([0xff, 0xd9], padded.length - 2);

  const baseBudget = { remaining: 10_000 };
  assert.equal(scanJpegStreamForTest(base, 0, base.length, baseBudget).valid, true);
  const paddedBudget = { remaining: 10_000 };
  assert.equal(scanJpegStreamForTest(padded, 0, padded.length, paddedBudget).valid, true);
  const extra = (10_000 - paddedBudget.remaining) - (10_000 - baseBudget.remaining);
  assert.ok(extra >= fill * 2, `fill bytes cost ${extra} units, expected at least ${fill * 2}`);

  const tooSmall = { remaining: 10_000 - baseBudget.remaining };
  const res = scanJpegStreamForTest(padded, 0, padded.length, tooSmall);
  assert.equal(res.budgetExhausted, true);
});

test('ORF and RW2 vendor TIFF magic numbers still use the IFD fast path', () => {
  const preview = makeFrameJpeg(300); // < 512 bytes: only IFD discovery can find it, not the scan
  for (const magic of [0x4f52, 0x5352, 0x0055]) {
    const candidates = extractEmbeddedJpegCandidatesFromRawBuffer(
      makeTiffContainer({ preview }, { magic })
    );
    assert.equal(candidates.length, 1, `magic 0x${magic.toString(16)}`);
    assert.equal(candidates[0].size, preview.length);
  }
});

test('RW2 JpgFromRaw (tag 0x002E) previews are found through the IFD, even below the scan minimum', () => {
  const preview = makeFrameJpeg(300); // < 512 bytes: the fallback scan would skip it
  const candidates = extractEmbeddedJpegCandidatesFromRawBuffer(
    makeTiffContainer({ jpgFromRaw: preview }, { magic: 0x0055 })
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].size, preview.length);
});

test('indexed previews with padding after EOI dedupe against the scanned stream', () => {
  const preview = makeFrameJpeg(900);
  const padded = new Uint8Array(preview.length + 64);
  padded.set(preview, 0);
  const candidates = extractEmbeddedJpegCandidatesFromRawBuffer(makeTiffContainer({ preview: padded }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].size, preview.length);
});

test('a preview nested in an APP payload is offered only after its enclosing stream', async () => {
  const inner = makeFrameJpeg(700, 0xc0, 0x22);
  // Outer: SOI, APP2 holding the inner JPEG, then the frame of a normal stream
  const outerBody = makeFrameJpeg(1200, 0xc0, 0x33);
  const app = new Uint8Array(4 + inner.length);
  app.set([0xff, 0xe2, ((inner.length + 2) >> 8) & 0xff, (inner.length + 2) & 0xff], 0);
  app.set(inner, 4);
  const outer = new Uint8Array(outerBody.length + app.length);
  outer.set(outerBody.subarray(0, 2), 0);
  outer.set(app, 2);
  outer.set(outerBody.subarray(2), 2 + app.length);
  const wrapper = new Uint8Array(16 + outer.length + 16);
  wrapper.set(outer, 16);

  const sizes = extractEmbeddedJpegCandidatesFromRawBuffer(wrapper.buffer).map((b) => b.size);
  assert.deepEqual(sizes, [outer.length, inner.length]);

  const tried: number[] = [];
  await withMockedImageBitmap(
    (bytes) => {
      tried.push(bytes.length);
      return true;
    },
    async () => {
      const blob = await extractDecodableEmbeddedJpegFromRawBuffer(wrapper.buffer);
      assert.equal(blob?.size, outer.length);
    }
  );
  assert.deepEqual(tried, [outer.length]);
});

test('decode cap is checked before the iterator resumes, keeping the last attempt for the scan', async () => {
  // Seven indexed-equivalent failures leave the eighth attempt for a scanned stream
  const streams = Array.from({ length: MAX_RAW_PREVIEW_DECODE_ATTEMPTS }, (_, i) =>
    makeFrameJpeg(600 + i * 10, 0xc0, 0x40 + i)
  );
  const wrapper = new Uint8Array(16 + streams.reduce((s, p) => s + p.length + 8, 0));
  let offset = 16;
  for (const s of streams) {
    wrapper.set(s, offset);
    offset += s.length + 8;
  }
  let calls = 0;
  await withMockedImageBitmap(
    () => {
      calls += 1;
      return calls === MAX_RAW_PREVIEW_DECODE_ATTEMPTS;
    },
    async () => {
      assert.ok(await extractDecodableEmbeddedJpegFromRawBuffer(wrapper.buffer));
    }
  );
  assert.equal(calls, MAX_RAW_PREVIEW_DECODE_ATTEMPTS);
});

test('previews with Exif but no Orientation get the container Orientation; valid ones are kept', () => {
  const preview = makeFrameJpeg(900);
  // Exif APP1 with an empty IFD0 (no Orientation entry)
  const app1 = new Uint8Array([
    0xff, 0xe1, 0x00, 0x14, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const withExif = new Uint8Array(preview.length + app1.length);
  withExif.set(preview.subarray(0, 2), 0);
  withExif.set(app1, 2);
  withExif.set(preview.subarray(2), 2 + app1.length);
  assert.equal(readJpegExifOrientation(withExif), 0);

  const tagged = withJpegOrientation(withExif, 6);
  assert.equal(tagged.length, withExif.length + 36);
  assert.equal(readJpegExifOrientation(tagged), 6);
  assert.deepEqual([...tagged.subarray(38)], [...withExif.subarray(2)]);

  const alreadyOriented = withJpegOrientation(preview, 8);
  assert.equal(readJpegExifOrientation(alreadyOriented), 8);
  assert.equal(withJpegOrientation(alreadyOriented, 3), alreadyOriented);
});

test('RAW container Orientation is applied to the decoded embedded preview', async () => {
  const preview = makeFrameJpeg(900);
  const buffer = makeTiffContainer({ preview }, { orientation: 6 });
  assert.equal(readRawContainerOrientation(buffer), 6);
  assert.equal(readRawContainerOrientation(new Uint8Array(32).buffer), 1);

  await withMockedImageBitmap(
    () => true,
    async () => {
      const blob = await extractDecodableEmbeddedJpegFromRawBuffer(buffer);
      assert.ok(blob instanceof Blob);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      assert.equal(bytes.length, preview.length + 36);
      assert.deepEqual([...bytes.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe1]);
      assert.equal(String.fromCharCode(...bytes.subarray(6, 10)), 'Exif');
      const v = new DataView(bytes.buffer);
      assert.equal(v.getUint16(12 + 10, true), 0x0112); // IFD0 entry tag
      assert.equal(v.getUint16(12 + 18, true), 6); // Orientation value
      assert.deepEqual([...bytes.subarray(38)], [...preview.subarray(2)]);
    }
  );

  // Orientation 1 and previews that already carry an Exif APP1 are left untouched
  assert.equal(withJpegOrientation(preview, 1), preview);
  const tagged = withJpegOrientation(preview, 8);
  assert.equal(withJpegOrientation(tagged, 3), tagged);
});
