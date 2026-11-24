import { useCallback, useRef, useState } from 'react';
import { PipelineConfig } from '../utils/geometry';
import { injectApp1ExifIntoJpegBlob } from '../utils/exifParser';
import { renderPhotoToFramedCanvas } from '../utils/framePipeline';
import { createMutex, runPool } from '../utils/pool';
import { StudioPhotoItem } from '../utils/samplePhotos';
import {
  DirectoryHandle,
  directoryHasFile,
  downloadBlob,
  supportsDirectoryPicker,
  uniqueFileName,
} from '../utils/exportFiles';

export type ExportStatus = 'exported' | 'requested';

/** Two photos render at once: faster than one, without doubling peak canvas memory twice over. */
const BATCH_CONCURRENCY = 2;

interface Notices {
  setStatus: (message: string | null) => void;
  setError: (message: string | null) => void;
}

async function encodeJpeg(
  photo: StudioPhotoItem,
  config: PipelineConfig
): Promise<{ blob: Blob; outName: string; width: number; height: number; exifPreserved: boolean }> {
  const { canvas, sourceSize } = await renderPhotoToFramedCanvas(photo, config);
  const quality = Math.max(0.7, Math.min(1.0, config.jpegQuality / 100));
  const encoded = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
  );
  if (!encoded) throw new Error('Failed to encode the canvas as JPEG.');

  let blob = encoded;
  let exifPreserved = false;
  if (config.preserveExifMetadata) {
    const result = await injectApp1ExifIntoJpegBlob(encoded, photo.rawApp1Segment, {
      width: canvas.width,
      height: canvas.height,
      sourceWidth: sourceSize.width,
      sourceHeight: sourceSize.height,
    });
    blob = result.blob;
    exifPreserved = result.exifPreserved;
  }
  const baseName = photo.fileName.replace(/\.[^.]+$/, '');
  const outName = `${baseName}_whiteborder_${config.aspectPreset.replace(':', 'x')}.jpg`;
  return { blob, outName, width: canvas.width, height: canvas.height, exifPreserved };
}

/**
 * Single and batch JPEG export. Both render through the same offscreen pipeline as the preview.
 * The batch renders in parallel, writes one file at a time, and can be cancelled between photos.
 */
export function useExport(notices: Notices) {
  const [isExporting, setIsExporting] = useState(false);
  const [isBatchExporting, setIsBatchExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<Record<string, ExportStatus>>({});
  const abortRef = useRef<AbortController | null>(null);
  const noticesRef = useRef(notices);
  noticesRef.current = notices;

  const mark = useCallback((id: string, status: ExportStatus) => {
    setExportStatus((prev) => {
      // A confirmed folder write is never downgraded by a later download request
      if (prev[id] === status || (prev[id] === 'exported' && status === 'requested')) return prev;
      return { ...prev, [id]: status };
    });
  }, []);

  const forget = useCallback((id: string) => {
    setExportStatus((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const exportOne = useCallback(
    async (photo: StudioPhotoItem, config: PipelineConfig) => {
      const { setStatus, setError } = noticesRef.current;
      setIsExporting(true);
      setStatus(null);
      setError(null);
      try {
        const { blob, outName, width, height, exifPreserved } = await encodeJpeg(photo, config);
        downloadBlob(blob, outName);
        mark(photo.id, 'requested');
        setStatus(
          `Download requested for ${outName} (${width} × ${height} px, EXIF ${exifPreserved ? 'preserved' : 'stripped'})`
        );
      } catch (err) {
        setError(`Export error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setIsExporting(false);
      }
    },
    [mark]
  );

  const exportAll = useCallback(
    async (photos: StudioPhotoItem[], configFor: (photo: StudioPhotoItem) => PipelineConfig) => {
      if (photos.length === 0 || abortRef.current) return;
      const { setStatus, setError } = noticesRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      setIsBatchExporting(true);

      // Where the browser allows it, write into one chosen folder instead of a download per photo
      let directory: DirectoryHandle | null = null;
      if (supportsDirectoryPicker()) {
        try {
          directory = await (
            window as unknown as {
              showDirectoryPicker: (o: { mode: 'readwrite'; id?: string }) => Promise<DirectoryHandle>;
            }
          ).showDirectoryPicker({ mode: 'readwrite', id: 'plumbline-export' });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            abortRef.current = null;
            setIsBatchExporting(false);
            return;
          }
          directory = null;
        }
      }

      setStatus(`Exporting 0 of ${photos.length}…`);
      setError(null);
      let done = 0;
      // Set by the first failed photo: lanes still encoding finish, but write nothing more
      let failed = false;
      const stopped = () => controller.signal.aborted || failed;
      const usedNames = new Set<string>();
      const writeLock = createMutex();
      try {
        await runPool(
          photos,
          BATCH_CONCURRENCY,
          async (photo) => {
            try {
              const { blob, outName } = await encodeJpeg(photo, configFor(photo));
              if (stopped()) return;
              const wrote = await writeLock(async () => {
                // Re-checked inside the lock: a write queued behind another may start after Cancel
                if (stopped()) return false;
                if (directory) {
                  const dir = directory;
                  const name = await uniqueFileName(outName, usedNames, (c) => directoryHasFile(dir, c));
                  if (stopped()) return false;
                  const handle = await dir.getFileHandle(name, { create: true });
                  const writable = await handle.createWritable();
                  await writable.write(blob);
                  await writable.close();
                  mark(photo.id, 'exported');
                } else {
                  const name = await uniqueFileName(outName, usedNames);
                  if (stopped()) return false;
                  downloadBlob(blob, name);
                  mark(photo.id, 'requested');
                }
                return true;
              });
              if (!wrote) return;
              done += 1;
              setStatus(`Exporting ${done} of ${photos.length}…`);
            } catch (err) {
              failed = true;
              throw err;
            }
          },
          controller.signal
        );
        setStatus(
          directory
            ? `Saved ${done} framed ${done === 1 ? 'JPEG' : 'JPEGs'} to the chosen folder.`
            : `Requested ${done} framed JPEG ${done === 1 ? 'download' : 'downloads'}. Your browser may ask before allowing several.`
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setStatus(`Export cancelled after ${done} of ${photos.length}.`);
        } else {
          setStatus(null);
          setError(
            `Export error: batch export stopped after ${done} of ${photos.length}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      } finally {
        abortRef.current = null;
        setIsBatchExporting(false);
      }
    },
    [mark]
  );

  const cancelBatch = useCallback(() => abortRef.current?.abort(), []);

  return { isExporting, isBatchExporting, exportStatus, exportOne, exportAll, cancelBatch, forget };
}
