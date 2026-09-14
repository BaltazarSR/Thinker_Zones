import type { Player, Zone } from "./types";

export function playerById(players: Player[], id: string | null): Player | null {
  if (!id) return null;
  return players.find((p) => p.id === id) ?? null;
}

export function zonesHeldCount(playerId: string, zones: Zone[]): number {
  return zones.filter((z) => z.ownerId === playerId).length;
}

export function homeZonesRuledCount(playerId: string, zones: Zone[]): number {
  return zones.filter((z) => z.tier === "home" && z.ownerId === playerId).length;
}

// The Crown badge is reserved for players ruling more than one home zone —
// a single home zone isn't rare enough to earn the flex.
export function isHomeRuler(playerId: string, zones: Zone[]): boolean {
  return homeZonesRuledCount(playerId, zones) > 1;
}
