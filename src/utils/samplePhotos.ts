import { ExifData } from './geometry';
import coastalHorizonSrc from '../assets/images/sample_coastal_horizon_1793590430896.jpg';
import tokyoArchitectureSrc from '../assets/images/sample_tokyo_architecture_1793590432060.jpg';
import alpineLakeSrc from '../assets/images/sample_alpine_lake_1793590432475.jpg';

export interface StudioPhotoItem {
  id: string;
  title: string;
  fileName: string;
  src: string;
  isRaw: boolean;
  simulatedSensorTiltDeg: number;
  exif: ExifData;
  rawApp1Segment: Uint8Array | null;
}

export const INITIAL_SAMPLE_PHOTOS: StudioPhotoItem[] = [
  {
    id: 'coastal-horizon',
    title: 'Cape Elizabeth Lighthouse',
    fileName: 'L1004821.DNG',
    src: coastalHorizonSrc,
    isRaw: true,
    simulatedSensorTiltDeg: 3.4,
    rawApp1Segment: null,
    exif: {
      cameraModel: 'Leica M11',
      lensModel: 'Summilux-M 35mm f/1.4 ASPH',
      focalLength: '35mm',
      aperture: 'f/5.6',
      shutterSpeed: '1/1000s',
      iso: '64',
      dateTimeOriginal: '2026:10:28 17:42:19',
      colorSpace: '14-bit Linear DNG → sRGB',
      rawFormat: 'DNG',
    },
  },
  {
    id: 'tokyo-architecture',
    title: 'Tokyo Concrete Facade',
    fileName: 'DSC09412.ARW',
    src: tokyoArchitectureSrc,
    isRaw: true,
    simulatedSensorTiltDeg: -2.6,
    rawApp1Segment: null,
    exif: {
      cameraModel: 'Sony ILCE-7RM5',
      lensModel: 'FE 24-70mm F2.8 GM II',
      focalLength: '35mm',
      aperture: 'f/8.0',
      shutterSpeed: '1/640s',
      iso: '100',
      dateTimeOriginal: '2026:10:30 14:18:05',
      colorSpace: '14-bit ARW RAW → sRGB',
      rawFormat: 'ARW',
    },
  },
  {
    id: 'alpine-lake',
    title: 'Lofoten Fjord Reflection',
    fileName: 'DSCF3109.JPG',
    src: alpineLakeSrc,
    isRaw: false,
    simulatedSensorTiltDeg: 2.1,
    rawApp1Segment: null,
    exif: {
      cameraModel: 'Fujifilm GFX100 II',
      lensModel: 'GF 45mmF2.8 R WR',
      focalLength: '45mm',
      aperture: 'f/8.0',
      shutterSpeed: '1/250s',
      iso: '80',
      dateTimeOriginal: '2026:10:31 06:51:44',
      colorSpace: 'sRGB IEC61966-2.1',
      rawFormat: 'JPEG',
    },
  },
];

export interface BackgroundColorPreset {
  id: string;
  label: string;
  hex: string;
  textColorHex: string;
}

export const BACKGROUND_COLOR_PRESETS: BackgroundColorPreset[] = [
  { id: 'pure-white', label: 'Pure White', hex: '#FFFFFF', textColorHex: '#27272A' },
  { id: 'gallery-warm', label: 'Warm Archive', hex: '#F6F4EF', textColorHex: '#27272A' },
  { id: 'museum-alabaster', label: 'Alabaster Gray', hex: '#EAECEF', textColorHex: '#18181B' },
  { id: 'obsidian-black', label: 'Obsidian Black', hex: '#0D0D0F', textColorHex: '#A1A1AA' },
  { id: 'charcoal-matte', label: 'Carbon Matte', hex: '#1C1D21', textColorHex: '#D4D4D8' },
];
