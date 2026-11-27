// Yes Chef: app (sin compilación, JavaScript moderno del navegador)
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm";
import { aggregateIngredients } from "./shopping.js";

const SECTIONS = [
  "Frutas y verduras", "Carne", "Pescado", "Lácteos y huevos", "Panadería",
  "Despensa", "Congelados", "Bebidas", "Droguería y limpieza", "Otros",
];
const MEALS = ["desayuno", "comida", "cena"];
const MEAL_LABEL = { desayuno: "Desayuno", comida: "Comida", cena: "Cena" };
const DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const MODELS = {
  "claude-opus-5-5": "Claude Opus 5.5 (mejor calidad, recomendado)",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 (más barato)",
  "claude-haiku-5-5": "Claude Haiku 5.5 (el más barato y rápido)",
};
const KINDS = {
  like: { label: "Le gusta" },
  dislike: { label: "No le gusta" },
  allergy: { label: "Alergias e intolerancias" },
};

const $app = document.getElementById("app");
const $modal = document.getElementById("modal");
const $toast = document.getElementById("toast");

const cfg = window.MENUS_CONFIG || {};
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  $app.innerHTML = `<div class="center-card"><h1>Falta configurar</h1>
    <p>Rellena <code>config.js</code> con la URL y la anon key de tu proyecto de Supabase. Lo tienes explicado en el README.</p></div>`;
  throw new Error("config.js sin rellenar");
}
const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

// ---------- Estado ----------
const S = {
  user: null, profile: null, family: null, members: [],
  week: mondayOf(new Date()), menu: [], shop: [], prefs: [], markets: [],
  aiBusy: "", channel: null,
};

// ---------- Utilidades ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return ymd(x);
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + n));
}
function weekLabel(w) {
  const f = (s) => new Date(s + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  return `${f(w)} – ${f(addDays(w, 6))}`;
}
function toast(msg, ms = 3500) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.hidden = true), ms);
}
function fail(e) {
  console.error(e);
  toast(e?.message || String(e), 6000);
}
function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}
const isAdmin = () => S.profile?.role === "admin";
const familyMeals = () => (S.family?.meals?.length ? MEALS.filter((m) => S.family.meals.includes(m)) : ["comida", "cena"]);

async function callAI(body) {
  const { data, error } = await sb.functions.invoke("ai", { body });
  if (error) {
    let msg = error.message;
    try {
      const j = await error.context.json();
      if (j?.error) msg = j.error;
    } catch { /* sin cuerpo JSON */ }
    if (msg === "Acción desconocida") msg = "La función de IA de Supabase está desactualizada: vuelve a desplegarla (mira el README).";
    if (/Failed to send|fetch/i.test(msg)) msg = "No se pudo contactar con la función de IA. ¿Está desplegada en Supabase?";
    throw new Error(msg);
  }
  return data;
}

// ---------- Modal ----------
function openModal(html) {
  $modal.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  $modal.hidden = false;
  document.body.classList.add("modal-open");
  $modal.querySelector("input, textarea, select")?.focus();
}
function closeModal() {
  $modal.hidden = true;
  $modal.innerHTML = "";
  document.body.classList.remove("modal-open");
}
$modal.addEventListener("click", (e) => {
  if (e.target === $modal) closeModal();
});

// ---------- Render con conservación de lo que se está escribiendo ----------
function render() {
  const active = document.activeElement;
  const keep = {};
  $app.querySelectorAll("input[id], textarea[id], select[id]").forEach((el) => {
    keep[el.id] = el.type === "checkbox" ? el.checked : el.value;
  });
  $app.innerHTML = view();
  for (const [id, v] of Object.entries(keep)) {
    const el = document.getElementById(id);
    if (!el || el.dataset.fresh !== undefined) continue;
    if (el.type === "checkbox") el.checked = v;
    else el.value = v;
  }
  if (active?.id) document.getElementById(active.id)?.focus();
}

function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const [name, arg] = h.split("/");
  return { name: name || "menu", arg };
}

function view() {
  const r = route();
  if (!S.user) return authView(r.name === "registro" ? "register" : "login");
  if (!S.profile && S.loadError) {
    return `<div class="center-card"><h1>No se pudo cargar</h1><p class="notice">${esc(S.loadError)}</p>
      <div class="row" style="justify-content:center"><button class="btn primary" data-act="retry">Reintentar</button>
      <button class="btn link" data-act="logout">Cerrar sesión</button></div></div>`;
  }
  if (!S.profile) return `<div class="center-card"><p>Cargando…</p></div>`;
  if (!S.family) return noFamilyView();
  let body = "";
  if (r.name === "compra") body = shopView();
  else if (r.name === "gustos") body = prefsView();
  else if (r.name === "familia") body = familyView();
  else body = menuView();
  const tab = (id, label) =>
    `<a href="#/${id}" class="${(r.name || "menu") === id || (id === "menu" && !["compra", "gustos", "familia"].includes(r.name)) ? "on" : ""}"><span>${label}</span></a>`;
  return `<main class="page">${body}</main>
    <nav class="tabs" aria-label="Secciones">${tab("menu", "Menú")}${tab("compra", "Compra")}${tab("gustos", "Gustos")}${tab("familia", "Familia")}</nav>`;
}

