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

test('injectApp1ExifIntoJpegBlob returns exifPreserved false when rawApp1Segment is null or missing', async () => {
  const dummyJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const dummyBlob = new Blob([dummyJpegBytes], { type: 'image/jpeg' });

  const result = await injectApp1ExifIntoJpegBlob(dummyBlob, null);
  assert.equal(result.exifPreserved, false);
  assert.equal(result.blob, dummyBlob);
});
