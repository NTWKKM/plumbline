/** File-system helpers for export: folder writes, name collisions, downloads. */

export type DirectoryHandle = {
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
};

export async function directoryHasFile(directory: DirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (err) {
    if (err instanceof DOMException) {
      if (err.name === 'NotFoundError') return false;
      // A folder with that name exists, so the name is taken
      if (err.name === 'TypeMismatchError') return true;
    }
    // NotAllowedError and anything else: rethrow so the batch stops and reports it
    // instead of probing suffixes forever
    throw err;
  }
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/**
 * Keeps `name` when free, otherwise the first `stem-N.ext` that is neither allocated earlier in
 * this batch nor (when `isTaken` is given) already present in the destination.
 */
export async function uniqueFileName(
  name: string,
  used: Set<string>,
  isTaken?: (candidate: string) => Promise<boolean>
): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  let n = 1;
  while (used.has(candidate) || (isTaken && (await isTaken(candidate)))) {
    n += 1;
    candidate = `${stem}-${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
