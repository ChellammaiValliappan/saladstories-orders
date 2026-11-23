import type { Config, Context } from "@netlify/functions"
import { neon } from "@neondatabase/serverless"
import { getStore } from "@netlify/blobs"

const COLLS = new Set(["subs", "settings", "prep"])
const ID = /^[A-Za-z0-9_\-.:]{1,80}$/

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })

const meta = () => getStore({ name: "meta", consistency: "strong" })
const bump = async () => { await meta().set("version", String(Date.now())) }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
function merge(a: Record<string, unknown>, b: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k] as Record<string, unknown>, v) : v
  return out
}

function pinOk(req: Request) {
  const pin = Netlify.env.get("TEAM_PIN")
  if (!pin) return false
  const got = req.headers.get("x-team-pin") || ""
  if (got.length !== pin.length) return false
  let d = 0
  for (let i = 0; i < pin.length; i++) d |= pin.charCodeAt(i) ^ got.charCodeAt(i)
  return d === 0
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url)
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean)

  if (parts[0] === "login" && req.method === "POST") {
    return pinOk(req) ? json({ ok: true }) : json({ error: "Wrong PIN" }, 401)
  }
  if (!pinOk(req)) return json({ error: "Login needed" }, 401)

  if (parts[0] === "version" && req.method === "GET") {
    const v = (await meta().get("version")) || "0"
    return json({ version: v })
  }

  const dbUrl = Netlify.env.get("DATABASE_URL")
  if (!dbUrl) return json({ error: "Database not configured" }, 500)
  const sql = neon(dbUrl)

  // GET /api/coll/:coll
  if (parts[0] === "coll" && parts.length === 2 && req.method === "GET") {
    const coll = parts[1]
    if (!COLLS.has(coll)) return json({ error: "Unknown collection" }, 400)
    const rows = await sql`SELECT path, data FROM docs WHERE coll = ${coll} ORDER BY path`
    return json({ docs: rows.map((r: any) => ({ id: String(r.path).split("/").pop(), data: r.data })) })
  }

  // /api/doc/:coll/:id
  if (parts[0] === "doc" && parts.length === 3) {
    const [, coll, id] = parts
    if (!COLLS.has(coll) || !ID.test(id)) return json({ error: "Bad path" }, 400)
    const path = `${coll}/${id}`
    if (req.method === "GET") {
      const rows = await sql`SELECT data FROM docs WHERE path = ${path}`
      return json(rows.length ? { exists: true, data: rows[0].data } : { exists: false })
    }
    if (req.method === "DELETE") {
      await sql`DELETE FROM docs WHERE path = ${path}`
      await bump()
      return json({ ok: true })
    }
    let body: any
    try { body = await req.json() } catch { return json({ error: "Bad JSON" }, 400) }
    if (!isObj(body?.data)) return json({ error: "data must be an object" }, 400)
    const text = JSON.stringify(body.data)
    if (text.length > 256 * 1024) return json({ error: "Too large" }, 413)
    if (req.method === "PUT") {
      await sql`INSERT INTO docs (path, coll, data, updated_at) VALUES (${path}, ${coll}, ${text}::jsonb, now())
                ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`
      await bump()
      return json({ ok: true })
    }
    if (req.method === "PATCH") {
      const rows = await sql`SELECT data FROM docs WHERE path = ${path}`
      if (!rows.length) return json({ error: "Not found" }, 404)
      const merged = JSON.stringify(merge(rows[0].data as Record<string, unknown>, body.data))
      await sql`UPDATE docs SET data = ${merged}::jsonb, updated_at = now() WHERE path = ${path}`
      await bump()
      return json({ ok: true })
    }
  }
  return json({ error: "Not found" }, 404)
}

export const config: Config = { path: "/api/*" }
