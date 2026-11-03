import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExifFromArrayBuffer,
  injectApp1ExifIntoJpegBlob,
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
