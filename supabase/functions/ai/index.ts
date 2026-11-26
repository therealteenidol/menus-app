// Edge Function "ai": todo lo que necesita la API key de Claude pasa por aquí,
// para que la key nunca llegue al navegador.
//
// Acciones (POST JSON { action, ... }):
//   save_api_key   { api_key }                 (solo admin) guarda la key cifrada ("" para borrarla)
//   generate_week  { week_start, instructions } genera los platos de la semana
//   ingredients    { week_start }               calcula ingredientes de hasta 6 platos pendientes
//   regenerate     { item_id, hint }            cambia un plato por otro (con ingredientes)

import Anthropic from "npm:@anthropic-ai/sdk@1.7.0";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const SECTIONS = [
  "Frutas y verduras", "Carne", "Pescado", "Lácteos y huevos", "Panadería",
  "Despensa", "Congelados", "Bebidas", "Droguería y limpieza", "Otros",
];
const MEALS = ["desayuno", "comida", "cena"];
const DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

const SYSTEM =
  "Eres un planificador de menús familiares en España. Propones platos caseros, realistas, variados y " +
  "equilibrados, con ingredientes fáciles de encontrar en un supermercado español (por ejemplo Dia). " +
  "Las alergias e intolerancias son obligatorias: nunca incluyas un ingrediente al que alguien sea alérgico. " +
  "Evita lo que no gusta a algún miembro y prioriza lo que gusta a varios. " +
  "Escribe los nombres de los platos en español, cortos y claros.";

class UserError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

type Family = {
  id: string; name: string; ai_model: string; servings: number; meals: string[]; tips: string;
};
type Ingredient = { name: string; quantity: string; section: string };
type MenuItem = {
  id: number; day: number; meal: string; dish: string; notes: string; ingredients: Ingredient[] | null;
};

// ---------- Cifrado de la API key (AES-GCM) ----------

async function cryptoKey(): Promise<CryptoKey> {
  const hex = Deno.env.get("APP_ENCRYPTION_KEY") ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new UserError(
      "Falta configurar el secreto APP_ENCRYPTION_KEY de la función (64 caracteres hexadecimales). Mira el README.",
      500,
    );
  }
  const raw = new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(), new TextEncoder().encode(plain)),
  );
  return `v1:${b64(iv)}:${b64(ct)}`;
}

async function decrypt(stored: string): Promise<string> {
  const [v, iv, ct] = stored.split(":");
  if (v !== "v1") throw new Error("formato de cifrado desconocido");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await cryptoKey(), unb64(ct));
  return new TextDecoder().decode(pt);
}

// ---------- Llamada a Claude ----------

async function claudeJson<T>(
  apiKey: string, family: Family, prompt: string, schema: Record<string, unknown>,
  effort: "low" | "medium", maxTokens: number,
): Promise<T> {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  const model = MODELS.includes(family.ai_model) ? family.ai_model : "claude-opus-5-5";
  // En Opus y Sonnet activamos "fallbacks": si el modelo rechaza la petición por precaución,
  // la API la reintenta sola con otro modelo. Haiku no lo admite.
  const withFallback = model !== "claude-haiku-5-5";
  let response;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: maxTokens,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort, format: { type: "json_schema", schema } },
      ...(withFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new UserError("La API key de Claude no es válida.", 400);
    if (e instanceof Anthropic.PermissionDeniedError) throw new UserError("La API key de Claude no tiene permiso para este modelo.", 400);
    if (e instanceof Anthropic.RateLimitError) throw new UserError("Se alcanzó el límite de uso de Claude. Prueba en un minuto.", 429);
    if (e instanceof Anthropic.BadRequestError) {
      const msg = String(e.message);
      if (/credit/i.test(msg)) throw new UserError("La cuenta de Claude no tiene saldo suficiente.", 400);
      throw new UserError("Claude rechazó la petición: " + msg, 400);
    }
    if (e instanceof Anthropic.APIConnectionError) throw new UserError("No se pudo conectar con Claude. Inténtalo de nuevo.", 502);
    if (e instanceof Anthropic.APIError) throw new UserError("Error de Claude: " + e.message, 502);
    throw e;
  }
  if (response.stop_reason === "refusal") {
    throw new UserError("Claude no ha querido generar esta respuesta. Prueba a cambiar las indicaciones.", 422);
  }
  if (response.stop_reason === "max_tokens") {
    throw new UserError("La respuesta de Claude se cortó por longitud. Inténtalo de nuevo.", 502);
  }
  const text = response.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UserError("Claude devolvió una respuesta que no se entiende. Inténtalo de nuevo.", 502);
  }
}

