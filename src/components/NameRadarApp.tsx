"use client";

import { useMemo, useState } from "react";
import type { QlooCallRecord } from "@/lib/qloo/types";
import type { AudienceInput, CollisionDetail, NameScan, RunRequest, ScoredNamesake, Verdict } from "@/lib/radar/types";
import { AudienceEditor } from "./AudienceEditor";
import { PRESETS, type Preset } from "./presets";
import { BAND_COLOR, Radar } from "./Radar";
import { SafeMarkdown } from "./SafeMarkdown";
import { useRadarRun, type RunState } from "./useRadarRun";

const DOMAIN_LABEL: Record<string, string> = {
  "urn:entity:artist": "Music",
  "urn:entity:brand": "Brand",
  "urn:entity:movie": "Film",
  "urn:entity:tv_show": "TV",
  "urn:entity:book": "Book",
  "urn:entity:podcast": "Podcast",
  "urn:entity:place": "Place",
  "urn:entity:destination": "Destination",
  "urn:entity:person": "Person",
  "urn:entity:videogame": "Game",
  "urn:entity:video_game": "Game",
};
const DOMAIN_WEIGHT: Record<string, number> = {
  "urn:entity:brand": 1,
  "urn:entity:place": 0.85,
  "urn:entity:artist": 0.75,
  "urn:entity:podcast": 0.7,
  "urn:entity:tv_show": 0.7,
  "urn:entity:movie": 0.7,
  "urn:entity:videogame": 0.7,
  "urn:entity:video_game": 0.7,
  "urn:entity:person": 0.6,
  "urn:entity:book": 0.55,
  "urn:entity:destination": 0.4,
};
const MATCH_LABEL: Record<string, string> = {
  exact: "Exact name",
  contains_word: "Shares a word",
  inside_word: "Embedded",
  near_spelling: "Near-spelling",
};
const VERDICT_TEXT: Record<Verdict, string> = {
  red: "Taken for this audience",
  amber: "Crowded",
  green: "Clear for this audience",
};

function VerdictBadge({ v, small }: { v: Verdict; small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium ${small ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"}`}
      style={{ borderColor: BAND_COLOR[v], color: BAND_COLOR[v], background: "rgba(0,0,0,0.25)" }}
    >
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: BAND_COLOR[v] }} />
      {v.toUpperCase()} · {VERDICT_TEXT[v]}
    </span>
  );
}

function Bar({ value, color = "var(--blue)", label }: { value: number | null | undefined; color?: string; label: string }) {
  const v = value === null || value === undefined ? null : Math.max(0, Math.min(1, value));
  return (
    <div className="flex items-center gap-2" title={`${label}: ${v === null ? "n/a" : v.toFixed(2)}`}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-line" aria-hidden>
        {v !== null && <div className="h-full rounded-full" style={{ width: `${v * 100}%`, background: color }} />}
      </div>
      <span className="w-9 text-right font-mono text-[11px] text-ink-2">{v === null ? "n/a" : v.toFixed(2)}</span>
    </div>
  );
}

function blankAudience(): AudienceInput {
  return { label: "My customers", anchors: [] };
}

