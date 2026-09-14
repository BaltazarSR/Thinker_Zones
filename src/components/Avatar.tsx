import type { Player } from "@/lib/types";

interface AvatarProps {
  player: Player;
  size?: number;
  ring?: boolean;
}

// WCAG-ish relative luminance to pick readable initials color against any
// player's (potentially very light/saturated) hex color.
function textColorFor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.5 ? "#0a0a0a" : "#ffffff";
}

export default function Avatar({ player, size = 44, ring = false }: AvatarProps) {
  const boxShadow = ring ? `0 0 0 3px var(--background, #000), 0 0 0 5px ${player.color}` : undefined;

  if (player.avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={player.avatarUrl}
        alt={player.name}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size, boxShadow }}
      />
    );
  }

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-extrabold"
      style={{
        width: size,
        height: size,
        background: player.color,
        color: textColorFor(player.color),
        fontSize: size * 0.42,
        boxShadow,
      }}
    >
      {player.initials}
    </div>
  );
}
