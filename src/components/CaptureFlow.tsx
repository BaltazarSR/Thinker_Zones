"use client";

import { useRef, useState } from "react";
import type { Zone } from "@/lib/types";
import { CloseIcon } from "./icons";

interface CaptureFlowProps {
  zone: Zone;
  onClose: () => void;
  onSubmit: (input: {
    placeId: string;
    placeName: string;
    caption: string;
    photoFile: File | null;
    nickname: string;
  }) => void;
  submitting?: boolean;
  error?: string | null;
}

export default function CaptureFlow({ zone, onClose, onSubmit, submitting = false, error = null }: CaptureFlowProps) {
  const [placeId, setPlaceId] = useState<string | null>(zone.places.length === 1 ? zone.places[0].id : null);
  const [caption, setCaption] = useState("");
  const [nickname, setNickname] = useState(zone.nickname ?? "");
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedPlace = zone.places.find((p) => p.id === placeId) ?? null;
  const canSubmit = selectedPlace !== null && photoFile !== null && !submitting;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreviewUrl(URL.createObjectURL(file));
  };

  const handleSubmit = () => {
    if (!selectedPlace || !photoFile || submitting) return;
    onSubmit({
      placeId: selectedPlace.id,
      placeName: selectedPlace.name,
      caption: caption.trim() || "Zone captured.",
      photoFile,
      nickname: nickname.trim(),
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col" style={{ background: "var(--background, #000)" }}>
      <div className="flex items-center justify-between p-5 pb-4">
        <div>
          <h2 className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
            Capture
          </h2>
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            {zone.nickname ?? zone.name}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex h-44 w-full items-center justify-center overflow-hidden rounded-3xl border-2 border-dashed active:opacity-80"
          style={{ borderColor: photoPreviewUrl ? "var(--border-input)" : "#ff5a36" }}
        >
          {photoPreviewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoPreviewUrl} alt="Capture preview" className="h-full w-full object-cover" />
          ) : (
            <span className="text-base" style={{ color: "#ff8a68" }}>
              Tap to take a photo
            </span>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileChange}
          className="hidden"
        />

        <h3
          className="mt-7 text-xs font-bold uppercase tracking-wider"
          style={{ color: "var(--text-tertiary)" }}
        >
          What place?
        </h3>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {zone.places.map((place) => {
            const isSelected = place.id === placeId;
            return (
              <button
                key={place.id}
                type="button"
                onClick={() => setPlaceId(place.id)}
                className="rounded-2xl border-2 px-4 py-4 text-left text-base font-medium transition-colors duration-150 active:opacity-80"
                style={{
                  borderColor: isSelected ? "#ff5a36" : "var(--border-container)",
                  background: isSelected ? "rgba(255,90,54,0.15)" : "var(--surface-1)",
                  color: isSelected ? "#ff8a68" : "var(--text-primary, #fff)",
                }}
              >
                {place.name}
              </button>
            );
          })}
        </div>

        <h3
          className="mt-7 text-xs font-bold uppercase tracking-wider"
          style={{ color: "var(--text-tertiary)" }}
        >
          Zone alias (optional)
        </h3>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder={zone.name}
          className="mt-3 h-14 w-full rounded-2xl border-2 px-4 text-base outline-none"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-input)",
            color: "var(--text-primary, #fff)",
          }}
        />

        <h3
          className="mt-7 text-xs font-bold uppercase tracking-wider"
          style={{ color: "var(--text-tertiary)" }}
        >
          Message
        </h3>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Talk your trash…"
          rows={3}
          className="mt-3 w-full resize-none rounded-2xl border-2 p-4 text-base outline-none"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-input)",
            color: "var(--text-primary, #fff)",
          }}
        />
      </div>

      <div className="p-5 pt-4">
        {error && (
          <p className="mb-3 text-sm font-medium" style={{ color: "#ff6a6a" }}>
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="h-16 w-full rounded-2xl text-lg font-bold uppercase tracking-wide transition-colors duration-150 disabled:opacity-40 active:opacity-80"
          style={{ background: "#ffffff", color: "#0a0a0a" }}
        >
          {submitting ? "Submitting…" : "Submit Capture"}
        </button>
      </div>
    </div>
  );
}
