import { useCallback, useState } from 'react';
import {
  extractDecodableEmbeddedJpegFromRawBuffer,
  isSupportedImageOrRawFileName,
  parseExifFromArrayBuffer,
  verifyDecodableImageBlob,
} from '../utils/exifParser';
import { deletePhoto, savePhoto } from '../utils/persist';
import { INITIAL_SAMPLE_PHOTOS, StudioPhotoItem } from '../utils/samplePhotos';

interface Notices {
  setStatus: (message: string | null) => void;
  setError: (message: string | null) => void;
}

export const isSamplePhoto = (id: string) => INITIAL_SAMPLE_PHOTOS.some((p) => p.id === id);

function newId(): string {
  const suffix =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `imported-${suffix}`;
}

/** The photo queue: order, selection, import (with RAW preview extraction) and removal. */
export function usePhotoQueue(notices: Notices) {
  const [photos, setPhotos] = useState<StudioPhotoItem[]>(INITIAL_SAMPLE_PHOTOS);
  const [selectedId, setSelectedId] = useState<string>(INITIAL_SAMPLE_PHOTOS[0].id);
  const activePhoto = photos.find((p) => p.id === selectedId) ?? photos[0];

  const importFiles = useCallback(
    async (files: File[]): Promise<StudioPhotoItem[]> => {
      const imageFiles: File[] = [];
      const failed: string[] = [];
      for (const file of files) {
        if (isSupportedImageOrRawFileName(file.name) || file.type.startsWith('image/')) {
          imageFiles.push(file);
        } else {
          // Unsupported files are reported, never dropped silently
          failed.push(`${file.name} (not an image or RAW file)`);
        }
      }
      if (imageFiles.length > 0) {
        notices.setStatus(`Importing ${imageFiles.length} ${imageFiles.length === 1 ? 'photo' : 'photos'}…`);
      }

      const imported: StudioPhotoItem[] = [];
      for (const file of imageFiles) {
        let objectUrl: string | null = null;
        try {
          const buffer = await file.arrayBuffer();
          const parsed = parseExifFromArrayBuffer(buffer, file.name);
          let displayBlob: Blob | null;
          if (parsed.isRawContainer) {
            displayBlob = await extractDecodableEmbeddedJpegFromRawBuffer(buffer);
            if (!displayBlob) {
              failed.push(`${file.name} (no decodable embedded JPEG preview found in RAW file)`);
              continue;
            }
          } else {
            if (!(await verifyDecodableImageBlob(file))) {
              failed.push(`${file.name} (unsupported or corrupt image data)`);
              continue;
            }
            displayBlob = file;
          }
          objectUrl = URL.createObjectURL(displayBlob);
          const item: StudioPhotoItem = {
            id: newId(),
            title: file.name.replace(/\.[^.]+$/, ''),
            fileName: file.name,
            src: objectUrl,
            isRaw: parsed.isRawContainer,
            simulatedSensorTiltDeg: 0,
            exif: parsed.exif,
            rawApp1Segment: parsed.isRawContainer ? null : parsed.rawApp1Segment,
          };
          imported.push(item);
          void savePhoto({
            id: item.id,
            title: item.title,
            fileName: item.fileName,
            isRaw: item.isRaw,
            exif: item.exif,
            rawApp1Segment: item.rawApp1Segment,
            blob: displayBlob,
          });
        } catch (err) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          failed.push(`${file.name} (${err instanceof Error ? err.message : 'unreadable file'})`);
        }
      }

      notices.setStatus(null);
      if (imported.length > 0) {
        setPhotos((prev) => [...imported, ...prev]);
        setSelectedId(imported[0].id);
      }
      notices.setError(failed.length > 0 ? `Import error: unable to import ${failed.join('; ')}` : null);
      return imported;
    },
    [notices]
  );

  const removePhoto = useCallback(
    (id: string) => {
      if (photos.length <= 1) return;
      const idx = photos.findIndex((p) => p.id === id);
      if (idx < 0) return;
      const next = photos.filter((p) => p.id !== id);
      if (id === activePhoto.id) setSelectedId(next[Math.min(idx, next.length - 1)].id);
      setPhotos(next);
      const removed = photos[idx];
      if (removed.src.startsWith('blob:')) URL.revokeObjectURL(removed.src);
      if (!isSamplePhoto(id)) void deletePhoto(id);
    },
    [photos, activePhoto.id]
  );

  const selectRelative = useCallback(
    (step: number) => {
      const idx = photos.findIndex((p) => p.id === activePhoto.id);
      const next = photos[idx + step];
      if (next) setSelectedId(next.id);
    },
    [photos, activePhoto.id]
  );

  return { photos, setPhotos, activePhoto, setSelectedId, importFiles, removePhoto, selectRelative };
}
