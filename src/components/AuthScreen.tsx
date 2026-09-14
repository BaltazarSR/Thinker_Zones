"use client";

import { useState } from "react";
import { signIn, signUp } from "@/lib/supabase/mutations";

type Mode = "login" | "signup";

interface AuthScreenProps {
  onSignUpSuccess: () => void;
  onLogInSuccess: () => void;
}

export default function AuthScreen({ onSignUpSuccess, onLogInSuccess }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit =
    name.trim().length > 0 &&
    password.length >= 6 &&
    (mode === "login" || (password === confirmPassword && inviteCode.trim().length > 0));

  const handleSubmit = async () => {
    if (!canSubmit || loading) return;
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await signIn(name.trim(), password);
        onLogInSuccess();
      } else {
        await signUp(name.trim(), password, inviteCode.trim());
        onSignUpSuccess();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    background: "var(--surface-2)",
    borderColor: "var(--border-input)",
    color: "var(--text-primary, #fff)",
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-center overflow-y-auto px-6 py-10"
      style={{ background: "var(--background, #000)" }}
    >
      <h1
        className="text-4xl font-extrabold uppercase italic tracking-wide"
        style={{ color: "var(--text-primary, #fff)" }}
      >
        Thinkers Zones
      </h1>
      <p className="mt-2 text-sm" style={{ color: "var(--text-tertiary)" }}>
        {mode === "login" ? "Log in to keep your turf." : "Pick a name, claim your turf."}
      </p>

      <div className="mt-8 flex flex-col gap-4">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
            Name
          </h3>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Dave"
            autoComplete="username"
            className="mt-2 h-14 w-full rounded-2xl border-2 px-4 text-base outline-none"
            style={inputStyle}
          />
        </div>
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
            Password
          </h3>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 6 characters"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            className="mt-2 h-14 w-full rounded-2xl border-2 px-4 text-base outline-none"
            style={inputStyle}
          />
        </div>
        {mode === "signup" && (
          <>
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
                Confirm password
              </h3>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                className="mt-2 h-14 w-full rounded-2xl border-2 px-4 text-base outline-none"
                style={inputStyle}
              />
            </div>
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
                Invite code
              </h3>
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Ask whoever invited you"
                className="mt-2 h-14 w-full rounded-2xl border-2 px-4 text-base outline-none"
                style={inputStyle}
              />
            </div>
          </>
        )}
      </div>

      {error && (
        <p className="mt-4 text-sm font-medium" style={{ color: "#ff6a6a" }}>
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!canSubmit || loading}
        onClick={handleSubmit}
        className="mt-6 h-16 w-full rounded-2xl text-lg font-bold uppercase tracking-wide transition-colors duration-150 disabled:opacity-40 active:opacity-80"
        style={{ background: "#ffffff", color: "#0a0a0a" }}
      >
        {loading ? "One sec…" : mode === "login" ? "Log In" : "Sign Up"}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode((m) => (m === "login" ? "signup" : "login"));
          setError(null);
        }}
        className="mt-4 text-sm font-semibold"
        style={{ color: "var(--text-secondary)" }}
      >
        {mode === "login" ? "New here? Sign up" : "Already have an account? Log in"}
      </button>
    </div>
  );
}
