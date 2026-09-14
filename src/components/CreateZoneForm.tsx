"use client";

import { useState } from "react";
import type { ZoneDraft } from "./MapView";
import ZoneDraftMap from "./ZoneDraftMap";
import { CloseIcon } from "./icons";
import type { Zone } from "@/lib/types";

interface CreateZoneFormProps {
  draft: ZoneDraft;
  existingZone?: Zone | null;
  submitting?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (input: { name: string; nickname: string; placeNames: string[] }) => void;
}

export default function CreateZoneForm({
  draft,
  existingZone = null,
  submitting = false,
  error = null,
  onCancel,
  onSubmit,
}: CreateZoneFormProps) {
  const isEditing = existingZone !== null;
  const [name, setName] = useState(existingZone?.name ?? "");
  const [nickname, setNickname] = useState(existingZone?.nickname ?? "");
  const [placeNames, setPlaceNames] = useState<string[]>(
    draft.places.map((p) => {
      const match = p.id ? existingZone?.places.find((existing) => existing.id === p.id) : null;
      return match?.name ?? "";
    })
  );

  const canSubmit = name.trim().length > 0 && placeNames.every((n) => n.trim().length > 0) && !submitting;

  const handlePlaceNameChange = (index: number, value: string) => {
    setPlaceNames((prev) => prev.map((n, i) => (i === index ? value : n)));
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({ name: name.trim(), nickname: nickname.trim(), placeNames: placeNames.map((n) => n.trim()) });
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col" style={{ background: "var(--background, #000)" }}>
      <div className="flex items-center justify-between p-5 pb-4">
        <div>
          <h2 className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
            {isEditing ? "Edit Zone" : "New Zone"}
          </h2>
          <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
            {draft.places.length} place{draft.places.length === 1 ? "" : "s"} pinned
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5">
        <div
          className="h-56 w-full overflow-hidden rounded-3xl border-2"
          style={{
            borderColor: "#ff5a3666",
            background: "var(--surface-1)",
            // WebGL canvases (MapLibre) are GPU-composited on their own layer and
            // often ignore a parent's overflow:hidden + border-radius clip; clip-path
            // is compositor-level and reliably clips it.
            clipPath: "inset(0 round 22px)",
          }}
        >
          <ZoneDraftMap draft={draft} />
        </div>

        <h3 className="mt-6 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
          Zone name
        </h3>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Parque Morelos"
          className="mt-2 h-14 w-full rounded-2xl border-2 px-4 text-base outline-none"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-input)",
            color: "var(--text-primary, #fff)",
          }}
        />

        <h3 className="mt-6 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
          Nickname (optional)
        </h3>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="e.g. Dave's Turf"
          className="mt-2 h-14 w-full rounded-2xl border-2 px-4 text-base outline-none"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-input)",
            color: "var(--text-primary, #fff)",
          }}
        />

        <h3 className="mt-6 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
          Name each place
        </h3>
        <div className="mt-2 flex flex-col gap-3">
          {draft.places.map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold"
                style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
              >
                {i + 1}
              </span>
              <input
                value={placeNames[i]}
                onChange={(e) => handlePlaceNameChange(i, e.target.value)}
                placeholder={`Place ${i + 1} name`}
                className="h-12 flex-1 rounded-xl border-2 px-3.5 text-base outline-none"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--border-input)",
                  color: "var(--text-primary, #fff)",
                }}
              />
            </div>
          ))}
        </div>
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
          {submitting ? "Saving…" : isEditing ? "Save Zone" : "Create Zone"}
        </button>
      </div>
    </div>
  );
}
