"use client";

import { useCallback, useEffect, useState } from "react";
import { whoAmI } from "@/lib/supabase/queries";
import AuthScreen from "@/components/AuthScreen";
import ProfilePictureScreen from "@/components/ProfilePictureScreen";
import AppShell from "@/components/AppShell";
import type { Player } from "@/lib/types";

export default function Home() {
  // undefined = still checking for a session; null = confirmed logged out.
  const [player, setPlayer] = useState<Player | null | undefined>(undefined);
  const [justSignedUp, setJustSignedUp] = useState(false);

  const refresh = useCallback(() => {
    whoAmI()
      .then(setPlayer)
      .catch(() => setPlayer(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (player === undefined || (justSignedUp && !player)) {
    return (
      <div
        className="fixed inset-0 flex items-center justify-center"
        style={{ background: "var(--background, #000)" }}
      >
        <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
          Loading…
        </p>
      </div>
    );
  }

  if (!player) {
    return (
      <AuthScreen
        onSignUpSuccess={() => {
          setJustSignedUp(true);
          refresh();
        }}
        onLogInSuccess={refresh}
      />
    );
  }

  if (justSignedUp) {
    return <ProfilePictureScreen player={player} onDone={() => setJustSignedUp(false)} />;
  }

  return <AppShell key={player.id} userId={player.id} onLoggedOut={refresh} />;
}
