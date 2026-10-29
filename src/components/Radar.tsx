"use client";

import { useMemo } from "react";
import type { NameScan, ScoredNamesake } from "@/lib/radar/types";

export const DOMAINS = [
  { type: "urn:entity:brand", label: "Brands" },
  { type: "urn:entity:place", label: "Places" },
  { type: "urn:entity:artist", label: "Music" },
  { type: "urn:entity:podcast", label: "Podcasts" },
  { type: "urn:entity:tv_show", label: "TV" },
  { type: "urn:entity:movie", label: "Film" },
  { type: "game", label: "Games" },
  { type: "urn:entity:book", label: "Books" },
  { type: "urn:entity:person", label: "People" },
] as const;

function sectorOf(type: string): number {
  if (type.includes("videogame") || type.includes("video_game")) return 6;
  const i = DOMAINS.findIndex((d) => d.type === type);
  return i >= 0 ? i : 8;
}

export const BAND_COLOR = { red: "var(--red)", amber: "var(--amber)", green: "var(--green)" } as const;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

interface Props {
  scan?: NameScan;
  size?: number;
  scanning?: boolean;
  selectedId?: string;
  onSelect?: (n: ScoredNamesake) => void;
}

export function Radar({ scan, size = 320, scanning, selectedId, onSelect }: Props) {
  const R = size / 2 - 28;
  const c = size / 2;
  const sector = (2 * Math.PI) / DOMAINS.length;

  const blips = useMemo(() => {
    if (!scan) return [];
    return scan.namesakes.map((n) => {
      const s = sectorOf(n.type);
      const jitter = 0.18 + hash(n.id) * 0.64;
      const angle = -Math.PI / 2 + (s + jitter) * sector;
      // Hotter = closer to the centre (your name).
      const dist = R * (0.12 + 0.86 * (1 - Math.min(1, n.heat * 1.15)));
      return {
        n,
        x: c + Math.cos(angle) * dist,
        y: c + Math.sin(angle) * dist,
        r: 3.5 + 7 * Math.max(0, Math.min(1, n.popularity ?? 0.2)),
      };
    });
  }, [scan, R, c, sector]);

  const labelled = new Set(scan?.namesakes.slice(0, 3).map((n) => n.id));

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width="100%"
      role="img"
      aria-label={
        scan
          ? `Radar for ${scan.name}: verdict ${scan.verdict}. ${scan.namesakes.length} namesakes plotted; closer to centre means hotter for this audience.`
          : "Empty radar"
      }
      className="max-w-[420px] select-none"
    >
      <defs>
        <radialGradient id="rg-bg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(255,93,93,0.16)" />
          <stop offset="45%" stopColor="rgba(255,181,71,0.07)" />
          <stop offset="100%" stopColor="rgba(79,209,139,0.02)" />
        </radialGradient>
        <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgba(155,229,100,0)" />
          <stop offset="100%" stopColor="rgba(155,229,100,0.35)" />
        </linearGradient>
      </defs>
      <circle cx={c} cy={c} r={R} fill="url(#rg-bg)" stroke="var(--line-2)" />
      {/* heat bands: red zone (heat >= 0.5) and amber ring (>= 0.25) */}
      <circle cx={c} cy={c} r={R * (0.12 + 0.86 * (1 - 0.5 * 1.15))} fill="none" stroke="rgba(255,93,93,0.45)" strokeDasharray="3 4" />
      <circle cx={c} cy={c} r={R * (0.12 + 0.86 * (1 - 0.25 * 1.15))} fill="none" stroke="rgba(255,181,71,0.35)" strokeDasharray="3 4" />
      {DOMAINS.map((d, i) => {
        const a = -Math.PI / 2 + i * sector;
        const la = a + sector / 2;
        return (
          <g key={d.label}>
            <line x1={c} y1={c} x2={c + Math.cos(a) * R} y2={c + Math.sin(a) * R} stroke="var(--line)" />
            <text
              x={c + Math.cos(la) * (R + 15)}
              y={c + Math.sin(la) * (R + 15)}
              fill="var(--ink-3)"
              fontSize="9.5"
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ letterSpacing: "0.06em", textTransform: "uppercase" }}
            >
              {d.label}
            </text>
          </g>
        );
      })}
      {scanning && (
        <g className="animate-sweep" style={{ transformOrigin: `${c}px ${c}px` }}>
          <path d={`M ${c} ${c} L ${c + R} ${c} A ${R} ${R} 0 0 0 ${c + R * Math.cos(-0.6)} ${c + R * Math.sin(-0.6)} Z`} fill="url(#sweep)" />
        </g>
      )}
      {blips.map(({ n, x, y, r }) => {
        const color = BAND_COLOR[n.band];
        const selected = selectedId === n.id;
        return (
          <g
            key={n.id}
            role="button"
            tabIndex={0}
            aria-label={`${n.name}, ${n.band} heat ${n.heat.toFixed(2)}`}
            onClick={() => onSelect?.(n)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect?.(n)}
            style={{ cursor: onSelect ? "pointer" : "default" }}
          >
            {n.band === "red" && <circle cx={x} cy={y} r={r} fill={color} opacity={0.5} className="blip-ping" />}
            <circle cx={x} cy={y} r={r} fill={color} fillOpacity={0.85} stroke={selected ? "#fff" : "rgba(0,0,0,0.5)"} strokeWidth={selected ? 2 : 1} />
            {labelled.has(n.id) && (
              <text x={x + r + 4} y={y + 3} fontSize="10.5" fill="var(--ink)" style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}>
                {n.name.length > 22 ? n.name.slice(0, 21) + "…" : n.name}
              </text>
            )}
          </g>
        );
      })}
      <circle cx={c} cy={c} r={4} fill="var(--ink)" />
      {scan && (
        <text x={c} y={c - 10} textAnchor="middle" fontSize="11" fill="var(--ink-2)" fontWeight={600}>
          {scan.name}
        </text>
      )}
    </svg>
  );
}
