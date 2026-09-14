"use client";

interface CursedModalProps {
  message: string;
  onDismiss: () => void;
}

// The server's rejection messages all start with "You are cursed and..." —
// redundant once the title already says "You're Cursed", so this trims that
// lead-in down to just the specific thing that's blocked.
function bodyText(message: string): string {
  const stripped = message.replace(/^you are cursed and /i, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

// A dedicated popup for "you can't do that, you're cursed" rejections —
// deliberately not a native window.alert() and not an inline error line
// sitting on top of whatever button was tapped, so it reads as a real game
// event instead of a form validation quibble.
export default function CursedModal({ message, onDismiss }: CursedModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-3xl border p-6 text-center"
        style={{ background: "#141414", borderColor: "rgba(139,92,246,0.5)" }}
      >
        <h2 className="text-xl font-extrabold uppercase tracking-wide" style={{ color: "var(--text-primary, #fff)" }}>
          You&apos;re Cursed
        </h2>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          {bodyText(message)}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-5 h-12 w-full rounded-2xl text-sm font-bold uppercase tracking-wide active:opacity-80"
          style={{ background: "rgba(139,92,246,0.9)", color: "#fff" }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
