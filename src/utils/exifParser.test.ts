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
  app1[3] = totalLen;
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
