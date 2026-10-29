/**
 * MOCK Qloo server for offline development and CI. NOT real Qloo data.
 *
 * Every entity it returns is synthetic and labelled "MOCK" in its
 * disambiguation. It exists only so the UI, agent loop and E2E tests can run
 * without a hackathon key. Live behaviour is verified separately with
 * scripts/smoke_qloo.ts against https://hackathon.api.qloo.com.
 *
 *   npx tsx scripts/mock_qloo_server.ts   # listens on :4010
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.MOCK_QLOO_PORT ?? 4010);
const TYPES = [
  "urn:entity:brand",
  "urn:entity:artist",
  "urn:entity:movie",
  "urn:entity:tv_show",
  "urn:entity:podcast",
  "urn:entity:place",
  "urn:entity:videogame",
  "urn:entity:book",
];

function h(s: string): number {
  return parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;
}
function uuid(seed: string): string {
  const x = createHash("md5").update(seed).digest("hex").toUpperCase();
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

interface MockEntity {
  entity_id: string;
  name: string;
  types: string[];
  popularity: number;
  disambiguation: string;
}

const registry = new Map<string, MockEntity>();

function entity(name: string, type: string): MockEntity {
  const id = uuid(`${type}:${name}`);
  const e: MockEntity = {
    entity_id: id,
    name,
    types: [type],
    popularity: Number((0.3 + 0.7 * h(id)).toFixed(3)),
    disambiguation: `MOCK ${type.split(":").pop()}`,
  };
  registry.set(id, e);
  return e;
}

/** Deterministic synthetic search: a few namesakes for most queries, none for "clear" coined words. */
function search(query: string, take: number): MockEntity[] {
  const q = query.trim();
  const seed = h(q.toLowerCase());
  if (seed < 0.25 && q.length > 5) return []; // some coined names are clear
  const out: MockEntity[] = [];
  const n = 1 + Math.floor(seed * 5);
  for (let i = 0; i < n; i++) {
    const type = TYPES[Math.floor(h(`${q}:${i}`) * TYPES.length)];
    const suffix = i === 0 ? "" : ["", " Records", " Wave", " Collective", " Club"][i % 5];
    out.push(entity(`${q}${suffix}`, type));
  }
  return out.slice(0, take);
}

function affinity(entityId: string, signals: string): number {
  return Number(h(`${entityId}|${signals}`).toFixed(4));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!req.headers["x-api-key"]) return send(401, { error: "No API key found (mock)" });
  const p = url.searchParams;

  if (url.pathname === "/search") {
    return send(200, { results: search(p.get("query") ?? "", Number(p.get("take") ?? 10)) });
  }
  if (url.pathname === "/v2/insights") {
    const type = p.get("filter.type") ?? "";
    const signals = [p.get("signal.interests.entities"), p.get("signal.demographics.age"), p.get("signal.location.query")].join("|");
    if (type === "urn:tag") {
      const tags = ["indie", "nostalgic", "high energy", "luxury", "playful", "dark humor", "streetwear", "comfort"].map((t, i) => ({
        id: `urn:tag:mock:${t.replace(/ /g, "_")}`,
        name: `${t} (MOCK)`,
        subtype: "urn:tag:genre",
        query: { affinity: Number(h(`${signals}:${i}`).toFixed(3)) },
      }));
      return send(200, { results: { tags: tags.slice(0, Number(p.get("take") ?? 8)) } });
    }
    if (type === "urn:demographics") {
      const keys = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];
      const age = Object.fromEntries(keys.map((k) => [k, Number((h(`${signals}:${k}`) * 2 - 1).toFixed(2))]));
      return send(200, { results: { demographics: [{ entity_id: "mock", query: { age, gender: { male: 0.1, female: -0.1 } } }] } });
    }
    const ids = (p.get("filter.results.entities") ?? "").split(",").filter(Boolean);
    const entities = ids
      .map((id) => registry.get(id))
      .filter((e): e is MockEntity => Boolean(e))
      .map((e) => ({ ...e, query: { affinity: affinity(e.entity_id, signals) } }))
      .sort((a, b) => b.query.affinity - a.query.affinity);
    return send(200, { results: { entities } });
  }
  return send(404, { error: "not found (mock)" });
});

server.listen(PORT, () => console.log(`MOCK Qloo server on http://localhost:${PORT} (synthetic data only)`));