// ---------- Contexto de la familia ----------

async function familyContext(db: SupabaseClient, family: Family) {
  const { data: members, error } = await db
    .from("profiles").select("id, name, notes").eq("family_id", family.id).order("created_at");
  if (error) throw error;
  const { data: prefs, error: e2 } = await db.from("preferences").select("user_id, kind, item").order("item");
  if (e2) throw e2;
  const lines = ["Miembros de la familia:"];
  for (const m of members ?? []) {
    const mine = (k: string) => (prefs ?? []).filter((p) => p.user_id === m.id && p.kind === k).map((p) => p.item);
    const like = mine("like"), dislike = mine("dislike"), allergy = mine("allergy");
    lines.push(
      `- ${m.name}${m.notes ? ` (${m.notes})` : ""}: le gusta: ${like.join(", ") || "—"}; ` +
        `NO le gusta: ${dislike.join(", ") || "—"}; ALERGIAS/INTOLERANCIAS: ${allergy.join(", ") || "ninguna"}`,
    );
  }
  const servings = family.servings > 0 ? family.servings : Math.max(1, members?.length ?? 1);
  lines.push("", `Raciones por comida: ${servings}`);
  const tips = (family.tips ?? "").split("\n").map((t) => t.trim()).filter(Boolean);
  if (tips.length) lines.push("", "Indicaciones permanentes de la familia:", ...tips.map((t) => `- ${t}`));
  return { text: lines.join("\n"), servings };
}

const ingredientSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string", description: 'Ingrediente genérico en singular, p.ej. "tomate", "pechuga de pollo"' },
      quantity: { type: "string", description: 'Cantidad total para las raciones indicadas, p.ej. "500 g", "2 ud", "1 l"' },
      section: { type: "string", enum: SECTIONS },
    },
    required: ["name", "quantity", "section"],
    additionalProperties: false,
  },
};

function cleanIngredients(list: unknown): Ingredient[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((i) => ({
      name: String(i?.name ?? "").trim().slice(0, 120),
      quantity: String(i?.quantity ?? "").trim().slice(0, 60),
      section: SECTIONS.includes(i?.section) ? i.section : "Otros",
    }))
    .filter((i) => i.name);
}

