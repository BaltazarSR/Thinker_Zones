"use client";

import { useRef, useState } from "react";
import { uploadAvatar } from "@/lib/supabase/mutations";
import type { Player } from "@/lib/types";
import Avatar from "./Avatar";

interface ProfilePictureScreenProps {
  player: Player;
  onDone: () => void;
}

export default function ProfilePictureScreen({ player, onDone }: ProfilePictureScreenProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
  };

  const handleContinue = async () => {
    if (!file || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await uploadAvatar(file);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't upload that photo.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6 text-center"
      style={{ background: "var(--background, #000)" }}
    >
      <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
        Add a profile picture
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--text-tertiary)" }}>
        You can skip this and add one later.
      </p>

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="mt-8 flex h-40 w-40 items-center justify-center overflow-hidden rounded-full border-2 border-dashed active:opacity-80"
        style={{ borderColor: "var(--border-input)", background: "var(--surface-2)" }}
        aria-label="Choose a profile picture"
      >
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="Profile preview" className="h-full w-full object-cover" />
        ) : (
          <Avatar player={player} size={160} />
        )}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="user"
        onChange={handleFileChange}
        className="hidden"
      />

      {error && (
        <p className="mt-4 text-sm font-medium" style={{ color: "#ff6a6a" }}>
          {error}
        </p>
      )}

      <div className="mt-10 flex w-full flex-col gap-3">
        <button
          type="button"
          disabled={!file || submitting}
          onClick={handleContinue}
          className="h-16 w-full rounded-2xl text-lg font-bold uppercase tracking-wide transition-colors duration-150 disabled:opacity-40 active:opacity-80"
          style={{ background: "#ffffff", color: "#0a0a0a" }}
        >
          {submitting ? "Uploading…" : "Save & Continue"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={submitting}
          className="h-12 text-sm font-semibold disabled:opacity-40"
          style={{ color: "var(--text-secondary)" }}
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
