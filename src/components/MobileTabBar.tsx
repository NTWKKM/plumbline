import React, { useRef } from 'react';
import { Download, Image as ImageIcon, Images, SlidersHorizontal } from 'lucide-react';

export type MobileTab = 'canvas' | 'adjust' | 'queue';

/** The element id of each tab's panel, so the tabs can point at what they show. */
export const MOBILE_PANEL_IDS: Record<MobileTab, string> = {
  canvas: 'panel-canvas',
  adjust: 'panel-adjust',
  queue: 'panel-queue',
};

interface MobileTabBarProps {
  inert?: boolean;
  tab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  queueCount: number;
  onExport: () => void;
  exportDisabled: boolean;
  isExporting: boolean;
}

const TABS: { value: MobileTab; label: string; icon: typeof ImageIcon }[] = [
  { value: 'canvas', label: 'Photo', icon: ImageIcon },
  { value: 'adjust', label: 'Adjust', icon: SlidersHorizontal },
  { value: 'queue', label: 'Queue', icon: Images },
];

/** Thumb-reach navigation for phones and tablets, with export always one tap away. */
export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  inert,
  tab,
  onTabChange,
  queueCount,
  onExport,
  exportDisabled,
  isExporting,
}) => {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Arrow keys move between tabs (wrapping), Home and End jump to the ends
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const current = TABS.findIndex((t) => t.value === tab);
    let next: number;
    if (e.key === 'ArrowRight') next = (current + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    onTabChange(TABS[next].value);
    tabRefs.current[next]?.focus();
  };

  return (
    <nav
      inert={inert}
      aria-label="Workspace section"
      className="lg:hidden flex items-stretch gap-1 border-t border-rule bg-paper-2 px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] shrink-0"
    >
      <div role="tablist" aria-label="Workspace panels" className="flex flex-[3] items-stretch gap-1" onKeyDown={handleKeyDown}>
        {TABS.map(({ value, label, icon: Icon }, i) => {
          const active = tab === value;
          return (
            <button
              key={value}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${value}`}
              aria-selected={active}
              aria-controls={MOBILE_PANEL_IDS[value]}
              tabIndex={active ? 0 : -1}
              onClick={() => onTabChange(value)}
              className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-pill text-xs font-medium transition-colors ${
                active ? 'bg-paper text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {value === 'queue' ? `${label} (${queueCount})` : label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onExport}
        disabled={exportDisabled}
        aria-busy={isExporting}
        className="btn min-h-[44px] flex-1 flex-col gap-0.5 text-xs"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        {isExporting ? 'Saving…' : 'Export'}
      </button>
    </nav>
  );
};