function mondayOf(dateStr: unknown): string {
  const s = String(dateStr ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new UserError("Fecha no válida");
  const d = new Date(s + "T12:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // 0 = lunes
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// ---------- Acciones ----------

async function generateWeek(db: SupabaseClient, family: Family, apiKey: string, body: Record<string, unknown>) {
  const week = mondayOf(body.week_start);
  const instructions = String(body.instructions ?? "").trim().slice(0, 2000);
  const meals = (family.meals ?? []).filter((m) => MEALS.includes(m));
  if (!meals.length) meals.push("comida", "cena");

  const from = new Date(week + "T12:00:00Z");
  from.setUTCDate(from.getUTCDate() - 21);
  const { data: recent } = await db
    .from("menu_items").select("dish").eq("family_id", family.id)
    .gte("week_start", from.toISOString().slice(0, 10)).lt("week_start", week).neq("dish", "");
  const recentDishes = [...new Set((recent ?? []).map((r) => r.dish))];

  const ctx = await familyContext(db, family);
  let prompt = ctx.text + "\n\n";
  if (recentDishes.length) {
    prompt += "Platos de las últimas semanas (evita repetirlos salvo que se pida):\n- " + recentDishes.join("\n- ") + "\n\n";
  }
  if (instructions) prompt += "Indicaciones para ESTA semana:\n" + instructions + "\n\n";
  prompt +=
    `Planifica el menú de lunes (day 0) a domingo (day 6) con estas comidas cada día: ${meals.join(", ")}. ` +
    'Cumple las indicaciones de frecuencia (por ejemplo "pescado 2 veces" significa exactamente dos platos de pescado en la semana). ' +
    'En "notes" pon una nota muy breve (acompañamiento, o "aprovecha sobras del martes"), o deja cadena vacía.';

  const schema = {
    type: "object",
    properties: {
      days: {
        type: "array",
        items: {
          type: "object",
          properties: {
            day: { type: "integer", description: "0 = lunes ... 6 = domingo" },
            meals: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  meal: { type: "string", enum: meals },
                  dish: { type: "string" },
                  notes: { type: "string" },
                },
                required: ["meal", "dish", "notes"],
                additionalProperties: false,
              },
            },
          },
          required: ["day", "meals"],
          additionalProperties: false,
        },
      },
    },
    required: ["days"],
    additionalProperties: false,
  };
  type WeekOut = { days: { day: number; meals: { meal: string; dish: string; notes: string }[] }[] };
  const out = await claudeJson<WeekOut>(apiKey, family, prompt, schema, "medium", 16000);

  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const d of out.days ?? []) {
    if (!(d.day >= 0 && d.day <= 6)) continue;
    for (const m of d.meals ?? []) {
      const key = `${d.day}-${m.meal}`;
      if (!meals.includes(m.meal) || seen.has(key)) continue;
      seen.add(key);
      rows.push({
        family_id: family.id, week_start: week, day: d.day, meal: m.meal,
        dish: String(m.dish ?? "").slice(0, 200), notes: String(m.notes ?? "").slice(0, 500), ingredients: null,
      });
    }
  }
  if (!rows.length) throw new UserError("Claude no devolvió ningún plato. Inténtalo de nuevo.", 502);
  const del = await db.from("menu_items").delete().eq("family_id", family.id).eq("week_start", week);
  if (del.error) throw del.error;
  const ins = await db.from("menu_items").insert(rows);
  if (ins.error) throw ins.error;
  return { ok: true, count: rows.length };
}

async function fillIngredients(db: SupabaseClient, family: Family, apiKey: string, body: Record<string, unknown>) {
  const week = mondayOf(body.week_start);
  const { data: pending, error } = await db
    .from("menu_items").select("id, dish, notes")
    .eq("family_id", family.id).eq("week_start", week).is("ingredients", null).neq("dish", "")
    .order("day").order("id").limit(6);
  if (error) throw error;
  if (!pending?.length) return { ok: true, remaining: 0 };

  const ctx = await familyContext(db, family);
  const prompt =
    ctx.text + "\n\n" +
    `Calcula la lista de ingredientes para comprar de cada plato, para ${ctx.servings} raciones. ` +
    "No incluyas agua, sal ni aceite de oliva salvo cantidades grandes. Usa cantidades de compra realistas.\n\nPlatos:\n" +
    pending.map((p) => `- id ${p.id}: ${p.dish}${p.notes ? ` (${p.notes})` : ""}`).join("\n");
  const schema = {
    type: "object",
    properties: {
      dishes: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "integer" }, ingredients: ingredientSchema },
          required: ["id", "ingredients"],
          additionalProperties: false,
        },
      },
    },
    required: ["dishes"],
    additionalProperties: false,
  };
  const out = await claudeJson<{ dishes: { id: number; ingredients: unknown }[] }>(
    apiKey, family, prompt, schema, "low", 16000,
  );
  const byId = new Map(out.dishes.map((d) => [Number(d.id), d.ingredients]));
  for (const p of pending) {
    // Si Claude se salta un plato lo dejamos con lista vacía para no entrar en bucle
    const ingredients = cleanIngredients(byId.get(Number(p.id)) ?? []);
    const up = await db.from("menu_items").update({ ingredients }).eq("id", p.id).is("ingredients", null);
    if (up.error) throw up.error;
  }
  const { count } = await db
    .from("menu_items").select("id", { count: "exact", head: true })
    .eq("family_id", family.id).eq("week_start", week).is("ingredients", null).neq("dish", "");
  return { ok: true, remaining: count ?? 0 };
}

