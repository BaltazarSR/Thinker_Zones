"use client";

import { useCallback, useEffect, useRef } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./client";

// Mirrors useContestChannel exactly, scoped to a mutiny instead of a
// contest — without this, a Mutiny screen just sits on whatever state it
// last fetched until the viewer takes some action of their own (submitting
// a move, closing and reopening), since nothing else was ever refetching it.
const POLL_INTERVAL_MS = 5000;

export function useMutinyChannel(mutinyId: string | null, onUpdate: () => void): { nudge: () => void } {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  });

  useEffect(() => {
    if (!mutinyId) return;

    const channel = supabase
      .channel(`mutiny:${mutinyId}`)
      .on("broadcast", { event: "update" }, () => onUpdateRef.current())
      .subscribe();
    channelRef.current = channel;

    const interval = setInterval(() => onUpdateRef.current(), POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [mutinyId]);

  const nudge = useCallback(() => {
    channelRef.current?.send({ type: "broadcast", event: "update", payload: {} });
  }, []);

  return { nudge };
}