// ---------- Acceso ----------
function authView(mode) {
  const reg = mode === "register";
  const invite = localStorage.getItem("pendingInvite");
  return `<div class="center-card">
    <h1 class="brand">YES CHEF</h1>
    <p class="tagline">Planifica la semana con IA y comparte la lista de la compra.</p>
    ${invite ? `<p class="notice">Te han invitado a una familia. ${reg ? "Crea tu cuenta" : "Entra o crea una cuenta"} para unirte.</p>` : ""}
    <form data-form="${reg ? "register" : "login"}" class="stack card">
      ${reg ? `<label>Tu nombre<input id="a-name" name="name" required maxlength="80" autocomplete="name"></label>` : ""}
      <label>Email<input id="a-email" name="email" type="email" required autocomplete="email"></label>
      <label>Contraseña<input id="a-pass" name="password" type="password" required minlength="8" autocomplete="${reg ? "new-password" : "current-password"}"></label>
      <button class="btn primary">${reg ? "Crear cuenta" : "Entrar"}</button>
    </form>
    <p class="small on-bg">${reg ? `¿Ya tienes cuenta? <a href="#/entrar">Entra</a>` : `¿No tienes cuenta? <a href="#/registro">Regístrate</a> · <a href="#" data-act="forgot">¿Olvidaste la contraseña?</a>`}</p>
  </div>`;
}

function noFamilyView() {
  const invite = localStorage.getItem("pendingInvite") || "";
  return `<div class="center-card">
    <h1 class="brand">YES CHEF</h1>
    <h2 class="hello">Hola, ${esc(S.profile.name)}</h2>
    <p class="tagline">Para empezar, crea tu familia o únete a la de alguien con su código de invitación.</p>
    <form data-form="join" class="stack card">
      <h2>Unirme a una familia</h2>
      <label>Código de invitación<input id="j-code" name="code" value="${esc(invite)}" data-fresh placeholder="P. ej. K7M2QX9A" autocapitalize="characters" required></label>
      <button class="btn primary">Unirme</button>
    </form>
    <form data-form="create" class="stack card">
      <h2>Crear una familia nueva</h2>
      <label>Nombre<input id="c-name" name="name" placeholder="Familia García" maxlength="100"></label>
      <button class="btn">Crear familia</button>
    </form>
    <button class="btn link on-bg" data-act="logout">Cerrar sesión</button>
  </div>`;
}

