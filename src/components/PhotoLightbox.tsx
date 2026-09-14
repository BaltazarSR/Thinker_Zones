"use client";

import { CloseIcon } from "./icons";

interface PhotoLightboxProps {
  src: string;
  onClose: () => void;
}

export default function PhotoLightbox({ src, onClose }: PhotoLightboxProps) {
  // Nested inside overlays that close themselves on any click (e.g. ZoneDetailSheet) —
  // stop propagation so dismissing the lightbox doesn't also close the sheet behind it.
  const handleBackdropClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-6"
      onClick={handleBackdropClick}
    >
      <button
        type="button"
        onClick={handleBackdropClick}
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full"
        style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
        aria-label="Close"
      >
        <CloseIcon />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Capture"
        className="max-h-full max-w-full rounded-2xl object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