async function regenerate(db: SupabaseClient, family: Family, apiKey: string, body: Record<string, unknown>) {
  const { data: item, error } = await db.from("menu_items").select("*").eq("id", Number(body.item_id)).maybeSingle();
  if (error) throw error;
  if (!item) throw new UserError("Plato no encontrado", 404);
  const { data: week } = await db
    .from("menu_items").select("id, day, meal, dish").eq("family_id", family.id).eq("week_start", item.week_start);
  const hint = String(body.hint ?? "").trim().slice(0, 500);
  const ctx = await familyContext(db, family);
  let prompt = ctx.text + "\n\nMenú actual de la semana:\n";
  for (const w of (week ?? []) as MenuItem[]) {
    if (w.id === item.id || !w.dish) continue;
    prompt += `- ${DAY_NAMES[w.day]} ${w.meal}: ${w.dish}\n`;
  }
  prompt +=
    `\nPropón un plato NUEVO para el ${DAY_NAMES[item.day]} (${item.meal})` +
    (item.dish ? ` que sustituya a "${item.dish}"` : "") + " y no repita lo que ya hay en la semana.";
  if (hint) prompt += `\nPetición concreta: ${hint}`;
  prompt += `\nIncluye los ingredientes a comprar para ${ctx.servings} raciones (sin agua ni sal). En notes, una nota muy breve o cadena vacía.`;
  const schema = {
    type: "object",
    properties: { dish: { type: "string" }, notes: { type: "string" }, ingredients: ingredientSchema },
    required: ["dish", "notes", "ingredients"],
    additionalProperties: false,
  };
  const out = await claudeJson<{ dish: string; notes: string; ingredients: unknown }>(
    apiKey, family, prompt, schema, "low", 8000,
  );
  const up = await db.from("menu_items").update({
    dish: String(out.dish).slice(0, 200), notes: String(out.notes ?? "").slice(0, 500),
    ingredients: cleanIngredients(out.ingredients),
  }).eq("id", item.id);
  if (up.error) throw up.error;
  return { ok: true };
}

// ---------- Servidor ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  try {
    if (req.method !== "POST") throw new UserError("Método no permitido", 405);
    const url = Deno.env.get("SUPABASE_URL")!;
    const authHeader = req.headers.get("Authorization") ?? "";
    // Cliente con los permisos del usuario (respeta RLS: solo ve su familia)
    const db = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    // Cliente de servicio: solo para leer/escribir la key cifrada
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const { data: userData } = await db.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
    const user = userData?.user;
    if (!user) throw new UserError("Tienes que iniciar sesión", 401);
    const { data: profile } = await db.from("profiles").select("id, family_id, role").eq("id", user.id).maybeSingle();
    if (!profile?.family_id) throw new UserError("Primero crea una familia o únete a una", 409);
    const { data: family } = await db.from("families").select("*").eq("id", profile.family_id).single();

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    if (action === "save_api_key") {
      if (profile.role !== "admin") throw new UserError("Solo el administrador puede cambiar la API key", 403);
      const key = String(body.api_key ?? "").trim();
      if (!key) {
        await admin.from("family_secrets").delete().eq("family_id", family.id);
        await admin.from("families").update({ api_key_hint: null }).eq("id", family.id);
        return json({ ok: true, hint: null });
      }
      if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(key)) throw new UserError("Eso no parece una API key de Claude (empieza por sk-ant-)");
      const hint = `${key.slice(0, 10)}…${key.slice(-4)}`;
      const up = await admin.from("family_secrets").upsert({
        family_id: family.id, api_key_enc: await encrypt(key), updated_at: new Date().toISOString(),
      });
      if (up.error) throw up.error;
      await admin.from("families").update({ api_key_hint: hint }).eq("id", family.id);
      return json({ ok: true, hint });
    }

    const { data: secret } = await admin.from("family_secrets").select("api_key_enc").eq("family_id", family.id).maybeSingle();
    if (!secret) throw new UserError("Falta la API key de Claude. Añádela en Familia > Inteligencia artificial.", 409);
    let apiKey: string;
    try {
      apiKey = await decrypt(secret.api_key_enc);
    } catch {
      throw new UserError("No se pudo descifrar la API key. Vuelve a guardarla en Familia.", 409);
    }

    switch (action) {
      case "generate_week": return json(await generateWeek(db, family, apiKey, body));
      case "ingredients": return json(await fillIngredients(db, family, apiKey, body));
      case "regenerate": return json(await regenerate(db, family, apiKey, body));
      default: throw new UserError("Acción desconocida", 404);
    }
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Error interno: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
