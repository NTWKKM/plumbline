import React from 'react';
import { X } from 'lucide-react';
import { StudioPhotoItem } from '../utils/samplePhotos';
import { ExportStatus } from '../hooks/useExport';

interface FilmstripQueueProps {
  id?: string;
  photos: StudioPhotoItem[];
  activeId: string;
  editedIds: Set<string>;
  exportStatus: Record<string, ExportStatus>;
  locked: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onImport: () => void;
  className?: string;
}

export const FilmstripQueue: React.FC<FilmstripQueueProps> = ({
  photos,
  activeId,
  editedIds,
  exportStatus,
  locked,
  onSelect,
  onRemove,
  onImport,
  className = '',
  id,
}) => (
  <aside id={id} aria-label="Filmstrip queue" className={`flex-col border-rule bg-paper-2 ${className}`}>
    <div className="flex items-center justify-between border-b border-rule px-4 py-3 shrink-0">
      <h2 className="font-display text-sm font-normal text-ink">Queue ({photos.length})</h2>
    </div>

    <ul className="flex flex-col gap-2.5 overflow-y-auto p-3 flex-1 min-h-0" role="list">
      {photos.map((item) => {
        const isSelected = item.id === activeId;
        const status = exportStatus[item.id];
        const notes = [
          editedIds.has(item.id) ? 'Edited' : null,
          status === 'exported' ? 'Exported' : status === 'requested' ? 'Download requested' : null,
        ].filter(Boolean);
        return (
          <li key={item.id} className="filmstrip-item relative w-full shrink-0 min-w-0">
            <button
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelect(item.id)}
              className={`flex w-full gap-2.5 lg:flex-col p-2 text-left transition-colors min-w-0 ${
                isSelected
                  ? 'atelier-stock border-ink text-ink'
                  : 'border border-rule bg-paper hover:bg-paper-3 hover:border-ink-2 text-ink-2'
              }`}
            >
              <div className="relative h-16 w-24 lg:h-28 lg:w-full shrink-0 overflow-hidden bg-paper-3 border border-rule">
                <img
                  src={item.src}
                  alt=""
                  width={320}
                  height={180}
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="min-w-0 w-full self-center lg:self-auto">
                <span className="block truncate text-xs font-medium text-ink">{item.title}</span>
                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
                  <span className="truncate min-w-0 font-mono">{item.fileName}</span>
                  {notes.length > 0 && (
                    <span className={`shrink-0 ${status === 'exported' ? 'text-success' : ''}`}>
                      {notes.join(', ')}
                    </span>
                  )}
                </div>
              </div>
            </button>
            {photos.length > 1 && (
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                disabled={locked}
                aria-label={`Remove ${item.title} from the queue`}
                title="Remove from queue"
                className="filmstrip-remove icon-btn absolute right-3.5 top-3.5 z-raised border border-rule bg-paper"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </li>
        );
      })}
      <li>
        <button
          type="button"
          onClick={onImport}
          className="flex w-full flex-col items-center justify-center gap-0.5 border border-dashed border-rule bg-paper px-3 py-3 text-center text-xs text-muted transition-colors hover:border-ink-2 hover:text-ink"
        >
          <span>Add photos</span>
          <span className="text-muted">or drop and paste them anywhere</span>
        </button>
      </li>
    </ul>
  </aside>
);
