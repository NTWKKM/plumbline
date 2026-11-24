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
      // Only status this import set is cleared afterwards, so an export's progress is left alone
      const ownsStatus = imageFiles.length > 0;
      if (ownsStatus) {
        notices.setStatus(`Importing ${imageFiles.length} ${imageFiles.length === 1 ? 'photo' : 'photos'}…`);
      }

      const imported: StudioPhotoItem[] = [];
      const unsaved: string[] = [];
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
          const saved = await savePhoto({
            id: item.id,
            title: item.title,
            fileName: item.fileName,
            isRaw: item.isRaw,
            exif: item.exif,
            rawApp1Segment: item.rawApp1Segment,
            blob: displayBlob,
          });
          // An unsaved photo still works this session; it just will not come back after a reload
          if (!saved) unsaved.push(file.name);
        } catch (err) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          failed.push(`${file.name} (${err instanceof Error ? err.message : 'unreadable file'})`);
        }
      }

      if (ownsStatus) notices.setStatus(null);
      if (imported.length > 0) {
        setPhotos((prev) => [...imported, ...prev]);
        setSelectedId(imported[0].id);
      }
      const problems = [
        failed.length > 0 ? `Import error: unable to import ${failed.join('; ')}.` : '',
        unsaved.length > 0
          ? `Could not save ${unsaved.join(', ')} on this device; ${unsaved.length === 1 ? 'it stays' : 'they stay'} in the queue until you close the page.`
          : '',
      ].filter(Boolean);
      notices.setError(problems.length > 0 ? problems.join(' ') : null);
      return imported;
    },
    [notices]
  );

  /** Resolves false, keeping the photo, when its stored copy could not be deleted. */
  const removePhoto = useCallback(
    async (id: string): Promise<boolean> => {
      if (photos.length <= 1) return false;
      const idx = photos.findIndex((p) => p.id === id);
      if (idx < 0) return false;
      const removed = photos[idx];
      // Delete from storage first: a photo dropped only from memory would come back on reload
      if (!isSamplePhoto(id) && !(await deletePhoto(id))) {
        notices.setError(`Could not remove ${removed.title} from this device's storage. Try again.`);
        return false;
      }
      const next = photos.filter((p) => p.id !== id);
      setSelectedId((sel) => (sel === id ? next[Math.min(idx, next.length - 1)].id : sel));
      setPhotos((prev) => prev.filter((p) => p.id !== id));
      if (removed.src.startsWith('blob:')) URL.revokeObjectURL(removed.src);
      return true;
    },
    [photos, notices]
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
