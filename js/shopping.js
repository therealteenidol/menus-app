// Junta los ingredientes del menú para la lista de la compra, sumando cantidades si las unidades coinciden.

const UNITS = {
  "": ["ud", 1], u: ["ud", 1], ud: ["ud", 1], uds: ["ud", 1], unidad: ["ud", 1], unidades: ["ud", 1],
  g: ["g", 1], gr: ["g", 1], gramos: ["g", 1], kg: ["g", 1000], kilo: ["g", 1000], kilos: ["g", 1000],
  ml: ["ml", 1], cl: ["ml", 10], l: ["ml", 1000], litro: ["ml", 1000], litros: ["ml", 1000],
};

export function parseQty(q) {
  const m = String(q).trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*([a-záéíóúñ]*)\.?$/u);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  const u = UNITS[m[2]];
  return u ? [n * u[1], u[0]] : [n, m[2]];
}

function fmt(n) {
  return (Math.round(n * 100) / 100).toString().replace(".", ",");
}

export function formatQty(n, unit) {
  if (unit === "g" && n >= 1000) return `${fmt(n / 1000)} kg`;
  if (unit === "ml" && n >= 1000) return `${fmt(n / 1000)} l`;
  return unit ? `${fmt(n)} ${unit}` : fmt(n);
}

export function aggregateIngredients(list) {
  const groups = new Map();
  for (const i of list) {
    const key = i.name.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: i.name.trim(), section: i.section || "Otros", sums: new Map(), other: [] });
    const g = groups.get(key);
    const q = String(i.quantity || "").trim();
    if (!q) continue;
    const p = parseQty(q);
    if (p) g.sums.set(p[1], (g.sums.get(p[1]) || 0) + p[0]);
    else if (!g.other.includes(q)) g.other.push(q);
  }
  return [...groups.values()].map((g) => ({
    name: g.name,
    section: g.section,
    quantity: [...[...g.sums].map(([u, n]) => formatQty(n, u)), ...g.other].join(" + "),
  }));
}
