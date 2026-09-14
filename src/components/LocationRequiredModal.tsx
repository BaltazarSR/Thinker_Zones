"use client";

interface LocationRequiredModalProps {
  message: string;
  onDismiss: () => void;
}

// A dedicated popup for "you're not physically at this zone" rejections —
// mirrors CursedModal so a location gate reads as a real game event instead
// of a form validation quibble.
export default function LocationRequiredModal({ message, onDismiss }: LocationRequiredModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onDismiss}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-3xl border p-6 text-center"
        style={{ background: "#141414", borderColor: "var(--border-container)" }}
      >
        <h2 className="text-xl font-extrabold uppercase tracking-wide" style={{ color: "var(--text-primary, #fff)" }}>
          You&apos;re Not Here
        </h2>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          {message}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-5 h-12 w-full rounded-2xl text-sm font-bold uppercase tracking-wide active:opacity-80"
          style={{ background: "#ffffff", color: "#0a0a0a" }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