export default function NameRadarApp() {
  const primary = useRadarRun();
  const contrast = useRadarRun();
  const [category, setCategory] = useState("");
  const [brief, setBrief] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [nameDraft, setNameDraft] = useState("");
  const [audience, setAudience] = useState<AudienceInput>(blankAudience());
  const [contrastAudience, setContrastAudience] = useState<AudienceInput>(blankAudience());
  const [useAgent, setUseAgent] = useState(true);
  const [view, setView] = useState<"A" | "B">("A");
  const [selected, setSelected] = useState<{ scan: string; n: ScoredNamesake } | null>(null);
  const [details, setDetails] = useState<Record<string, CollisionDetail>>({});
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [extraCalls, setExtraCalls] = useState<QlooCallRecord[]>([]);
  const [baselines, setBaselines] = useState<Record<string, BaselineView | "loading" | { error: string }>>({});
  const [showCalls, setShowCalls] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadPreset = (p: Preset) => {
    setCategory(p.category);
    setBrief(p.brief ?? "");
    setNames(p.names);
    setAudience(p.audience);
    setContrastAudience(p.contrast);
    setView("A");
    setSelected(null);
    primary.reset();
    contrast.reset();
    setBaselines({});
    setDetails({});
    setExtraCalls([]);
  };

  const addName = (raw: string) => {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    setNames((cur) => [...cur, ...parts.filter((p) => !cur.some((c) => c.toLowerCase() === p.toLowerCase()))].slice(0, 5));
    setNameDraft("");
  };

  const submit = () => {
    const pending = nameDraft.trim() ? [...names, nameDraft.trim()].slice(0, 5) : names;
    if (nameDraft.trim()) addName(nameDraft);
    if (!pending.length) return setFormError("Add at least one name idea.");
    if (category.trim().length < 2) return setFormError("Say what you're launching.");
    if (!audience.anchors.length) return setFormError("Add at least one thing your customers love.");
    setFormError(null);
    setView("A");
    setSelected(null);
    contrast.reset();
    setBaselines({});
    const req: RunRequest = {
      names: pending,
      category: category.trim(),
      brief: brief.trim() || undefined,
      audience,
      mode: useAgent ? "agent" : "scan",
      targetClean: 3,
    };
    primary.run(req);
  };

  const runContrast = () => {
    if (!contrastAudience.anchors.length) return;
    const all = primary.state.scans.map((s) => s.name);
    const shortlisted = primary.state.report?.shortlist.map((s) => s.name) ?? [];
    const ordered = [...new Set([...names, ...shortlisted, ...all])].slice(0, 5);
    setView("B");
    contrast.run({
      names: ordered,
      category: category.trim() || "a new brand",
      audience: contrastAudience,
      mode: "scan",
      targetClean: 1,
    });
  };

  const active: RunState = view === "B" && (contrast.state.running || contrast.state.scans.length) ? contrast.state : primary.state;
  const otherScans = view === "B" ? primary.state.scans : contrast.state.scans;
  const activeAudience = view === "B" ? contrastAudience : audience;

  const orderedScans = useMemo(() => {
    const order = new Map<string, number>();
    names.forEach((n, i) => order.set(n.toLowerCase(), i));
    return [...active.scans].sort((a, b) => (order.get(a.name.toLowerCase()) ?? 99) - (order.get(b.name.toLowerCase()) ?? 99));
  }, [active.scans, names]);

  const inspect = async (n: ScoredNamesake) => {
    if (details[n.id] || primary.state.details[n.id]) return;
    setInspecting(n.id);
    try {
      const res = await fetch("/api/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: { id: n.id, name: n.name, type: n.type }, audience: activeAudience }),
      });
      const body = (await res.json()) as { detail?: CollisionDetail; calls?: QlooCallRecord[] };
      if (body.detail) setDetails((d) => ({ ...d, [n.id]: body.detail! }));
      if (body.calls) setExtraCalls((c) => [...c, ...body.calls!]);
    } finally {
      setInspecting(null);
    }
  };

  const runBaseline = async (name: string) => {
    setBaselines((b) => ({ ...b, [name]: "loading" }));
    try {
      const res = await fetch("/api/baseline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, category: category || "a new brand", audienceLabel: activeAudience.label, anchors: activeAudience.anchors }),
      });
      const body = await res.json();
      setBaselines((b) => ({ ...b, [name]: res.ok ? (body as BaselineView) : { error: (body as { error?: string }).error ?? "Failed" } }));
    } catch {
      setBaselines((b) => ({ ...b, [name]: { error: "Failed" } }));
    }
  };

  const allCalls = [...primary.state.calls, ...contrast.state.calls, ...extraCalls];
  const detail = selected ? details[selected.n.id] ?? primary.state.details[selected.n.id] : undefined;
  const collisionPanel = selected ? (
    <CollisionPanel
      n={selected.n}
      scanName={selected.scan}
      detail={detail}
      loading={inspecting === selected.n.id}
      onClose={() => setSelected(null)}
    />
  ) : null;
  const originOf = (name: string): "user" | "agent" =>
    primary.state.scanOrigins[name] ?? (names.some((n) => n.toLowerCase() === name.toLowerCase()) ? "user" : "agent");
  const renderCard = (scan: NameScan, compact: boolean) => {
    const other = otherScans.find((o) => o.name.toLowerCase() === scan.name.toLowerCase());
    return (
      <NameCard
        key={scan.name}
        scan={scan}
        compact={compact}
        origin={originOf(scan.name)}
        other={other}
        otherLabel={view === "A" ? contrastAudience.label : audience.label}
        selectedId={selected?.scan === scan.name ? selected.n.id : undefined}
        onSelect={(n) => {
          setSelected({ scan: scan.name, n });
          inspect(n);
        }}
        baseline={baselines[scan.name]}
        onBaseline={() => runBaseline(scan.name)}
      />
    );
  };
  const started = primary.state.running || primary.state.scans.length > 0 || !!primary.state.error;

  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between py-5">
        <div className="flex items-center gap-2.5">
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
            <circle cx="13" cy="13" r="12" fill="none" stroke="var(--line-2)" />
            <circle cx="13" cy="13" r="7" fill="none" stroke="var(--line-2)" />
            <path d="M13 13 L25 13 A12 12 0 0 0 21.5 4.5 Z" fill="var(--accent)" opacity="0.5" />
            <circle cx="17.5" cy="9" r="2" fill="var(--red)" />
          </svg>
          <span className="text-[17px] font-semibold tracking-tight">NameRadar</span>
          <span className="ml-2 hidden rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-3 sm:inline">powered by Qloo taste AI</span>
        </div>
        <nav className="flex items-center gap-4 text-sm text-ink-2">
          <a href="#how" className="hover:text-ink">How it works</a>
          <a href="https://github.com/maestrosatyam/NameRadar" className="hover:text-ink" target="_blank" rel="noreferrer">
            Source
          </a>
        </nav>
      </header>

      <section className="pb-8 pt-6 sm:pt-10">
        <h1 className="max-w-4xl font-serif text-4xl leading-[1.05] tracking-tight sm:text-6xl">
          Is your brand name already taken <em className="text-accent">in your customers&apos; heads?</em>
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-2">
          Trademark search tells you who registered a word. NameRadar tells you who <em>owns it culturally</em>: the band, film, show,
          game, podcast or brand that <strong className="text-ink">your</strong> audience already loves. Then its agent finds you a name
          that&apos;s clear.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-ink-3">Try:</span>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => loadPreset(p)}
              className="rounded-full border border-line bg-panel px-3 py-1.5 text-sm text-ink-2 transition hover:border-accent hover:text-ink"
            >
              {p.title}
            </button>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[400px_1fr]">
        {/* ---------------- Input panel ---------------- */}
        <form
          className="h-fit space-y-5 rounded-2xl border border-line bg-panel p-5 lg:sticky lg:top-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div>
            <h2 className="text-sm font-semibold text-ink">1 · What are you launching?</h2>
            <input
              className="mt-2 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent"
              placeholder="e.g. a sparkling energy drink"
              value={category}
              maxLength={120}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="What are you launching"
            />
            <textarea
              className="mt-2 w-full resize-none rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent"
              rows={2}
              placeholder="Optional notes for the agent (tone, channels, must-avoid words)"
              value={brief}
              maxLength={400}
              onChange={(e) => setBrief(e.target.value)}
              aria-label="Notes for the agent"
            />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold text-ink">2 · Who is it for?</h2>
            <AudienceEditor value={audience} onChange={setAudience} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-ink">3 · Name ideas</h2>
            <div className="mt-2 flex flex-wrap gap-1.5 rounded-lg border border-line bg-panel-2 p-2 focus-within:border-accent">
              {names.map((n) => (
                <span key={n} className="inline-flex items-center gap-1 rounded-md bg-line px-2 py-1 text-sm">
                  {n}
                  <button type="button" aria-label={`Remove ${n}`} className="text-ink-3 hover:text-ink" onClick={() => setNames(names.filter((x) => x !== n))}>
                    ×
                  </button>
                </span>
              ))}
              {names.length < 5 && (
                <input
                  aria-label="Add a name idea"
                  className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-ink-3"
                  placeholder={names.length ? "Add another…" : "Type a name, press Enter"}
                  value={nameDraft}
                  maxLength={40}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addName(nameDraft);
                    }
                  }}
                />
              )}
            </div>
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={useAgent} onChange={(e) => setUseAgent(e.target.checked)} />
            <span>
              <span className="text-ink">Let the agent find clean alternatives</span>
              <span className="block text-xs text-ink-3">It proposes new names and screens each one against Qloo before recommending it.</span>
            </span>
          </label>
          {formError && (
            <p role="alert" className="text-sm text-hot">
              {formError}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={primary.state.running}
              className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-black transition hover:brightness-110 disabled:opacity-60"
            >
              {primary.state.running ? "Scanning…" : "Scan names"}
            </button>
            {primary.state.running && (
              <button type="button" onClick={primary.cancel} className="rounded-lg border border-line px-3 text-sm text-ink-2 hover:text-ink">
                Stop
              </button>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-ink-3">
            Cultural pre-screen, not legal advice. Qloo affinities describe aggregate taste, not any individual. Nothing you type is stored.
          </p>
        </form>

        {/* ---------------- Results ---------------- */}
        <main className="min-w-0 space-y-5" aria-live="polite">
          {!started && <HowItWorks />}

          {started && (
            <>
              <AudienceStrip state={primary.state} contrastState={contrast.state} view={view} setView={setView} />

              {primary.state.error && view === "A" && (
                <div role="alert" className="rounded-xl border border-hot/50 bg-hot/10 p-4 text-sm">
                  <strong className="text-hot">Couldn&apos;t finish: </strong>
                  {primary.state.error.message}
                </div>
              )}

              <div className="space-y-4">
                {orderedScans
                  .filter((scan) => originOf(scan.name) === "user")
                  .map((scan) => (
                    <div key={scan.name} className="space-y-4">
                      {renderCard(scan, false)}
                      {selected?.scan === scan.name && collisionPanel}
                    </div>
                  ))}
              </div>



              {primary.state.report && view === "A" && <ReportPanel state={primary.state} />}

              {orderedScans.some((scan) => originOf(scan.name) === "agent") && (
                <section>
                  <h2 className="mb-2 text-sm font-semibold text-ink-2">Names the agent proposed and screened</h2>
                  <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                    {orderedScans.filter((scan) => originOf(scan.name) === "agent").map((scan) => renderCard(scan, true))}
                  </div>
                  {selected && originOf(selected.scan) === "agent" && <div className="mt-4">{collisionPanel}</div>}
                </section>
              )}
              {active.running && (
                <div className="flex items-center gap-3 rounded-2xl border border-dashed border-line bg-panel/50 px-5 py-3 text-sm text-ink-3">
                  <div className="w-10">
                    <Radar scanning size={60} />
                  </div>
                  Scanning Qloo…
                </div>
              )}

              {primary.state.scans.length > 0 && !primary.state.running && (
                <ContrastPanel
                  value={contrastAudience}
                  onChange={setContrastAudience}
                  onRun={runContrast}
                  running={contrast.state.running}
                  hasResult={contrast.state.scans.length > 0}
                />
              )}

              <Timeline state={active} />

              <section className="rounded-2xl border border-line bg-panel">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-5 py-3 text-left text-sm"
                  aria-expanded={showCalls}
                  onClick={() => setShowCalls((s) => !s)}
                >
                  <span>
                    <span className="font-semibold">Evidence trail</span>
                    <span className="ml-2 text-ink-3">
                      {allCalls.length} Qloo API calls · {allCalls.filter((c) => c.cached).length} served from private cache
                    </span>
                  </span>
                  <span className="text-ink-3">{showCalls ? "Hide" : "Show"}</span>
                </button>
                {showCalls && <CallTable calls={allCalls} />}
              </section>
              {primary.state.stats && (
                <p className="text-right font-mono text-[11px] text-ink-3">
                  run: {(primary.state.stats.ms / 1000).toFixed(1)}s · {primary.state.stats.qlooCalls} Qloo calls · {primary.state.stats.llmCalls} LLM calls
                </p>
              )}
            </>
          )}
        </main>
      </div>
      <footer id="how-footer" className="mt-16 border-t border-line pt-6 text-xs text-ink-3">
        Cultural data from the Qloo Taste AI API (hackathon access). NameRadar is a cultural pre-screen and does not provide legal advice or
        trademark clearance. Open source under the MIT license.
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface BaselineView {
  model: string;
  verdict: Verdict;
  reasoning: string;
  claims: { name: string; domain: string; why: string; foundInQloo: boolean }[];
}

function HowItWorks() {
  const steps = [
    ["Find namesakes", "Qloo /search scans 250M+ cultural entities for anything sharing your name: bands, films, shows, games, podcasts, places, brands."],
    ["Ask your audience", "Qloo Insights scores each namesake's affinity for the people you're selling to, defined by what they already love."],
    ["Fix it", "If the name is taken in their heads, the agent invents alternatives and screens every one against Qloo before recommending it."],
  ];
  return (
    <section id="how" className="grid items-center gap-6 rounded-2xl border border-line bg-panel p-6 md:grid-cols-[1fr_280px]">
      <div>
        <h2 className="font-serif text-2xl">The same name can be clear for one audience and taken for another.</h2>
        <p className="mt-2 text-sm text-ink-2">
          A language model can recall famous collisions. It can&apos;t tell you whether <em>your</em> customers care, so it can&apos;t say whether a name is clear for them.
          That&apos;s what Qloo&apos;s taste graph adds.
        </p>
        <ol className="mt-5 space-y-3">
          {steps.map(([t, d], i) => (
            <li key={t} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-2 font-mono text-xs text-accent">{i + 1}</span>
              <span className="text-sm">
                <span className="font-medium text-ink">{t}.</span> <span className="text-ink-2">{d}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-5 text-sm text-ink-3">Pick a scenario above or fill in the form to start.</p>
      </div>
      <div className="mx-auto w-full max-w-[280px] opacity-90">
        <Radar scanning size={280} />
      </div>
    </section>
  );
}

function AudienceStrip({
  state,
  contrastState,
  view,
  setView,
}: {
  state: RunState;
  contrastState: RunState;
  view: "A" | "B";
  setView: (v: "A" | "B") => void;
}) {
  const hasB = contrastState.running || contrastState.scans.length > 0;
  const aud = view === "B" && hasB ? contrastState.audience : state.audience;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-panel px-5 py-3">
      <div className="min-w-0 text-sm">
        <span className="text-ink-3">Audience in Qloo: </span>
        {aud ? (
          <>
            <span className="font-medium text-ink">{aud.label}</span>
            <span className="text-ink-3"> → </span>
            {aud.anchors.map((a, i) => (
              <span key={a.id} className="text-ink-2">
                {i > 0 && ", "}
                {a.name} <span className="text-[11px] uppercase text-ink-3">{DOMAIN_LABEL[a.type] ?? ""}</span>
              </span>
            ))}
            {aud.ageBuckets?.length ? <span className="text-ink-3"> · age {aud.ageBuckets.join(", ").replace(/_/g, " ")}</span> : null}
            {aud.region ? <span className="text-ink-3"> · {aud.region}</span> : null}
            {aud.unresolved.length > 0 && <span className="text-warm"> · not found in Qloo: {aud.unresolved.join(", ")}</span>}
          </>
        ) : (
          <span className="text-ink-2">resolving…</span>
        )}
      </div>
      {hasB && (
        <div role="tablist" aria-label="Audience" className="flex rounded-lg border border-line p-0.5 text-sm">
          {(["A", "B"] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={view === k}
              onClick={() => setView(k)}
              className={`rounded-md px-3 py-1 ${view === k ? "bg-line text-ink" : "text-ink-3 hover:text-ink"}`}
            >
              {k === "A" ? state.audience?.label ?? "Audience A" : contrastState.audience?.label ?? "Audience B"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NameCard({
  scan,
  compact,
  origin,
  other,
  otherLabel,
  selectedId,
  onSelect,
  baseline,
  onBaseline,
}: {
  scan: NameScan;
  compact?: boolean;
  origin: "user" | "agent";
  other?: NameScan;
  otherLabel: string;
  selectedId?: string;
  onSelect: (n: ScoredNamesake) => void;
  baseline?: BaselineView | "loading" | { error: string };
  onBaseline: () => void;
}) {
  const flipped = other && other.verdict !== scan.verdict;
  if (compact) {
    const top = scan.namesakes[0];
    return (
      <article className="animate-rise rounded-xl border border-line bg-panel p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-serif text-2xl leading-none">{scan.name}</h3>
          <VerdictBadge v={scan.verdict} small />
        </div>
        {flipped && other && (
          <p className="mt-1.5 text-[11px] text-ink-2">
            Flips to <strong style={{ color: BAND_COLOR[other.verdict] }}>{other.verdict.toUpperCase()}</strong> for {otherLabel}
          </p>
        )}
        <div className="mt-2 grid grid-cols-[96px_1fr] items-center gap-3">
          <Radar scan={scan} size={150} selectedId={selectedId} onSelect={onSelect} />
          <div className="min-w-0 text-xs">
            {top ? (
              <button type="button" onClick={() => onSelect(top)} className="w-full text-left">
                <span className="text-ink-3">Hottest namesake</span>
                <span className="mt-0.5 block truncate text-sm text-ink">{top.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-ink-3">{DOMAIN_LABEL[top.type] ?? ""} · heat {top.heat.toFixed(2)}</span>
              </button>
            ) : (
              <span className="text-ink-2">No namesakes in Qloo&apos;s graph.</span>
            )}
            <p className="mt-1 font-mono text-[10px] text-ink-3">{scan.namesakes.length} namesake{scan.namesakes.length === 1 ? "" : "s"}</p>
          </div>
        </div>
      </article>
    );
  }
  return (
    <article className="animate-rise rounded-2xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-serif text-3xl leading-none">{scan.name}</h3>
            {origin === "agent" && <span className="rounded border border-info/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-info">agent idea</span>}
          </div>
          <p className="mt-1 font-mono text-[11px] text-ink-3">heat {scan.heat.toFixed(2)} · searched: {scan.searchedVariants.join(" / ")}</p>
        </div>
        <VerdictBadge v={scan.verdict} />
      </div>
      {flipped && other && (
        <p className="mt-2 rounded-lg border border-line-2 bg-panel-2 px-3 py-1.5 text-xs text-ink-2">
          Verdict flips by audience: <strong style={{ color: BAND_COLOR[other.verdict] }}>{other.verdict.toUpperCase()}</strong> for {otherLabel}.
        </p>
      )}
      <div className="mt-3 grid items-center gap-6 md:grid-cols-[minmax(0,300px)_1fr]">
        <Radar scan={scan} size={300} selectedId={selectedId} onSelect={onSelect} />
        <div className="min-w-0">
          {scan.namesakes.length === 0 ? (
            <p className="text-sm text-ink-2">No namesakes found in Qloo&apos;s graph. Nothing your audience loves already uses this name.</p>
          ) : (
            <ul className="space-y-1.5">
              {scan.namesakes.slice(0, 5).map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(n)}
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-left transition ${selectedId === n.id ? "border-ink-3 bg-panel-2" : "border-transparent hover:border-line"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm">
                        <span aria-hidden className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: BAND_COLOR[n.band] }} />
                        {n.name}
                      </span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-3">{DOMAIN_LABEL[n.type] ?? ""}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[10px] text-ink-3">
                      <span className="flex items-center gap-1.5">
                        <span className="w-14">audience</span>
                        <Bar value={n.audienceAffinity} color="var(--accent)" label="Audience affinity" />
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-14">popularity</span>
                        <Bar value={n.popularity} color="var(--ink-3)" label="Popularity" />
                      </span>
                      <span className="font-mono">{MATCH_LABEL[n.matchKind]}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {scan.notes.length > 0 && <p className="mt-2 text-[11px] text-ink-3">{scan.notes.join(" ")}</p>}
        </div>
      </div>
      <div className="mt-4 border-t border-line pt-3">
        {baseline === undefined && (
          <button type="button" onClick={onBaseline} className="text-xs text-ink-2 underline decoration-line-2 underline-offset-4 hover:text-ink">
            Compare: what does an LLM alone say about “{scan.name}”?
          </button>
        )}
        {baseline === "loading" && <p className="text-xs text-ink-3">Asking the same model without Qloo…</p>}
        {baseline && baseline !== "loading" && "error" in baseline && <p className="text-xs text-hot">{baseline.error}</p>}
        {baseline && baseline !== "loading" && "verdict" in baseline && (
          <div className="text-xs">
            <div className="flex items-center gap-2">
              <span className="text-ink-3">LLM-only ({baseline.model}, no Qloo):</span>
              <VerdictBadge v={baseline.verdict} small />
            </div>
            <ul className="mt-1.5 space-y-0.5">
              {baseline.claims.map((c) => (
                <li key={c.name} className="text-ink-2">
                  {c.foundInQloo ? (
                    <span className="text-cool" title="An entity with this exact name exists in Qloo">✓</span>
                  ) : (
                    <span className="text-warm" title="No exact match in Qloo: unverifiable or hallucinated">?</span>
                  )}{" "}
                  {c.name} <span className="text-ink-3">({c.domain})</span>
                </li>
              ))}
              {baseline.claims.length === 0 && <li className="text-ink-3">No namesakes claimed.</li>}
            </ul>
            <p className="mt-1 text-[11px] text-ink-3">
              The LLM gives one verdict regardless of audience, and its claims can&apos;t be measured. ✓ = exists in Qloo, ? = not found.
            </p>
          </div>
        )}
      </div>
    </article>
  );
}

function CollisionPanel({
  n,
  scanName,
  detail,
  loading,
  onClose,
}: {
  n: ScoredNamesake;
  scanName: string;
  detail?: CollisionDetail;
  loading: boolean;
  onClose: () => void;
}) {
  const w = DOMAIN_WEIGHT[n.type] ?? 0.5;
  const a = n.audienceAffinity ?? 0;
  const p = n.popularity ?? 0;
  return (
    <section className="animate-rise rounded-2xl border border-line-2 bg-panel p-5" aria-label={`Details for ${n.name}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3">
            Collision with “{scanName}” · {DOMAIN_LABEL[n.type] ?? n.type}
          </p>
          <h3 className="mt-1 text-xl font-semibold">{n.name}</h3>
          {n.disambiguation && <p className="text-sm text-ink-3">{n.disambiguation}</p>}
        </div>
        <button type="button" onClick={onClose} className="rounded-md border border-line px-2 py-1 text-xs text-ink-2 hover:text-ink">
          Close
        </button>
      </div>
      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Why it scores {n.heat.toFixed(2)}</h4>
          <dl className="mt-2 space-y-1.5 text-sm">
            <Row k="Name match" v={`${MATCH_LABEL[n.matchKind]} (${n.similarity.toFixed(2)})`} src="NameRadar string match on Qloo /search results" />
            <Row k="Audience affinity" v={n.audienceAffinity === null ? "n/a" : a.toFixed(3)} src="Qloo /v2/insights · filter.results.entities" />
            <Row k="Popularity" v={n.popularity === undefined ? "n/a" : p.toFixed(3)} src="Qloo entity popularity" />
            <Row k="Domain weight" v={w.toFixed(2)} src="NameRadar prior: how directly this domain competes with a brand" />
          </dl>
          <p className="mt-3 rounded-lg bg-panel-2 px-3 py-2 font-mono text-[11px] text-ink-2">
            heat = match × domain × (0.7·affinity + 0.3·popularity)
            <br />= {n.similarity.toFixed(2)} × {w.toFixed(2)} × (0.7·{a.toFixed(2)} + 0.3·{p.toFixed(2)}) = {n.heat.toFixed(3)}
          </p>
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-3">What it means to its fans (Qloo)</h4>
          {loading && <p className="mt-2 text-sm text-ink-3">Asking Qloo…</p>}
          {detail && (
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.tags.slice(0, 12).map((t) => (
                  <span key={t.id} className="rounded-md border border-line px-2 py-0.5 text-xs text-ink-2">
                    {t.name}
                  </span>
                ))}
                {detail.tags.length === 0 && <span className="text-sm text-ink-3">No taste tags returned.</span>}
              </div>
              {detail.demographics && <DemoCompare fans={detail.demographics.age} audience={detail.audienceDemographics?.age} />}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Row({ k, v, src }: { k: string; v: string; src: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 pb-1">
      <dt className="text-ink-2" title={src}>
        {k}
      </dt>
      <dd className="font-mono text-ink">{v}</dd>
    </div>
  );
}

function DemoCompare({ fans, audience }: { fans: Record<string, number>; audience?: Record<string, number> }) {
  const keys = Object.keys(fans);
  if (!keys.length) return null;
  return (
    <div className="mt-4">
      <p className="text-xs text-ink-3">Age affinity: namesake fans vs your audience (Qloo demographics)</p>
      <div className="mt-2 space-y-1">
        {keys.map((k) => (
          <div key={k} className="grid grid-cols-[90px_1fr] items-center gap-2 text-[11px] text-ink-3">
            <span>{k.replace(/_/g, " ")}</span>
            <div className="space-y-0.5">
              <Bar value={(fans[k] + 1) / 2} color="var(--red)" label="Namesake fans" />
              {audience && audience[k] !== undefined && <Bar value={(audience[k] + 1) / 2} color="var(--accent)" label="Your audience" />}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[10px] text-ink-3">Red: namesake fans · Green: your audience. Scaled from Qloo&apos;s −1…1 affinity.</p>
    </div>
  );
}

function ReportPanel({ state }: { state: RunState }) {
  const r = state.report!;
  const download = () => {
    const md = [
      `# NameRadar naming memo`,
      ``,
      `Audience: ${state.audience?.label} (${state.audience?.anchors.map((a) => a.name).join(", ")})`,
      ``,
      `## Shortlist`,
      ...r.shortlist.map((s) => `- **${s.name}** (${s.verdict.toUpperCase()}): ${s.rationale}`),
      ``,
      `## Memo`,
      r.memo,
      ``,
      `## Questions for a trademark attorney`,
      ...r.attorneyQuestions.map((q) => `- ${q}`),
      ``,
      `_Cultural pre-screen based on Qloo taste data; not legal advice or trademark clearance._`,
    ].join("\n");
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "nameradar-memo.md";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="animate-rise rounded-2xl border border-accent/40 bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-serif text-2xl">Agent recommendation</h2>
        <div className="flex items-center gap-2">
          <span className="rounded border border-line px-2 py-0.5 text-[11px] text-ink-3">
            planner: {r.planner === "llm-agent" ? "Claude + Qloo tools" : "deterministic (no LLM)"}
          </span>
          <button type="button" onClick={download} className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-2 hover:text-ink">
            Download memo
          </button>
        </div>
      </div>
      <ol className="mt-4 grid gap-3 md:grid-cols-3">
        {r.shortlist.map((s, i) => (
          <li key={s.name} className="rounded-xl border border-line bg-panel-2 p-3">
            <div className="flex items-center justify-between">
              <span className="font-serif text-2xl">
                <span className="mr-1 font-mono text-xs text-ink-3">{i + 1}</span>
                {s.name}
              </span>
              <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: BAND_COLOR[s.verdict], border: `1px solid ${BAND_COLOR[s.verdict]}` }}>
                {s.verdict.toUpperCase()}
              </span>
            </div>
            <p className="mt-2 text-sm text-ink-2">{s.rationale}</p>
            {s.evidenceIds.length > 0 && <p className="mt-1 font-mono text-[10px] text-ink-3">evidence: {s.evidenceIds.map((e) => e.slice(0, 8)).join(", ")}</p>}
          </li>
        ))}
      </ol>
      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_300px]">
        <div className="text-sm leading-relaxed text-ink-2">
          <SafeMarkdown text={r.memo} />
        </div>
        <div className="rounded-xl border border-line p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Ask a trademark attorney</h3>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-ink-2">
            {r.attorneyQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function ContrastPanel({
  value,
  onChange,
  onRun,
  running,
  hasResult,
}: {
  value: AudienceInput;
  onChange: (v: AudienceInput) => void;
  onRun: () => void;
  running: boolean;
  hasResult: boolean;
}) {
  return (
    <section className="rounded-2xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Flip the audience</h2>
          <p className="text-xs text-ink-3">Re-score the same names for a different audience. Same namesakes; different verdicts if the audiences care differently.</p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={running || !value.anchors.length}
          className="rounded-lg border border-accent px-3 py-1.5 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
        >
          {running ? "Re-scoring…" : hasResult ? "Re-score again" : "Re-score for this audience"}
        </button>
      </div>
      <div className="mt-3">
        <AudienceEditor value={value} onChange={onChange} compact />
      </div>
    </section>
  );
}

function Timeline({ state }: { state: RunState }) {
  if (!state.timeline.length) return null;
  const color: Record<string, string> = { status: "var(--ink-3)", thought: "var(--blue)", tool: "var(--accent)", scan: "var(--ink-2)", error: "var(--red)" };
  const label: Record<string, string> = { status: "step", thought: "agent", tool: "tool", scan: "result", error: "error" };
  return (
    <section className="rounded-2xl border border-line bg-panel p-5">
      <h2 className="text-sm font-semibold">Agent activity</h2>
      <ol className="scrollbar-thin mt-3 max-h-72 space-y-1.5 overflow-y-auto pr-2">
        {state.timeline.map((t) => (
          <li key={t.id} className="grid grid-cols-[52px_1fr] gap-2 text-[13px]">
            <span className="pt-0.5 font-mono text-[10px] uppercase" style={{ color: color[t.kind] }}>
              {label[t.kind]}
            </span>
            <span className={t.kind === "tool" ? "font-mono text-[12px] text-ink" : "text-ink-2"}>{t.text}</span>
          </li>
        ))}
        {state.running && (
          <li className="grid grid-cols-[52px_1fr] gap-2 text-[13px]">
            <span />
            <span className="animate-pulse text-ink-3">working…</span>
          </li>
        )}
      </ol>
    </section>
  );
}

function CallTable({ calls }: { calls: QlooCallRecord[] }) {
  return (
    <div className="scrollbar-thin max-h-96 overflow-auto border-t border-line">
      <table className="w-full text-left text-[11.5px]">
        <thead className="sticky top-0 bg-panel text-ink-3">
          <tr>
            <th className="px-4 py-2 font-medium">Endpoint</th>
            <th className="px-2 py-2 font-medium">Parameters (key never shown)</th>
            <th className="px-2 py-2 font-medium">Status</th>
            <th className="px-2 py-2 font-medium">Results</th>
            <th className="px-2 py-2 font-medium">ms</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c, i) => (
            <tr key={`${c.id}-${i}`} className="border-t border-line/60 align-top">
              <td className="px-4 py-1.5 font-mono text-ink">GET {c.path}</td>
              <td className="max-w-[520px] px-2 py-1.5 font-mono text-ink-2">
                {Object.entries(c.params)
                  .map(([k, v]) => `${k}=${v.length > 80 ? v.slice(0, 80) + "…" : v}`)
                  .join("  ")}
              </td>
              <td className="px-2 py-1.5 font-mono" style={{ color: c.ok ? "var(--green)" : "var(--red)" }}>
                {String(c.status)}
                {c.cached ? " (cache)" : ""}
              </td>
              <td className="px-2 py-1.5 font-mono text-ink-2">{c.resultCount}</td>
              <td className="px-2 py-1.5 font-mono text-ink-3">{c.latencyMs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
