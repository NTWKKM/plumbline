import React, { useState } from 'react';
import { Check, Copy, Download, Terminal, X } from 'lucide-react';
import { RUST_CARGO_TOML, RUST_MAIN_RS } from '../utils/rustMacosSource';

interface RustCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const RustCodeModal: React.FC<RustCodeModalProps> = ({ isOpen, onClose }) => {
  const [activeFile, setActiveFile] = useState<'main.rs' | 'Cargo.toml'>('main.rs');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  if (!isOpen) return null;

  const activeCode = activeFile === 'main.rs' ? RUST_MAIN_RS : RUST_CARGO_TOML;

  const handleCopy = async () => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(activeCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError('Failed to copy');
      setTimeout(() => setCopyError(null), 3000);
    }
  };

  const handleDownloadFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rust-modal-title"
    >
      <div className="flex h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#111114] text-zinc-100 shadow-2xl">
        {/* Top Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <div>
            <h2 id="rust-modal-title" className="font-display text-lg font-semibold text-zinc-100">
              macOS Native Rust Source Code (eframe / egui + Pure-Rust RAW & EXIF)
            </h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              Single-binary macOS Desktop GUI · Zero C/C++ OpenCV runtime dependencies · Apple Silicon & Intel
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Rust source code modal"
            className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Build instructions bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 bg-[#16161a] px-6 py-3">
          <div className="flex items-center gap-3 text-xs text-zinc-300">
            <Terminal className="h-4 w-4 text-blue-400 shrink-0" />
            <span className="font-mono">
              mkdir -p whiteborder-macos/src && cd whiteborder-macos; save Cargo.toml here and src/main.rs in src/, then cargo run --release
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Segmented file selector */}
            <div className="flex items-center rounded-lg bg-zinc-900 p-1 border border-zinc-800">
              <button
                type="button"
                onClick={() => {
                  setActiveFile('main.rs');
                  setCopied(false);
                  setCopyError(null);
                }}
                className={`rounded-md px-3 py-1 text-xs font-mono font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeFile === 'main.rs'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                src/main.rs
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveFile('Cargo.toml');
                  setCopied(false);
                  setCopyError(null);
                }}
                className={`rounded-md px-3 py-1 text-xs font-mono font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeFile === 'Cargo.toml'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Cargo.toml
              </button>
            </div>

            {copyError && (
              <span className="text-xs text-rose-400 font-mono" role="alert">
                {copyError}
              </span>
            )}

            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700 whitespace-nowrap shrink-0"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : `Copy ${activeFile}`}
            </button>

            <button
              type="button"
              onClick={() => handleDownloadFile(activeFile, activeCode)}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              Download {activeFile}
            </button>
          </div>
        </div>

        {/* Code Content */}
        <div className="flex-1 overflow-auto p-6 bg-[#0b0b0d]">
          <pre className="font-mono text-xs leading-relaxed text-zinc-200 select-all">
            <code>{activeCode}</code>
          </pre>
        </div>
      </div>
    </div>
  );
};
