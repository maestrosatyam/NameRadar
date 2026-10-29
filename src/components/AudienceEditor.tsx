"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AGE_BUCKET_VALUES, type AudienceInput } from "@/lib/radar/types";

const AGE_LABEL: Record<string, string> = {
  "24_and_younger": "≤24",
  "25_to_29": "25–29",
  "30_to_34": "30–34",
  "35_to_44": "35–44",
  "45_to_54": "45–54",
  "55_and_older": "55+",
};

interface Suggestion {
  id: string;
  name: string;
  domain: string;
  hint?: string;
}

export function AudienceEditor({
  value,
  onChange,
  compact,
}: {
  value: AudienceInput;
  onChange: (v: AudienceInput) => void;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onDraft = (text: string) => {
    setDraft(text);
    if (timer.current) clearTimeout(timer.current);
    const q = text.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const body = (await res.json()) as { results?: Suggestion[] };
        setSuggestions(body.results ?? []);
        setActive(0);
        setOpen(true);
      } catch {
        setSuggestions([]);
      }
    }, 250);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const addAnchor = (name: string) => {
    const n = name.trim();
    if (!n || value.anchors.length >= 4 || value.anchors.some((a) => a.toLowerCase() === n.toLowerCase())) return;
    onChange({ ...value, anchors: [...value.anchors, n] });
    setDraft("");
    setSuggestions([]);
    setOpen(false);
  };

  const toggleAge = (b: (typeof AGE_BUCKET_VALUES)[number]) => {
    const cur = value.ageBuckets ?? [];
    const next = cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b].slice(-3);
    onChange({ ...value, ageBuckets: next.length ? next : undefined });
  };

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs text-ink-3">Audience name</span>
        <input
          className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent"
          value={value.label}
          maxLength={60}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
        />
      </label>
      <div>
        <span className="text-xs text-ink-3">They already love… (1–4 brands, artists, shows)</span>
        <div className="mt-1 flex flex-wrap gap-1.5 rounded-lg border border-line bg-panel-2 p-2 focus-within:border-accent">
          {value.anchors.map((a) => (
            <span key={a} className="inline-flex items-center gap-1 rounded-md bg-line px-2 py-1 text-xs">
              {a}
              <button
                type="button"
                aria-label={`Remove ${a}`}
                className="text-ink-3 hover:text-ink"
                onClick={() => onChange({ ...value, anchors: value.anchors.filter((x) => x !== a) })}
              >
                ×
              </button>
            </span>
          ))}
          {value.anchors.length < 4 && (
            <div className="relative min-w-[10rem] flex-1">
              <input
                role="combobox"
                aria-expanded={open && suggestions.length > 0}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-label="Add something your audience loves"
                placeholder={value.anchors.length ? "Add another…" : "e.g. Glossier, Kendrick Lamar"}
                className="w-full bg-transparent px-1 py-1 text-sm outline-none placeholder:text-ink-3"
                value={draft}
                maxLength={80}
                onChange={(e) => onDraft(e.target.value)}
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((i) => Math.min(i + 1, suggestions.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    addAnchor(open && suggestions[active] ? suggestions[active].name : draft);
                  } else if (e.key === "Escape") setOpen(false);
                }}
              />
              {open && suggestions.length > 0 && (
                <ul
                  id={listId}
                  role="listbox"
                  className="absolute left-0 top-full z-20 mt-1 w-72 overflow-hidden rounded-lg border border-line-2 bg-panel shadow-xl"
                >
                  {suggestions.map((s, i) => (
                    <li
                      key={s.id}
                      role="option"
                      aria-selected={i === active}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        addAnchor(s.name);
                      }}
                      className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-line" : ""}`}
                    >
                      <span className="text-ink">{s.name}</span>
                      <span className="ml-2 text-[11px] uppercase tracking-wide text-ink-3">{s.domain}</span>
                      {s.hint && <div className="truncate text-xs text-ink-3">{s.hint}</div>}
                    </li>
                  ))}
                  <li className="border-t border-line px-3 py-1 text-[10px] text-ink-3">Suggestions from Qloo search</li>
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
      {!compact && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <fieldset>
            <legend className="text-xs text-ink-3">Age (optional)</legend>
            <div className="mt-1 flex flex-wrap gap-1">
              {AGE_BUCKET_VALUES.map((b) => {
                const on = value.ageBuckets?.includes(b);
                return (
                  <button
                    type="button"
                    key={b}
                    aria-pressed={on}
                    onClick={() => toggleAge(b)}
                    className={`rounded-md border px-2 py-1 text-xs ${on ? "border-accent bg-accent/15 text-ink" : "border-line text-ink-2 hover:border-line-2"}`}
                  >
                    {AGE_LABEL[b]}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label className="block">
            <span className="text-xs text-ink-3">Launch region (optional)</span>
            <input
              className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent"
              placeholder="e.g. United States, London"
              value={value.region ?? ""}
              maxLength={60}
              onChange={(e) => onChange({ ...value, region: e.target.value || undefined })}
            />
          </label>
        </div>
      )}
    </div>
  );
}
