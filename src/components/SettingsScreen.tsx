"use client";

import { useRef, useState } from "react";
import { changePassword, signOut, updateName, uploadAvatar } from "@/lib/supabase/mutations";
import type { Player } from "@/lib/types";
import Avatar from "./Avatar";
import { CloseIcon } from "./icons";

interface SettingsScreenProps {
  player: Player;
  onClose: () => void;
  onLoggedOut: () => void;
  onProfileUpdated: () => void;
}

export default function SettingsScreen({ player, onClose, onLoggedOut, onProfileUpdated }: SettingsScreenProps) {
  const [name, setName] = useState(player.name);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);

  const nameChanged = name.trim().length > 0 && name.trim() !== player.name;
  const canSavePassword =
    currentPassword.length > 0 && newPassword.length >= 6 && newPassword === confirmPassword && !savingPassword;

  const handleSaveName = async () => {
    if (!nameChanged || savingName) return;
    setSavingName(true);
    setNameError(null);
    try {
      await updateName(name.trim());
      onProfileUpdated();
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Couldn't save that name.");
    } finally {
      setSavingName(false);
    }
  };

  const handleSavePassword = async () => {
    if (!canSavePassword) return;
    setSavingPassword(true);
    setPasswordError(null);
    setPasswordSaved(false);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordSaved(true);
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Couldn't change your password.");
    } finally {
      setSavingPassword(false);
    }
  };

  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingPhoto(true);
    setPhotoError(null);
    try {
      await uploadAvatar(file);
      onProfileUpdated();
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Couldn't upload that photo.");
    } finally {
      setUploadingPhoto(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "var(--background, #000)" }}>
      <div className="flex items-center justify-between p-5 pb-4">
        <h2 className="text-2xl font-bold" style={{ color: "var(--text-primary, #fff)" }}>
          Settings
        </h2>
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

      <div className="flex-1 overflow-y-auto px-5 pb-10">
        <div className="flex flex-col items-center pt-3">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingPhoto}
            className="active:opacity-80 disabled:opacity-60"
            aria-label="Change profile picture"
          >
            <Avatar player={player} size={112} ring />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handlePhotoChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingPhoto}
            className="mt-3 text-sm font-semibold disabled:opacity-40"
            style={{ color: "var(--text-secondary)" }}
          >
            {uploadingPhoto ? "Uploading…" : "Change photo"}
          </button>
          {photoError && (
            <p className="mt-2 text-sm font-medium" style={{ color: "#ff6a6a" }}>
              {photoError}
            </p>
          )}
        </div>

        <h3 className="mt-8 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
          Name
        </h3>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-2 h-14 w-full rounded-2xl border-2 px-4 text-base outline-none"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-input)",
            color: "var(--text-primary, #fff)",
          }}
        />
        {nameError && (
          <p className="mt-2 text-sm font-medium" style={{ color: "#ff6a6a" }}>
            {nameError}
          </p>
        )}
        <button
          type="button"
          disabled={!nameChanged || savingName}
          onClick={handleSaveName}
          className="mt-3 h-14 w-full rounded-2xl text-base font-bold uppercase tracking-wide transition-colors duration-150 disabled:opacity-40 active:opacity-80"
          style={{ background: "#ffffff", color: "#0a0a0a" }}
        >
          {savingName ? "Saving…" : "Save Name"}
        </button>

        <h3 className="mt-8 text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
          Password
        </h3>
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => {
            setCurrentPassword(e.target.value);
            setPasswordSaved(false);
          }}
          placeholder="Current password"
          autoComplete="current-password"
          className="mt-2 h-14 w-full rounded-2xl border-2 px-4 text-base outline-none"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-input)",
            color: "var(--text-primary, #fff)",
          }}
        />
        <input
          type="password"
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
            setPasswordSaved(false);
          }}
          placeholder="New password"
          autoComplete="new-password"
          className="mt-3 h-14 w-full rounded-2xl border-2 px-4 text-base outline-none"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-input)",
            color: "var(--text-primary, #fff)",
          }}
        />
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            setPasswordSaved(false);
          }}
          placeholder="Confirm new password"
          autoComplete="new-password"
          className="mt-3 h-14 w-full rounded-2xl border-2 px-4 text-base outline-none"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-input)",
            color: "var(--text-primary, #fff)",
          }}
        />
        {passwordError && (
          <p className="mt-2 text-sm font-medium" style={{ color: "#ff6a6a" }}>
            {passwordError}
          </p>
        )}
        {passwordSaved && (
          <p className="mt-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
            Password updated.
          </p>
        )}
        <button
          type="button"
          disabled={!canSavePassword}
          onClick={handleSavePassword}
          className="mt-3 h-14 w-full rounded-2xl text-base font-bold uppercase tracking-wide transition-colors duration-150 disabled:opacity-40 active:opacity-80"
          style={{ background: "#ffffff", color: "#0a0a0a" }}
        >
          {savingPassword ? "Saving…" : "Save Password"}
        </button>
      </div>

      <div className="p-5 pt-4">
        <button
          type="button"
          onClick={() => signOut().then(onLoggedOut)}
          className="h-14 w-full rounded-2xl text-base font-bold uppercase tracking-wide transition-colors duration-150 active:opacity-80"
          style={{ background: "var(--surface-hover-active)", color: "var(--text-secondary)" }}
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}
