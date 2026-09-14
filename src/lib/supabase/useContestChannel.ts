"use client";

import { useCallback, useEffect, useRef } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./client";

// This app has no realtime infrastructure anywhere else — everything else
// refetches after a mutation. Contests are the one place that actually
// needs live cross-client updates (join list, opponent's move reveal), so
// this is scoped narrowly to just that: a broadcast-only channel per
// contest that nudges every subscribed client to refetch full state via
// get_contest. Broadcast delivery is best-effort, so a slow poll runs
// alongside it as a backstop.
const POLL_INTERVAL_MS = 5000;

export function useContestChannel(contestId: string | null, onUpdate: () => void): { nudge: () => void } {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  });

  useEffect(() => {
    if (!contestId) return;

    const channel = supabase
      .channel(`contest:${contestId}`)
      .on("broadcast", { event: "update" }, () => onUpdateRef.current())
      .subscribe();
    channelRef.current = channel;

    const interval = setInterval(() => onUpdateRef.current(), POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [contestId]);

  const nudge = useCallback(() => {
    channelRef.current?.send({ type: "broadcast", event: "update", payload: {} });
  }, []);

  return { nudge };
}
