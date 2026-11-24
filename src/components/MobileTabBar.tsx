import React from 'react';
import { Download, Image as ImageIcon, Images, SlidersHorizontal } from 'lucide-react';

export type MobileTab = 'canvas' | 'adjust' | 'queue';

interface MobileTabBarProps {
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
  tab,
  onTabChange,
  queueCount,
  onExport,
  exportDisabled,
  isExporting,
}) => (
  <nav
    aria-label="Workspace section"
    className="lg:hidden flex items-stretch gap-1 border-t border-rule bg-paper-2 px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] shrink-0"
  >
    {TABS.map(({ value, label, icon: Icon }) => {
      const active = tab === value;
      return (
        <button
          key={value}
          type="button"
          aria-pressed={active}
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
