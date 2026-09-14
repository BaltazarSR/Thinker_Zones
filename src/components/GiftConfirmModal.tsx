"use client";

import type { Player } from "@/lib/types";
import Avatar from "./Avatar";

interface GiftConfirmModalProps {
  zoneName: string;
  recipient: Player;
  onConfirm: () => void;
  onCancel: () => void;
}

// Gifting a zone hands it straight to another player with no undo — this
// stands between the picker row and the actual transfer so a stray tap
// can't give away a zone by accident.
export default function GiftConfirmModal({ zoneName, recipient, onConfirm, onCancel }: GiftConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onCancel}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-3xl border p-6 text-center"
        style={{ background: "#141414", borderColor: "var(--border-container)" }}
      >
        <h2 className="text-xl font-extrabold uppercase tracking-wide" style={{ color: "var(--text-primary, #fff)" }}>
          Gift this Zone?
        </h2>
        <div className="mt-4 flex items-center justify-center gap-3">
          <Avatar player={recipient} size={36} />
          <span className="text-base font-semibold" style={{ color: "var(--text-primary, #fff)" }}>
            {recipient.name}
          </span>
        </div>
        <p className="mt-3 text-sm" style={{ color: "var(--text-secondary)" }}>
          {zoneName} will be transferred to {recipient.name}. This can&apos;t be undone.
        </p>
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="h-12 flex-1 rounded-2xl text-sm font-bold uppercase tracking-wide active:opacity-80"
            style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-12 flex-1 rounded-2xl text-sm font-bold uppercase tracking-wide active:opacity-80"
            style={{ background: "#ffffff", color: "#0a0a0a" }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