// ---------- Menú ----------
function menuView() {
  const meals = familyMeals();
  const byKey = new Map(S.menu.map((i) => [`${i.day}-${i.meal}`, i]));
  const missing = S.menu.filter((i) => i.dish && i.ingredients === null).length;
  const hasKey = !!S.family.api_key_hint;
  const today = ymd(new Date());
  let days = "";
  for (let d = 0; d < 7; d++) {
    const date = addDays(S.week, d);
    const label = new Date(date + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short" });
    days += `<section class="day ${date === today ? "today" : ""}"><h3>${DAYS[d]} <small>${label}</small>${date === today ? `<span class="badge">Hoy</span>` : ""}</h3>`;
    for (const m of meals) {
      const it = byKey.get(`${d}-${m}`);
      days += `<button class="meal" data-act="dish" data-day="${d}" data-meal="${m}">
        <span class="meal-name">${MEAL_LABEL[m]}</span>
        ${it?.dish
          ? `<span class="dish">${esc(it.dish)}</span>${it.notes ? `<span class="notes">${esc(it.notes)}</span>` : ""}
             ${it.ingredients === null ? `<span class="badge">ingredientes pendientes</span>` : ""}`
          : `<span class="dish empty">Añadir plato</span>`}
      </button>`;
    }
    days += `</section>`;
  }
  return `<header class="bar">
      <button class="btn small nav-week" data-act="week" data-delta="-7" aria-label="Semana anterior">Anterior</button>
      <div class="bar-title"><h1>Menú</h1><span class="muted">${weekLabel(S.week)}</span></div>
      <button class="btn small nav-week" data-act="week" data-delta="7" aria-label="Semana siguiente">Siguiente</button>
    </header>
    ${S.aiBusy ? `<div class="notice busy"><span class="spinner"></span>${esc(S.aiBusy)}</div>` : ""}
    ${!hasKey ? `<div class="notice">Para generar menús con IA, ${isAdmin() ? `añade la API key de Claude en <a href="#/familia">Familia</a>` : "el administrador de la familia tiene que añadir la API key de Claude"}.</div>` : ""}
    <div class="actions">
      <button class="btn primary" data-act="generate" ${!hasKey || S.aiBusy ? "disabled" : ""}>${S.menu.length ? "Regenerar semana" : "Generar semana con IA"}</button>
      ${missing && hasKey ? `<button class="btn" data-act="ingredients" ${S.aiBusy ? "disabled" : ""}>Calcular ingredientes (${missing})</button>` : ""}
      ${S.menu.some((i) => i.dish) ? `<button class="btn" data-act="to-shop" ${S.aiBusy ? "disabled" : ""}>Pasar a la lista</button>` : ""}
    </div>
    ${days}`;
}

function dishModal(day, meal) {
  const it = S.menu.find((i) => i.day === day && i.meal === meal);
  const hasKey = !!S.family.api_key_hint;
  const ing = it?.ingredients;
  openModal(`<form data-form="dish" class="stack" data-day="${day}" data-meal="${meal}" data-id="${it?.id ?? ""}">
    <h2>${DAYS[day]} · ${MEAL_LABEL[meal]}</h2>
    <label>Plato<input name="dish" value="${esc(it?.dish)}" maxlength="200" placeholder="P. ej. Lentejas con verduras"></label>
    <label>Nota<input name="notes" value="${esc(it?.notes)}" maxlength="500" placeholder="Opcional"></label>
    ${ing === null && it?.dish ? `<p class="muted small">Ingredientes pendientes de calcular.</p>` : ""}
    ${ing?.length ? `<details><summary>Ingredientes (${ing.length})</summary><ul class="ing">${ing.map((i) => `<li>${esc(i.name)} <span class="muted">${esc(i.quantity)}</span></li>`).join("")}</ul></details>` : ""}
    <div class="row"><button class="btn primary">Guardar</button>
      ${it ? `<button type="button" class="btn danger" data-act="dish-delete" data-id="${it.id}">Quitar</button>` : ""}
      <button type="button" class="btn link" data-act="close">Cancelar</button></div>
  </form>
  ${it && hasKey ? `<form data-form="regen" class="stack card" data-id="${it.id}">
    <h3>Otra idea con IA</h3>
    <label>¿Qué te apetece? (opcional)<input name="hint" placeholder="P. ej. algo con pollo, más ligero, que no lleve horno"></label>
    <button class="btn">Cambiar este plato</button>
  </form>` : ""}`);
}

function generateModal() {
  const last = localStorage.getItem("lastInstructions") || "";
  openModal(`<form data-form="generate" class="stack">
    <h2>Generar la semana</h2>
    <p class="muted small">Se tendrán en cuenta los gustos y alergias de todos y los tips de la familia${S.family.tips ? "" : " (puedes añadir tips en Familia)"}.</p>
    ${S.menu.length ? `<p class="notice">Se sustituirá el menú actual de esta semana.</p>` : ""}
    <label>Indicaciones solo para esta semana (opcional)
      <textarea name="instructions" rows="3" placeholder="P. ej. el jueves cenamos fuera; aprovechar el pollo que sobró">${esc(last)}</textarea></label>
    <div class="row"><button class="btn primary">Generar</button><button type="button" class="btn link" data-act="close">Cancelar</button></div>
  </form>`);
}

async function runIngredients() {
  try {
    let remaining = S.menu.filter((i) => i.dish && i.ingredients === null).length;
    let guard = 0;
    while (remaining > 0 && guard++ < 20) {
      S.aiBusy = `Calculando ingredientes… quedan ${remaining} plato(s)`;
      render();
      const r = await callAI({ action: "ingredients", week_start: S.week });
      remaining = r.remaining;
      await loadMenu();
    }
  } finally {
    S.aiBusy = "";
    render();
  }
}

async function menuToShop() {
  const items = S.menu.filter((i) => i.dish);
  if (items.some((i) => i.ingredients === null)) {
    if (!S.family.api_key_hint) throw new Error("Hay platos sin ingredientes y no hay API key para calcularlos.");
    await runIngredients();
  }
  const all = S.menu.flatMap((i) => i.ingredients || []);
  if (!all.length) throw new Error("El menú no tiene ingredientes.");
  const agg = aggregateIngredients(all);
  if (!confirm(`Se añadirán ${agg.length} productos a la lista. Lo que vino de un menú anterior y no esté marcado se reemplaza; lo que añadisteis a mano se queda. ¿Seguimos?`)) return;
  check(await sb.from("shopping_items").delete().eq("family_id", S.family.id).eq("source", "menu").eq("checked", false));
  check(await sb.from("shopping_items").insert(agg.map((a) => ({
    family_id: S.family.id, name: a.name.slice(0, 150), quantity: a.quantity.slice(0, 80),
    section: SECTIONS.includes(a.section) ? a.section : "Otros", source: "menu", created_by: S.user.id,
  }))));
  location.hash = "#/compra";
  toast("Lista de la compra actualizada");
}

// ---------- Lista de la compra ----------
function shopView() {
  const pending = S.shop.filter((i) => !i.checked);
  const done = S.shop.filter((i) => i.checked);
  const item = (i) => `<li class="shop-item ${i.checked ? "done" : ""}">
      <label class="check"><input type="checkbox" data-act="toggle" data-id="${i.id}" ${i.checked ? "checked" : ""}>
        <span class="name">${esc(i.name)}</span>${i.quantity ? `<span class="qty">${esc(i.quantity)}</span>` : ""}</label>
      <button class="btn link small" data-act="shop-edit" data-id="${i.id}">Editar</button>
    </li>`;
  let groups = "";
  for (const sec of SECTIONS) {
    const list = pending.filter((i) => (SECTIONS.includes(i.section) ? i.section : "Otros") === sec);
    if (list.length) groups += `<section class="shop-sec"><h3>${sec}</h3><ul>${list.map(item).join("")}</ul></section>`;
  }
  return `<header class="bar"><div class="bar-title"><h1>Lista de la compra</h1><span class="muted">${pending.length} pendiente(s)</span></div></header>
    <form data-form="shop-add" class="add-row">
      <input id="s-name" name="name" placeholder="Añadir producto…" required maxlength="150">
      <input id="s-qty" name="quantity" placeholder="Cant." maxlength="80" class="qty-in">
      <select id="s-sec" name="section">${SECTIONS.map((s) => `<option>${s}</option>`).join("")}</select>
      <button class="btn primary">Añadir</button>
    </form>
    ${!S.shop.length ? `<p class="empty-state">La lista está vacía. Añade cosas arriba o pásalas desde el <a href="#/menu">menú</a>.</p>` : ""}
    ${groups}
    ${done.length ? `<section class="shop-sec"><h3>En el carro (${done.length}) <button class="btn link small" data-act="clear-done">Borrar comprados</button></h3><ul>${done.map(item).join("")}</ul></section>` : ""}`;
}

function shopEditModal(id) {
  const i = S.shop.find((x) => x.id === id);
  if (!i) return;
  openModal(`<form data-form="shop-edit" class="stack" data-id="${id}">
    <h2>Editar producto</h2>
    <label>Producto<input name="name" value="${esc(i.name)}" required maxlength="150"></label>
    <label>Cantidad<input name="quantity" value="${esc(i.quantity)}" maxlength="80"></label>
    <label>Sección<select name="section">${SECTIONS.map((s) => `<option ${s === i.section ? "selected" : ""}>${s}</option>`).join("")}</select></label>
    <div class="row"><button class="btn primary">Guardar</button>
      <button type="button" class="btn danger" data-act="shop-delete" data-id="${id}">Borrar</button>
      <button type="button" class="btn link" data-act="close">Cancelar</button></div>
  </form>`);
}

// ---------- Gustos ----------
function prefsView() {
  const members = [...S.members].sort((a, b) => (a.id === S.user.id ? -1 : b.id === S.user.id ? 1 : 0));
  const cards = members.map((m) => {
    const mine = m.id === S.user.id;
    const groups = Object.entries(KINDS).map(([k, meta]) => {
      const list = S.prefs.filter((p) => p.user_id === m.id && p.kind === k);
      return `<div class="pref-group ${k}">
        <h4>${meta.label}</h4>
        <div class="chips">${list.map((p) => `<button class="chip" data-act="pref-del" data-id="${p.id}" title="Toca para quitar" aria-label="Quitar ${esc(p.item)}">${esc(p.item)}</button>`).join("") || `<span class="muted small">Nada todavía</span>`}</div>
        <form data-form="pref-add" data-kind="${k}" data-user="${m.id}" class="mini-add">
          <input id="p-${m.id}-${k}" name="item" placeholder="Añadir (separa con comas)" maxlength="300">
          <button class="btn small">Añadir</button>
        </form>
      </div>`;
    }).join("");
    return `<article class="card member">
      <h2>${esc(m.name)}${mine ? " <small class='muted'>(tú)</small>" : ""}</h2>
      ${mine
        ? `<form data-form="notes" class="mini-add"><input id="my-notes" name="notes" value="${esc(m.notes)}" placeholder="Notas: vegetariana, niño de 5 años, deportista…" maxlength="500"><button class="btn small">Guardar</button></form>`
        : m.notes ? `<p class="muted">${esc(m.notes)}</p>` : ""}
      ${groups}
    </article>`;
  }).join("");
  return `<header class="bar"><div class="bar-title"><h1>Gustos de la familia</h1><span class="muted">La IA los tiene en cuenta al hacer el menú. Toca un gusto para quitarlo.</span></div></header>${cards}`;
}

// ---------- Familia y ajustes ----------
function inviteLink() {
  return `${location.origin}${location.pathname}#/unirse/${S.family.invite_code}`;
}

function familyView() {
  const f = S.family;
  const admin = isAdmin();
  return `<header class="bar"><div class="bar-title"><h1>${esc(f.name)}</h1><span class="muted">${S.members.length} miembro(s)</span></div></header>
  <article class="card">
    <h2>Invitar</h2>
    <p class="muted small">Comparte el enlace o el código. Quien lo use entra en la familia y ve todo lo vuestro.</p>
    <div class="code">${esc(f.invite_code)}</div>
    <div class="row"><button class="btn primary" data-act="share">Compartir enlace</button>
    ${admin ? `<button class="btn link" data-act="new-code">Cambiar código</button>` : ""}</div>
  </article>
  <article class="card">
    <h2>Miembros</h2>
    <ul class="members">${S.members.map((m) => `<li><span>${esc(m.name)} ${m.role === "admin" ? `<span class="badge">admin</span>` : ""}</span>
      ${admin && m.id !== S.user.id ? `<span>${m.role !== "admin" ? `<button class="btn link small" data-act="make-admin" data-id="${m.id}">Hacer admin</button>` : ""}<button class="btn link small danger" data-act="remove-member" data-id="${m.id}">Quitar</button></span>` : ""}</li>`).join("")}</ul>
  </article>
  <article class="card">
    <h2>Tips para la IA</h2>
    <p class="muted small">Uno por línea. Se aplican siempre al generar menús. Cualquier miembro puede editarlos.</p>
    <form data-form="tips" class="stack">
      <textarea id="f-tips" name="tips" rows="5" placeholder="Pescado 2 veces por semana&#10;Cenas ligeras&#10;Legumbres al menos 2 días&#10;Entre semana, platos de menos de 30 minutos">${esc(f.tips)}</textarea>
      <button class="btn">Guardar tips</button>
    </form>
  </article>
  <article class="card">
    <h2>Inteligencia artificial</h2>
    ${admin ? `
    <form data-form="apikey" class="stack">
      <label>API key de Claude ${f.api_key_hint ? `<span class="muted small">(guardada: ${esc(f.api_key_hint)})</span>` : ""}
        <input id="f-key" name="api_key" type="password" autocomplete="off" placeholder="${f.api_key_hint ? "Escribe una nueva para cambiarla" : "sk-ant-…"}"></label>
      <p class="muted small">Se guarda cifrada y nunca vuelve al navegador. Consíguela en console.anthropic.com, en el apartado API Keys.</p>
      <div class="row"><button class="btn">Guardar key</button>${f.api_key_hint ? `<button type="button" class="btn link danger" data-act="del-key">Borrar key</button>` : ""}</div>
    </form>
    <form data-form="settings" class="stack">
      <label>Nombre de la familia<input id="f-name" name="name" value="${esc(f.name)}" maxlength="100"></label>
      <label>Modelo<select id="f-model" name="ai_model">${Object.entries(MODELS).map(([id, l]) => `<option value="${id}" ${id === f.ai_model ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Raciones por comida <span class="muted small">(0 = una por miembro)</span><input id="f-serv" name="servings" type="number" min="0" max="20" value="${f.servings}"></label>
      <fieldset><legend>Comidas a planificar</legend>
        ${MEALS.map((m) => `<label class="inline"><input type="checkbox" name="meals" value="${m}" ${familyMeals().includes(m) ? "checked" : ""}> ${MEAL_LABEL[m]}</label>`).join("")}
      </fieldset>
      <button class="btn">Guardar ajustes</button>
    </form>` : `<p class="muted">${f.api_key_hint ? "API key configurada" : "Falta la API key: pídesela al administrador."} · Modelo: ${esc(MODELS[f.ai_model] || f.ai_model)}</p>`}
  </article>
  ${marketsCard()}
  <article class="card">
    <h2>Mi cuenta</h2>
    <form data-form="myname" class="mini-add"><input id="me-name" name="name" value="${esc(S.profile.name)}" maxlength="80" required><button class="btn small">Cambiar nombre</button></form>
    <p class="muted small">${esc(S.user.email)}</p>
    <div class="row"><button class="btn" data-act="logout">Cerrar sesión</button>
    <button class="btn link danger" data-act="leave">Salir de la familia</button></div>
  </article>`;
}

// ---------- Supermercados ----------
function marketsCard() {
  const admin = isAdmin();
  const list = S.markets.length
    ? `<ul class="markets">${S.markets.map((m) => `<li>
        <div class="market-info">
          <span class="market-name">${esc(m.name)} ${m.is_main ? `<span class="badge">principal</span>` : ""}</span>
          <a class="small" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.url.replace(/^https?:\/\//i, "").replace(/\/$/, ""))}</a>
          <span class="muted small">${m.username ? `Usuario: ${esc(m.username)}` : "Sin usuario"} · ${m.has_password ? "contraseña guardada" : "sin contraseña"}</span>
        </div>
        ${admin ? `<button class="btn link small" data-act="market-edit" data-id="${m.id}">Editar</button>` : ""}
      </li>`).join("")}</ul>`
    : `<p class="muted">Todavía no hay supermercados.</p>`;
  return `<article class="card">
    <h2>Supermercados</h2>
    <p class="muted small">Dónde hacéis la compra online. Más adelante, el asistente de compra entrará con estos datos para llenar el carrito (y se parará antes de pagar).
    ${admin ? "Las contraseñas se guardan cifradas y nunca se vuelven a mostrar, ni siquiera a ti." : "Solo el administrador puede añadirlos o cambiarlos."}</p>
    ${list}
    ${admin ? `<div class="row"><button class="btn primary" data-act="market-new">Añadir supermercado</button></div>` : ""}
  </article>`;
}

function marketModal(id) {
  const m = id ? S.markets.find((x) => x.id === id) : null;
  if (id && !m) return;
  const first = !S.markets.length;
  const val = (k, d = "") => esc(m ? m[k] : d);
  openModal(`<form data-form="market" class="stack" ${m ? `data-id="${m.id}"` : ""}>
    <h2>${m ? "Editar supermercado" : "Nuevo supermercado"}</h2>
    <label>Nombre<input name="name" value="${val("name", first ? "Dia" : "")}" required maxlength="80" placeholder="Dia"></label>
    <label>Web<input name="url" type="url" inputmode="url" value="${val("url", first ? "https://www.dia.es" : "")}" required maxlength="300" placeholder="https://www.dia.es"></label>
    <label>Usuario o email <span class="muted small">(opcional)</span><input name="username" value="${val("username")}" maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <label>Contraseña ${m?.has_password ? `<span class="muted small">(guardada; déjala vacía para no cambiarla)</span>` : `<span class="muted small">(opcional)</span>`}
      <input name="password" type="password" maxlength="200" autocomplete="new-password" placeholder="${m?.has_password ? "••••••••" : ""}"></label>
    ${m?.has_password ? `<label class="inline"><input type="checkbox" name="clear_password"> Borrar la contraseña guardada</label>` : ""}
    <label class="inline"><input type="checkbox" name="is_main" ${(m ? m.is_main : first) ? "checked" : ""}> Supermercado principal</label>
    <p class="muted small">La contraseña se envía por conexión segura, se guarda cifrada y no se puede volver a ver desde la app. Solo la usará el asistente de compra.</p>
    <div class="row"><button class="btn primary">Guardar</button>
      ${m ? `<button type="button" class="btn danger" data-act="market-delete" data-id="${m.id}">Borrar</button>` : ""}
      <button type="button" class="btn link" data-act="close">Cancelar</button></div>
  </form>`);
}

// ---------- Carga de datos ----------
async function loadProfile() {
  S.profile = check(await sb.from("profiles").select("*").eq("id", S.user.id).maybeSingle());
}
async function loadFamily() {
  if (!S.profile?.family_id) {
    S.family = null;
    S.members = [];
    return;
  }
  S.family = check(await sb.from("families").select("*").eq("id", S.profile.family_id).maybeSingle());
  S.members = check(await sb.from("profiles").select("id, name, notes, role").eq("family_id", S.profile.family_id).order("created_at"));
}
async function loadMenu() {
  S.menu = check(await sb.from("menu_items").select("*").eq("family_id", S.family.id).eq("week_start", S.week));
}
async function loadShop() {
  S.shop = check(await sb.from("shopping_items").select("*").eq("family_id", S.family.id).order("name"));
}
async function loadMarkets() {
  // Sin la tabla (SQL 0003 sin ejecutar) la app sigue funcionando
  const { data, error } = await sb.from("supermarkets")
    .select("id, name, url, username, has_password, is_main, created_at")
    .eq("family_id", S.family.id).order("is_main", { ascending: false }).order("created_at");
  if (error) console.warn("supermercados:", error.message);
  S.markets = data ?? [];
}
async function loadPrefs() {
  S.prefs = check(await sb.from("preferences").select("*").order("item"));
}

// Primera carga tras iniciar sesión: si falla, se muestra el error en vez de quedarse "Cargando…"
async function initialLoad() {
  S.loadError = "";
  try {
    await refreshAll();
    if (!S.profile) throw new Error("No se encontró tu perfil. ¿Ejecutaste los SQL de supabase/migrations?");
  } catch (e) {
    console.error(e);
    S.loadError = e?.message || String(e);
    render();
  }
}

async function refreshAll() {
  if (!S.user) return render();
  await loadProfile();
  if (!S.profile) {
    // Perfil aún no creado por el trigger; reintento breve
    await new Promise((r) => setTimeout(r, 800));
    await loadProfile();
  }
  await loadFamily();
  if (S.family) {
    await Promise.all([loadMenu(), loadShop(), loadPrefs(), loadMarkets()]);
    subscribe();
  } else {
    unsubscribe();
  }
  render();
}

// ---------- Tiempo real ----------
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshAll().catch(fail), 400);
}
function subscribe() {
  if (S.channel) return;
  S.channel = sb.channel("familia");
  for (const table of ["menu_items", "shopping_items", "preferences", "families", "profiles", "supermarkets"]) {
    S.channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleRefresh);
  }
  S.channel.subscribe();
}
function unsubscribe() {
  if (S.channel) sb.removeChannel(S.channel);
  S.channel = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.user) scheduleRefresh();
});
// Por si el tiempo real se corta (redes móviles), refresco suave cada minuto
setInterval(() => {
  if (document.visibilityState === "visible" && S.family && !S.aiBusy && $modal.hidden) scheduleRefresh();
}, 60000);

// ---------- Acciones (clics) ----------
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.tagName === "INPUT") return;
  const act = el.dataset.act;
  const id = el.dataset.id ? Number(el.dataset.id) || el.dataset.id : null;
  e.preventDefault();
  try {
    switch (act) {
      case "close": return closeModal();
      case "retry": return await initialLoad();
      case "logout":
        unsubscribe();
        await sb.auth.signOut();
        location.hash = "#/";
        return;
      case "forgot": {
        const email = document.getElementById("a-email")?.value || prompt("Tu email:");
        if (!email) return;
        check(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
        return toast("Te hemos enviado un email para cambiar la contraseña");
      }
      case "week":
        S.week = addDays(S.week, Number(el.dataset.delta));
        await loadMenu();
        return render();
      case "dish": return dishModal(Number(el.dataset.day), el.dataset.meal);
      case "dish-delete":
        check(await sb.from("menu_items").delete().eq("id", id));
        closeModal();
        await loadMenu();
        return render();
      case "generate": return generateModal();
      case "ingredients": return await runIngredients();
      case "to-shop": return await menuToShop();
      case "shop-edit": return shopEditModal(id);
      case "market-new": return marketModal(null);
      case "market-edit": return marketModal(el.dataset.id);
      case "market-delete":
        if (!confirm("¿Borrar este supermercado y su contraseña?")) return;
        await callAI({ action: "delete_supermarket", id: el.dataset.id });
        closeModal();
        await refreshAll();
        return toast("Supermercado borrado");
      case "shop-delete":
        check(await sb.from("shopping_items").delete().eq("id", id));
        closeModal();
        await loadShop();
        return render();
      case "clear-done":
        check(await sb.from("shopping_items").delete().eq("family_id", S.family.id).eq("checked", true));
        await loadShop();
        return render();
      case "pref-del":
        check(await sb.from("preferences").delete().eq("id", id));
        await loadPrefs();
        return render();
      case "share": {
        const link = inviteLink();
        const text = `Únete a "${S.family.name}" en Yes Chef (código ${S.family.invite_code})`;
        if (navigator.share) {
          try { await navigator.share({ title: "Yes Chef", text, url: link }); } catch { /* cancelado */ }
        } else {
          await navigator.clipboard.writeText(link);
          toast("Enlace copiado");
        }
        return;
      }
      case "new-code":
        if (!confirm("El código y el enlace actuales dejarán de funcionar. ¿Cambiar?")) return;
        check(await sb.rpc("regenerate_invite_code"));
        return await refreshAll();
      case "make-admin":
        check(await sb.rpc("make_admin", { p_user: el.dataset.id }));
        return await refreshAll();
      case "remove-member":
        if (!confirm("¿Quitar a este miembro de la familia?")) return;
        check(await sb.rpc("remove_member", { p_user: el.dataset.id }));
        return await refreshAll();
      case "leave":
        if (!confirm(S.members.length === 1
          ? "Eres el último miembro: se borrarán la familia, sus menús y su lista. ¿Seguro?"
          : "¿Salir de la familia? Dejarás de ver sus menús y su lista.")) return;
        check(await sb.rpc("leave_family"));
        unsubscribe();
        return await refreshAll();
      case "del-key":
        if (!confirm("¿Borrar la API key? No se podrán generar menús hasta añadir otra.")) return;
        await callAI({ action: "save_api_key", api_key: "" });
        return await refreshAll();
    }
  } catch (err) {
    fail(err);
  }
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset.act !== "toggle") return;
  const id = Number(el.dataset.id);
  const item = S.shop.find((i) => i.id === id);
  if (item) item.checked = el.checked;
  render();
  try {
    check(await sb.from("shopping_items").update({ checked: el.checked }).eq("id", id));
  } catch (err) {
    fail(err);
    await loadShop();
    render();
  }
});

// ---------- Formularios ----------
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const v = (k) => String(fd.get(k) ?? "").trim();
  const btn = form.querySelector("button:not([type=button])");
  if (btn) btn.disabled = true;
  try {
    switch (form.dataset.form) {
      case "login":
        check(await sb.auth.signInWithPassword({ email: v("email"), password: String(fd.get("password")) }));
        location.hash = "#/menu";
        break;
      case "register": {
        const data = check(await sb.auth.signUp({
          email: v("email"), password: String(fd.get("password")),
          options: { data: { name: v("name") }, emailRedirectTo: location.origin + location.pathname },
        }));
        if (!data.session) {
          openModal(`<h2>Revisa tu email</h2><p>Te hemos enviado un enlace para confirmar la cuenta. Después, vuelve aquí y entra.</p>
            <button class="btn primary" data-act="close">Vale</button>`);
          location.hash = "#/entrar";
        }
        break;
      }
      case "join":
        check(await sb.rpc("join_family", { p_code: v("code") }));
        localStorage.removeItem("pendingInvite");
        await refreshAll();
        toast("¡Ya estás en la familia!");
        location.hash = "#/gustos";
        break;
      case "create":
        check(await sb.rpc("create_family", { p_name: v("name") }));
        localStorage.removeItem("pendingInvite");
        await refreshAll();
        location.hash = "#/familia";
        break;
      case "dish": {
        const dish = v("dish").slice(0, 200);
        const notes = v("notes").slice(0, 500);
        const id = form.dataset.id ? Number(form.dataset.id) : null;
        const prev = S.menu.find((i) => i.id === id);
        if (id) {
          const patch = { dish, notes };
          if (prev?.dish !== dish) patch.ingredients = null;
          check(await sb.from("menu_items").update(patch).eq("id", id));
        } else if (dish) {
          check(await sb.from("menu_items").upsert({
            family_id: S.family.id, week_start: S.week, day: Number(form.dataset.day), meal: form.dataset.meal,
            dish, notes, ingredients: null,
          }, { onConflict: "family_id,week_start,day,meal" }));
        }
        closeModal();
        await loadMenu();
        render();
        if (dish && S.family.api_key_hint && S.menu.some((i) => i.dish && i.ingredients === null)) await runIngredients();
        break;
      }
      case "regen":
        closeModal();
        S.aiBusy = "Buscando otra idea…";
        render();
        try {
          await callAI({ action: "regenerate", item_id: Number(form.dataset.id), hint: v("hint") });
          await loadMenu();
        } finally {
          S.aiBusy = "";
          render();
        }
        break;
      case "generate": {
        const instructions = v("instructions");
        localStorage.setItem("lastInstructions", instructions);
        closeModal();
        S.aiBusy = "Pensando el menú de la semana… (puede tardar un minuto)";
        render();
        try {
          await callAI({ action: "generate_week", week_start: S.week, instructions });
          await loadMenu();
        } finally {
          S.aiBusy = "";
          render();
        }
        await runIngredients();
        toast("¡Menú listo! Toca un plato para cambiarlo.");
        break;
      }
      case "shop-add":
        check(await sb.from("shopping_items").insert({
          family_id: S.family.id, name: v("name").slice(0, 150), quantity: v("quantity").slice(0, 80),
          section: v("section"), source: "manual", created_by: S.user.id,
        }));
        form.reset();
        form.querySelector("select").value = v("section");
        await loadShop();
        render();
        document.getElementById("s-name")?.focus();
        break;
      case "shop-edit":
        check(await sb.from("shopping_items").update({
          name: v("name").slice(0, 150), quantity: v("quantity").slice(0, 80), section: v("section"),
        }).eq("id", Number(form.dataset.id)));
        closeModal();
        await loadShop();
        render();
        break;
      case "pref-add": {
        const items = [...new Set(v("item").split(",").map((s) => s.trim().slice(0, 120)).filter(Boolean))];
        if (!items.length) break;
        const user_id = form.dataset.user;
        // Si ya estaba en otra lista (p.ej. "le gusta" → "no le gusta"), se mueve
        check(await sb.from("preferences").delete().eq("user_id", user_id).in("item", items));
        check(await sb.from("preferences").insert(items.map((item) => ({ user_id, kind: form.dataset.kind, item }))));
        form.reset();
        await loadPrefs();
        render();
        break;
      }
      case "notes":
        check(await sb.from("profiles").update({ notes: v("notes").slice(0, 500) }).eq("id", S.user.id));
        await refreshAll();
        toast("Guardado");
        break;
      case "myname":
        check(await sb.from("profiles").update({ name: v("name").slice(0, 80) }).eq("id", S.user.id));
        await refreshAll();
        toast("Guardado");
        break;
      case "tips":
        check(await sb.rpc("update_family_tips", { p_tips: String(fd.get("tips") ?? "") }));
        await refreshAll();
        toast("Tips guardados");
        break;
      case "apikey": {
        const key = v("api_key");
        if (!key) break;
        await callAI({ action: "save_api_key", api_key: key });
        form.reset();
        await refreshAll();
        toast("API key guardada");
        break;
      }
      case "market":
        await callAI({
          action: "save_supermarket", id: form.dataset.id || null,
          name: v("name"), url: v("url"), username: v("username"),
          password: String(fd.get("password") ?? ""),
          clear_password: fd.get("clear_password") === "on", is_main: fd.get("is_main") === "on",
        });
        closeModal();
        await refreshAll();
        toast("Supermercado guardado");
        break;
      case "settings":
        check(await sb.rpc("update_family", {
          p_name: v("name"), p_ai_model: v("ai_model"), p_servings: Number(v("servings")) || 0,
          p_meals: fd.getAll("meals").map(String),
        }));
        await refreshAll();
        toast("Ajustes guardados");
        break;
      case "newpass":
        check(await sb.auth.updateUser({ password: String(fd.get("password")) }));
        closeModal();
        toast("Contraseña cambiada");
        break;
    }
  } catch (err) {
    fail(err);
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
});

// ---------- Arranque ----------
window.addEventListener("hashchange", () => {
  const r = route();
  if (r.name === "unirse" && r.arg) {
    localStorage.setItem("pendingInvite", r.arg.toUpperCase());
    location.hash = S.user ? "#/" : "#/registro";
    return;
  }
  render();
});

sb.auth.onAuthStateChange((event, session) => {
  const prev = S.user?.id;
  S.user = session?.user ?? null;
  if (event === "PASSWORD_RECOVERY") {
    openModal(`<form data-form="newpass" class="stack"><h2>Nueva contraseña</h2>
      <label>Contraseña<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <button class="btn primary">Guardar</button></form>`);
  }
  if (!S.user) {
    S.profile = S.family = null;
    unsubscribe();
    render();
  } else if (S.user.id !== prev) {
    S.profile = null;
    // fuera del callback para no bloquear el cliente de auth
    setTimeout(initialLoad, 0);
  }
});

{
  const r = route();
  if (r.name === "unirse" && r.arg) {
    localStorage.setItem("pendingInvite", r.arg.toUpperCase());
    history.replaceState(null, "", "#/registro");
  }
}
render();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
