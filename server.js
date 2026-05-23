// Por construir, corregir el modo bidireccion
require('dotenv').config();
const express            = require('express');
const fetch              = require('node-fetch');
const fs                 = require('fs');
const path               = require('path');
const ShopifyTokenManager = require('./shopify-auth');

const app = express();
app.use(express.json());

const {
  ALEGRA_EMAIL, ALEGRA_TOKEN,
  SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
  SHOPIFY_LOCATION_ID, SHOPIFY_LOCATION_NAME, SHOPIFY_SYNC_ALL_LOCATIONS,
  PORT = 3000, SYNC_INTERVAL_MS = 300000
} = process.env;

const ALEGRA_AUTH  = Buffer.from(`${ALEGRA_EMAIL}:${ALEGRA_TOKEN}`).toString('base64');
const MAPPING_FILE = path.join(__dirname, 'mapping.json');
const AUTO_SYNC_CACHE_FILE = path.join(__dirname, 'auto-sync-cache.json');
const shopify      = new ShopifyTokenManager(SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET);

// Alegra limita el parámetro "limit" a máximo 30 en /items
const ALEGRA_MAX_LIMIT = 30;
const ALEGRA_PAGE_DELAY_MS = Number.parseInt(process.env.ALEGRA_PAGE_DELAY_MS || '0', 10) || 0;
const AUTO_SYNC_ENABLED = String(process.env.AUTO_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
const AUTO_SYNC_INTERVAL_MS = Math.max(5000, Number.parseInt(process.env.AUTO_SYNC_INTERVAL_MS || '15000', 10) || 15000);

function loadMapping() {
  if (!fs.existsSync(MAPPING_FILE)) return {};
  const raw = fs.readFileSync(MAPPING_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Si se leyó el archivo mientras se estaba escribiendo, puede quedar JSON parcial.
    // Intentamos recuperar desde un backup; si no, devolvemos {} para no tumbar la UI.
    console.error('[MAPPING] mapping.json inválido. Intentando recuperar desde .bak:', e.message);
    const bak = `${MAPPING_FILE}.bak`;
    if (fs.existsSync(bak)) {
      try {
        return JSON.parse(fs.readFileSync(bak, 'utf8'));
      } catch (e2) {
        console.error('[MAPPING] mapping.json.bak también es inválido:', e2.message);
      }
    }
    return {};
  }
}

function saveMapping(map) {
  // Escritura atómica (Windows-friendly): tmp -> (rename old to .bak) -> rename tmp -> cleanup.
  // Evita que /status o /mapping lean JSON parcial durante la escritura.
  const json = JSON.stringify(map, null, 2);
  const tmp = `${MAPPING_FILE}.tmp`;
  const bak = `${MAPPING_FILE}.bak`;
  fs.writeFileSync(tmp, json);

  try {
    if (fs.existsSync(MAPPING_FILE)) {
      // Mantener último archivo válido como backup.
      try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch (_) {}
      try {
        fs.renameSync(MAPPING_FILE, bak);
      } catch (e) {
        // Si el archivo está bloqueado por otro proceso (editor/AV), hacemos fallback a escritura directa.
        console.warn('[MAPPING] No se pudo rotar mapping.json a .bak (posible lock). Usando escritura directa:', e.message);
        fs.writeFileSync(MAPPING_FILE, json);
        return;
      }
    }
    try {
      fs.renameSync(tmp, MAPPING_FILE);
    } catch (e) {
      // Fallback si el rename falla en Windows.
      console.warn('[MAPPING] No se pudo renombrar .tmp a mapping.json. Usando escritura directa:', e.message);
      fs.writeFileSync(MAPPING_FILE, json);
      return;
    }
    try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch (_) {}
  } catch (e) {
    // Rollback best-effort
    try {
      if (!fs.existsSync(MAPPING_FILE) && fs.existsSync(bak)) fs.renameSync(bak, MAPPING_FILE);
    } catch (_) {}
    throw e;
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
  }
}

function loadAutoSyncCache() {
  if (!fs.existsSync(AUTO_SYNC_CACHE_FILE)) return { bySku: {} };
  try {
    const data = JSON.parse(fs.readFileSync(AUTO_SYNC_CACHE_FILE, 'utf8'));
    if (!data || typeof data !== 'object') return { bySku: {} };
    if (!data.bySku || typeof data.bySku !== 'object') data.bySku = {};
    return data;
  } catch (e) {
    console.warn('[AUTO] No se pudo leer auto-sync-cache.json. Se recreará:', e.message);
    return { bySku: {} };
  }
}

function saveAutoSyncCache(cache) {
  const safe = cache && typeof cache === 'object' ? cache : { bySku: {} };
  if (!safe.bySku || typeof safe.bySku !== 'object') safe.bySku = {};
  fs.writeFileSync(AUTO_SYNC_CACHE_FILE, JSON.stringify(safe, null, 2));
}

async function alegraGet(endpoint) {
  const res = await fetch(`https://api.alegra.com/api/v1/${endpoint}`, {
    headers: { 'Authorization': `Basic ${ALEGRA_AUTH}`, 'Accept': 'application/json' }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alegra ${res.status} en /${endpoint}: ${body}`);
  }
  return res.json();
}

async function alegraPost(endpoint, body) {
  const res = await fetch(`https://api.alegra.com/api/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${ALEGRA_AUTH}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alegra ${res.status} en POST /${endpoint}: ${text}`);
  }
  return res.json();
}

//Pendiente mejorar
async function alegraPut(endpoint, body) {
  const res = await fetch(`https://api.alegra.com/api/v1/${endpoint}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${ALEGRA_AUTH}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alegra ${res.status} en PUT /${endpoint}: ${text}`);
  }
  return res.json();
}

function buildAlegraInventoryFromTemplate(template, { unitCostOverride = null } = {}) {
  const inv = template?.inventory;
  if (!inv) return null;

  const unitCost = unitCostOverride !== null && Number.isFinite(Number(unitCostOverride))
    ? Number(unitCostOverride)
    : (Number.isFinite(Number(inv.unitCost)) ? Number(inv.unitCost) : 0);

  const defaultWh = Array.isArray(inv.warehouses) ? inv.warehouses.find(w => w?.isDefault) : null;
  const whId = defaultWh?.id || inv.warehouses?.[0]?.id;

  // Basado en el payload que devuelve Alegra en GET /items/:id
  const out = {
    unit: inv.unit || 'unit',
    unitCost,
    initialQuantity: 0,
    initialQuantityDate: new Date().toISOString().split('T')[0]
  };

  // Para que quede inventariable por bodega
  if (whId) out.warehouses = [{ id: whId, initialQuantity: 0 }];

  return out;
}

async function alegraGetWarehouses() {
  const data = await alegraGet('warehouses');
  return Array.isArray(data) ? data : [];
}

async function alegraGetDefaultWarehouseId() {
  const warehouses = await alegraGetWarehouses();
  const def = warehouses.find(w => w?.isDefault) || warehouses[0];
  return def?.id ? String(def.id) : null;
}

async function alegraGetInventory(itemId) {
  const item = await alegraGet(`items/${itemId}`);
  // Alegra puede retornar el inventario en distintos campos según el plan
  const qty =
    item?.inventory?.unit?.availableQuantity ??
    item?.inventory?.availableQuantity ??
    item?.inventories?.[0]?.availableQuantity ??
    0;
  return Math.max(0, Number(qty));
}

async function alegraGetAllItems() {
  // Alegra API v1: /items admite paginación con start/limit.
  // Importante: Alegra rechaza limit > 30 (código 903).
  const limit = ALEGRA_MAX_LIMIT;
  const all = [];
  let start = 0;

  const delay = async (ms) => ms > 0 ? new Promise(r => setTimeout(r, ms)) : null;

  // Tope de seguridad para evitar loops infinitos ante respuestas anómalas.
  const MAX_PAGES = 400; // 400 * 30 = 12.000 ítems
  for (let pageN = 0; pageN < MAX_PAGES; pageN++) {
    const page = await alegraGet(`items?limit=${limit}&start=${start}`);
    if (!Array.isArray(page)) break;
    all.push(...page);
    if (page.length < limit) break;
    start += limit;
    await delay(ALEGRA_PAGE_DELAY_MS);
  }

  if (start >= MAX_PAGES * limit) {
    throw new Error(`Alegra: se alcanzó el máximo de páginas (${MAX_PAGES}) al listar items. Ajusta MAX_PAGES si tu cuenta tiene más productos.`);
  }
  return all;
}

async function alegraInventoryAdjustment(itemId, deltaQty, observations = 'Ajuste automatico - sync Bagatta') {
  const qty = Math.abs(Number(deltaQty) || 0);
  if (!qty) return { ok: true, skipped: true };

  // Alegra suele requerir un "type" (entrada/salida). Para máxima compatibilidad,
  // lo enviamos tanto a nivel raíz como por ítem.
  const type = (Number(deltaQty) || 0) >= 0 ? 'in' : 'out';
  const payload = {
    date: new Date().toISOString().split('T')[0],
    type,
    observations,
    items: [{ id: itemId, quantity: qty, unitCost: 0, type }]
  };

  const res = await fetch('https://api.alegra.com/api/v1/inventory-adjustments', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${ALEGRA_AUTH}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Alegra ajuste fallo: ${await res.text()}`);
  return res.json();
}

async function alegraSetInventory(itemId, targetQty, observations = 'Ajuste automatico - sync Bagatta') {
  const current = await alegraGetInventory(itemId);
  const target = Math.max(0, Number(targetQty) || 0);
  const delta = target - current;
  const result = await alegraInventoryAdjustment(itemId, delta, observations);
  return { current, target, delta, result };
}

async function shopifyGetAllVariants() {
  // Traemos más campos del producto para poder replicar información en Alegra.
  // Nota: inventoryItem.unitCost puede requerir scopes adicionales; si llega null, se usa el costo del template de Alegra.
  const queryWithUnitCost = `query {
    products(first:250) {
      edges {
        node {
          id
          title
          status
          updatedAt
          descriptionHtml
          productType
          vendor
          tags
          variants(first:100) {
            edges {
              node {
                id
                updatedAt
                sku
                displayName
                price
                inventoryQuantity
                inventoryItem {
                  id
                  unitCost { amount currencyCode }
                }
              }
            }
          }
        }
      }
    }
  }`;

  const queryWithoutUnitCost = `query {
    products(first:250) {
      edges {
        node {
          id
          title
          status
          updatedAt
          descriptionHtml
          productType
          vendor
          tags
          variants(first:100) {
            edges {
              node {
                id
                updatedAt
                sku
                displayName
                price
                inventoryQuantity
                inventoryItem { id }
              }
            }
          }
        }
      }
    }
  }`;

  let data;
  try {
    data = await shopify.graphQL(queryWithUnitCost);
  } catch (e) {
    const msg = String(e?.message || '');
    // Si unitCost no está permitido por scopes, reintentamos sin ese campo.
    if (msg.includes('unitCost') || msg.includes('ACCESS_DENIED') || msg.includes('Access denied')) {
      data = await shopify.graphQL(queryWithoutUnitCost);
    } else {
      throw e;
    }
  }
  const variants = [];
  for (const p of data.products.edges)
    for (const v of p.node.variants.edges)
      variants.push({
        productId: p.node.id,
        productTitle: p.node.title,
        productStatus: p.node.status,
        productUpdatedAt: p.node.updatedAt,
        productDescriptionHtml: p.node.descriptionHtml,
        productType: p.node.productType,
        vendor: p.node.vendor,
        tags: p.node.tags,
        variantId: v.node.id,
        variantUpdatedAt: v.node.updatedAt,
        sku: v.node.sku,
        name: v.node.displayName,
        price: v.node.price ? Number(v.node.price) : null,
        quantity: v.node.inventoryQuantity,
        inventoryItemId: v.node.inventoryItem?.id,
        unitCost: v.node.inventoryItem?.unitCost?.amount ? Number(v.node.inventoryItem.unitCost.amount) : null,
        unitCostCurrency: v.node.inventoryItem?.unitCost?.currencyCode || null
      });
  return variants;
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildAlegraDescriptionFromShopifyVariant(v, fallback = '') {
  if (!v) return fallback || '';
  const base = stripHtml(v.productDescriptionHtml) || fallback || '';
  const meta = [];
  if (v.vendor) meta.push(`Proveedor (Shopify): ${v.vendor}`);
  if (v.productType) meta.push(`Tipo (Shopify): ${v.productType}`);
  if (Array.isArray(v.tags) && v.tags.length) meta.push(`Tags (Shopify): ${v.tags.join(', ')}`);
  if (!meta.length) return base;
  return [base, '', ...meta].filter(Boolean).join('\n');
}

function buildAlegraPriceFromExisting(existingPriceArray, newPrice) {
  if (!Number.isFinite(Number(newPrice))) return existingPriceArray;
  if (!Array.isArray(existingPriceArray) || existingPriceArray.length === 0) return existingPriceArray;
  const cloned = existingPriceArray.map(p => ({ ...p }));
  const idx = cloned.findIndex(p => p?.main) >= 0 ? cloned.findIndex(p => p?.main) : 0;
  cloned[idx].price = Number(newPrice);
  return cloned;
}
async function shopifyGetLocations({ includeName = false } = {}) {
  // Nota importante: `locations.name` requiere scope `read_locations`.
  // Para que la app funcione sin ese scope, por defecto pedimos sólo `id`.
  const queryIdsOnly = `{ locations(first:50){ edges{ node{ id } } } }`;
  const queryWithName = `{ locations(first:50){ edges{ node{ id name } } } }`;

  // Si no necesitamos el nombre, no lo pedimos (evita ACCESS_DENIED).
  if (!includeName) {
    const data = await shopify.graphQL(queryIdsOnly);
    return (data.locations?.edges || []).map(e => e.node).filter(Boolean);
  }

  // Si el usuario quiere elegir por nombre, intentamos pedirlo y si falla hacemos fallback a ids.
  try {
    const data = await shopify.graphQL(queryWithName);
    return (data.locations?.edges || []).map(e => e.node).filter(Boolean);
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('Access denied for name field') || msg.includes('read_locations')) {
      const data = await shopify.graphQL(queryIdsOnly);
      return (data.locations?.edges || []).map(e => e.node).filter(Boolean);
    }
    throw err;
  }
}

async function shopifyResolveLocationIds() {
  if (SHOPIFY_LOCATION_ID) return [SHOPIFY_LOCATION_ID];

  const needName = !!(SHOPIFY_LOCATION_NAME && String(SHOPIFY_LOCATION_NAME).trim());
  const locations = await shopifyGetLocations({ includeName: needName });
  if (locations.length === 0) throw new Error('Shopify: no se encontraron sucursales/locations');

  if (needName) {
    // Si no tenemos permiso para leer name, locations vendrá sin `name`.
    if (!locations[0]?.name) {
      console.warn('[SYNC] Shopify no permite leer el nombre de las locations (falta scope read_locations). Define SHOPIFY_LOCATION_ID en .env para elegir sucursal. Usando la primera.');
      return [locations[0].id];
    }
    const wanted = String(SHOPIFY_LOCATION_NAME).trim().toUpperCase();
    const found = locations.find(l => String(l.name || '').trim().toUpperCase() === wanted);
    if (found?.id) return [found.id];
    console.warn(`[SYNC] SHOPIFY_LOCATION_NAME="${SHOPIFY_LOCATION_NAME}" no coincide con ninguna location. Usando la primera.`);
  }

  return [locations[0].id];
}

async function shopifyGetInventoryLevelsForItem(inventoryItemId) {
  const query = `query($id: ID!) {
    inventoryItem(id: $id) {
      id
      inventoryLevels(first: 50) {
        edges {
          node {
            location { id }
            quantities(names: ["available", "on_hand"]) { name quantity }
          }
        }
      }
    }
  }`;
  const data = await shopify.graphQL(query, { id: inventoryItemId });
  const edges = data.inventoryItem?.inventoryLevels?.edges || [];
  return edges
    .map(e => e?.node)
    .filter(Boolean)
    .map(n => {
      const available = Number((n.quantities || []).find(q => q?.name === 'available')?.quantity || 0);
      const onHand = Number((n.quantities || []).find(q => q?.name === 'on_hand')?.quantity || 0);
      return { locationId: n.location?.id, available: Math.max(0, available), onHand: Math.max(0, onHand) };
    });
}

async function shopifyGetAvailableAtLocation(inventoryItemId, locationId) {
  const levels = await shopifyGetInventoryLevelsForItem(inventoryItemId);
  const match = levels.find(l => String(l.locationId) === String(locationId));
  if (!match) return 0;
  // Preferimos "available" (lo que Shopify muestra como Disponible). Si por alguna razón viene 0
  // pero hay on_hand, lo dejamos visible en diagnóstico; aquí usamos available.
  return Math.max(0, Number(match.available || 0));
}
async function shopifySetInventory(inventoryItemId, locationId, quantity) {
  const data = await shopify.graphQL(
    `mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!) { inventorySetOnHandQuantities(input: $input) { userErrors { field message } } }`,
    { input: { reason: "correction", setQuantities: [{ inventoryItemId, locationId, quantity: Math.max(0, Math.round(quantity)) }] } }
  );

  const errs = data.inventorySetOnHandQuantities?.userErrors || [];
  if (errs.length) {
    throw new Error(`Shopify inventorySetOnHandQuantities: ${errs.map(e => e.message).join(' | ')}`);
  }
  return data;
}

function normalizeSku(sku) {
  if (sku === null || sku === undefined) return null;
  const s = String(sku).trim();
  if (!s) return null;
  // evita que espacios/guiones generen SKUs distintos
  return s.toUpperCase().replace(/\s+/g, '');
}

function normalizeName(name) {
  if (name === null || name === undefined) return null;
  const s = String(name).trim();
  if (!s) return null;
  // quita tildes/diacríticos y normaliza espacios
  return s
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function getEntryTargets(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.targets)) {
    return entry.targets
      .filter(t => t && (t.inventoryItemId || entry.shopifyInventoryItemId))
      .map(t => ({
        variantId: t.variantId || t.shopifyVariantId,
        inventoryItemId: t.inventoryItemId || t.shopifyInventoryItemId,
        name: t.name,
        sku: t.sku,
        productTitle: t.productTitle
      }))
      .filter(t => t.variantId || t.inventoryItemId);
  }
  if (entry.shopifyVariantId || entry.shopifyInventoryItemId) {
    return [{
      variantId: entry.shopifyVariantId,
      inventoryItemId: entry.shopifyInventoryItemId,
      name: entry.shopifyName,
      sku: entry.sku
    }];
  }
  return [];
}

function dedupeTargets(targets) {
  // Dedupe conservando la versión “más completa”: si el mismo key aparece,
  // rellenamos campos faltantes (p.ej. productTitle) en vez de descartarlo.
  const out = [];
  const byKey = new Map();
  for (const t of targets) {
    const key = t?.inventoryItemId || t?.variantId;
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) {
      const copy = { ...t };
      byKey.set(key, copy);
      out.push(copy);
      continue;
    }
    for (const [k, v] of Object.entries(t)) {
      if (v === undefined || v === null || v === '') continue;
      if (prev[k] === undefined || prev[k] === null || prev[k] === '') prev[k] = v;
    }
  }
  return out;
}

async function buildMapping() {
  console.log('[MAPPING] Construyendo...');
  const [alegraItems, shopifyVariants] = await Promise.all([alegraGetAllItems(), shopifyGetAllVariants()]);
  const mapping = loadMapping();
  const bySku = new Map();
  const byName = new Map();
  for (const v of shopifyVariants) {
    const skuKey = normalizeSku(v.sku);
    if (skuKey) {
      const arr = bySku.get(skuKey) || [];
      arr.push(v);
      bySku.set(skuKey, arr);
    }
    const nameKey = normalizeName(v.productTitle);
    if (nameKey) {
      const arr = byName.get(nameKey) || [];
      arr.push(v);
      byName.set(nameKey, arr);
    }
  }
  let n = 0;
  for (const item of alegraItems) {
    const id = String(item.id);

    const skuKey = normalizeSku(item.reference);
    const nameKey = normalizeName(item.name);

    const matched =
      (skuKey && bySku.get(skuKey)) ||
      (nameKey && byName.get(nameKey)) ||
      null;

    if (!matched || matched.length === 0) {
      console.log(`  [?] Sin match: "${item.name}" (SKU: ${item.reference || '—'})`);
      continue;
    }

    const prev = mapping[id] || {};
    const prevTargets = getEntryTargets(prev);
    const newTargets = matched
      .filter(v => v && v.inventoryItemId)
      .map(v => ({
        variantId: v.variantId,
        inventoryItemId: v.inventoryItemId,
        name: v.name,
        sku: v.sku,
        productTitle: v.productTitle
      }));

    const mergedTargets = dedupeTargets([...prevTargets, ...newTargets]);
    const first = mergedTargets[0];

    // Mantener compatibilidad: dejamos también los campos "legacy" apuntando al primer target
    const nextEntry = {
      ...prev,
      shopifyVariantId: first?.variantId || prev.shopifyVariantId,
      shopifyInventoryItemId: first?.inventoryItemId || prev.shopifyInventoryItemId,
      sku: item.reference || prev.sku || 'sin-sku',
      alegraName: item.name || prev.alegraName,
      shopifyName: first?.name || prev.shopifyName,
      seasonal: prev.seasonal ?? false,
      targets: mergedTargets
    };

    const wasNew = !mapping[id];
    const prevCount = prevTargets.length;
    mapping[id] = nextEntry;
    const added = mergedTargets.length - prevCount;
    if (wasNew || added > 0) {
      n++;
      console.log(`  [+] ${item.name} → ${mergedTargets.length} variante(s)${added > 0 && !wasNew ? ` (+${added})` : ''}`);
    }
  }
  saveMapping(mapping);
  console.log(`[MAPPING] ${n} nuevos. Total: ${Object.keys(mapping).length}`);
  return mapping;
}

const syncState = { running: false, lastRun: null, errors: [] };
const autoSyncState = {
  running: false,
  enabled: AUTO_SYNC_ENABLED,
  intervalMs: AUTO_SYNC_INTERVAL_MS,
  lastRun: null,
  lastSummary: null,
  errors: []
};

function getAlegraQtyFromItem(item) {
  const qty =
    item?.inventory?.unit?.availableQuantity ??
    item?.inventory?.availableQuantity ??
    item?.inventories?.[0]?.availableQuantity ??
    0;
  return Math.max(0, Number(qty) || 0);
}

function getAlegraMainPrice(item) {
  const prices = Array.isArray(item?.price) ? item.price : [];
  if (!prices.length) return null;
  const main = prices.find(p => p?.main) || prices[0];
  if (!main) return null;
  const n = Number(main.price);
  return Number.isFinite(n) ? n : null;
}

function snapshotHash(data) {
  return JSON.stringify(data || {});
}

function isoToMs(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

async function shopifySetProductStatus(productId, status) {
  if (!productId || !status) return { ok: false, skipped: true };
  const data = await shopify.graphQL(
    `mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id status }
        userErrors { field message }
      }
    }`,
    { input: { id: productId, status } }
  );
  const errs = data.productUpdate?.userErrors || [];
  if (errs.length) throw new Error(`Shopify productUpdate: ${errs.map(e => e.message).join(' | ')}`);
  return data.productUpdate?.product || { id: productId, status };
}

async function alegraUpdateItemFromCurrent(current, patch = {}) {
  if (!current?.id) throw new Error('alegraUpdateItemFromCurrent: item inválido');
  const payload = {
    name: patch.name || current.name,
    type: patch.type || current.type || 'product',
    reference: patch.reference !== undefined ? patch.reference : current.reference,
    status: patch.status || current.status || 'active',
    description: patch.description !== undefined ? patch.description : (current.description || ''),
    calculationScale: patch.calculationScale || current.calculationScale,
    category: (patch.categoryId || current.category?.id) ? { id: (patch.categoryId || current.category?.id) } : undefined,
    tax: (patch.taxId || current.tax?.id) ? { id: (patch.taxId || current.tax?.id) } : undefined,
    price: patch.price || current.price,
    inventory: patch.inventory || undefined
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return alegraPut(`items/${current.id}`, payload);
}

async function autoSyncShopifyToAlegra(alegraItem, shopifyVariant, locationId) {
  const current = alegraItem?.id ? await alegraGet(`items/${alegraItem.id}`) : null;
  if (!current?.id) throw new Error('Item de Alegra no encontrado para sync Shopify→Alegra');

  const qty = await shopifyGetAvailableAtLocation(shopifyVariant.inventoryItemId, locationId);
  const targetStatus = shopifyVariant.productStatus === 'ACTIVE' ? 'active' : 'inactive';
  const updatedPrice = buildAlegraPriceFromExisting(current.price, shopifyVariant.price);

  await alegraUpdateItemFromCurrent(current, {
    name: shopifyVariant.name || current.name,
    status: targetStatus,
    description: buildAlegraDescriptionFromShopifyVariant(shopifyVariant, current.description || ''),
    price: updatedPrice
  });

  await alegraSetInventory(String(current.id), qty, 'Auto sync desde Shopify');
}

async function autoSyncAlegraToShopify(alegraItem, shopifyVariant, locationIds) {
  const qty = getAlegraQtyFromItem(alegraItem);
  for (const locationId of locationIds) {
    await shopifySetInventory(shopifyVariant.inventoryItemId, locationId, qty);
  }

  if (alegraItem.status !== 'active' && shopifyVariant.productStatus === 'ACTIVE') {
    await shopifySetProductStatus(shopifyVariant.productId, 'ARCHIVED');
  }
  if (alegraItem.status === 'active' && shopifyVariant.productStatus !== 'ACTIVE') {
    await shopifySetProductStatus(shopifyVariant.productId, 'ACTIVE');
  }
}

async function autoSyncBidirectional() {
  if (!AUTO_SYNC_ENABLED || autoSyncState.running) return;

  autoSyncState.running = true;
  autoSyncState.lastRun = new Date().toISOString();
  const summary = {
    scanned: 0,
    fromShopify: 0,
    fromAlegra: 0,
    createdInAlegra: 0,
    deactivatedInShopify: 0,
    deactivatedInAlegra: 0,
    skippedNoSku: 0,
    errors: 0
  };

  try {
    const cache = loadAutoSyncCache();
    const bySku = cache.bySku || {};

    const [alegraItems, shopifyVariants] = await Promise.all([alegraGetAllItems(), shopifyGetAllVariants()]);
    const syncAll = String(SHOPIFY_SYNC_ALL_LOCATIONS || '').toLowerCase() === 'true';
    const locationIds = syncAll
      ? (await shopifyGetLocations({ includeName: false })).map(l => l.id)
      : await shopifyResolveLocationIds();
    const locationId = locationIds[0];
    const defaultWarehouseId = await alegraGetDefaultWarehouseId().catch(() => null);

    const alegraBySku = new Map();
    for (const it of alegraItems) {
      const skuKey = normalizeSku(it.reference);
      if (!skuKey) continue;
      alegraBySku.set(skuKey, it);
    }

    const shopifyBySku = new Map();
    for (const v of shopifyVariants) {
      const skuKey = normalizeSku(v.sku);
      if (!skuKey) continue;
      if (!shopifyBySku.has(skuKey)) shopifyBySku.set(skuKey, v);
    }

    const allSkus = new Set([...alegraBySku.keys(), ...shopifyBySku.keys()]);
    for (const skuKey of allSkus) {
      summary.scanned++;
      const a = alegraBySku.get(skuKey) || null;
      const s = shopifyBySku.get(skuKey) || null;
      const rec = bySku[skuKey] || { missingAlegraCount: 0, missingShopifyCount: 0, lastSource: null };

      try {
        if (a && s) {
          rec.missingAlegraCount = 0;
          rec.missingShopifyCount = 0;

          const alegraHash = snapshotHash({
            qty: getAlegraQtyFromItem(a),
            status: a.status || 'active',
            name: a.name || '',
            description: a.description || '',
            price: getAlegraMainPrice(a)
          });
          const shopifyHash = snapshotHash({
            qty: Number(s.quantity || 0),
            status: s.productStatus || 'ACTIVE',
            name: s.name || '',
            description: stripHtml(s.productDescriptionHtml || ''),
            price: Number.isFinite(Number(s.price)) ? Number(s.price) : null
          });

          const alegraChanged = rec.alegraHash ? rec.alegraHash !== alegraHash : false;
          const shopifyChanged = rec.shopifyHash ? rec.shopifyHash !== shopifyHash : false;
          let source = null;

          if (!rec.alegraHash && rec.shopifyHash) source = 'shopify';
          else if (rec.alegraHash && !rec.shopifyHash) source = 'alegra';
          else if (alegraChanged && !shopifyChanged) source = 'alegra';
          else if (shopifyChanged && !alegraChanged) source = 'shopify';
          else if (alegraChanged && shopifyChanged) {
            const shopifyStamp = Math.max(isoToMs(s.variantUpdatedAt), isoToMs(s.productUpdatedAt));
            source = shopifyStamp >= (rec.lastShopifyUpdatedAt || 0)
              ? 'shopify'
              : (rec.lastSource === 'shopify' ? 'alegra' : 'shopify');
          }

          // Si Shopify está archivado/draft, priorizamos su estado para desactivar en Alegra.
          if (s.productStatus && s.productStatus !== 'ACTIVE' && a.status === 'active') source = 'shopify';

          if (source === 'shopify') {
            await autoSyncShopifyToAlegra(a, s, locationId);
            rec.lastSource = 'shopify';
            summary.fromShopify++;
          } else if (source === 'alegra') {
            await autoSyncAlegraToShopify(a, s, locationIds);
            rec.lastSource = 'alegra';
            summary.fromAlegra++;
          }

          rec.alegraHash = alegraHash;
          rec.shopifyHash = shopifyHash;
          rec.lastShopifyUpdatedAt = Math.max(isoToMs(s.variantUpdatedAt), isoToMs(s.productUpdatedAt));
          bySku[skuKey] = rec;
          continue;
        }

        if (s && !a) {
          rec.missingAlegraCount = (rec.missingAlegraCount || 0) + 1;
          rec.missingShopifyCount = 0;
          if (rec.missingAlegraCount >= 2) {
            const existedInBoth = !!(rec.alegraHash && rec.shopifyHash);
            if (existedInBoth) {
              // Si antes existía en ambos y ahora falta en Alegra, asumimos eliminación/desactivación en Alegra.
              if (s.productStatus === 'ACTIVE') {
                await shopifySetProductStatus(s.productId, 'ARCHIVED');
                summary.deactivatedInShopify++;
              }
            } else {
              // SKU nuevo en Shopify: crear en Alegra.
              const inventory = defaultWarehouseId
                ? {
                  unit: 'unit',
                  unitCost: Number.isFinite(Number(s.unitCost)) ? Number(s.unitCost) : 0,
                  initialQuantity: 0,
                  initialQuantityDate: new Date().toISOString().split('T')[0],
                  warehouses: [{ id: defaultWarehouseId, initialQuantity: 0 }]
                }
                : undefined;
              const created = await alegraPost('items', {
                name: s.name || `${s.productTitle || 'Producto Shopify'} - Variante`,
                type: 'product',
                reference: String(s.sku || '').trim(),
                status: s.productStatus === 'ACTIVE' ? 'active' : 'inactive',
                description: buildAlegraDescriptionFromShopifyVariant(s, ''),
                calculationScale: 6,
                inventory
              });
              if (created?.id) {
                const initialQty = await shopifyGetAvailableAtLocation(s.inventoryItemId, locationId);
                await alegraSetInventory(String(created.id), initialQty, 'Creación automática desde Shopify');
                summary.createdInAlegra++;
                rec.missingAlegraCount = 0;
              }
            }
          }
          bySku[skuKey] = rec;
          continue;
        }

        if (a && !s) {
          rec.missingShopifyCount = (rec.missingShopifyCount || 0) + 1;
          rec.missingAlegraCount = 0;
          const existedInBoth = !!(rec.alegraHash && rec.shopifyHash);
          if (existedInBoth && rec.missingShopifyCount >= 2 && a.status === 'active') {
            const current = await alegraGet(`items/${a.id}`);
            await alegraUpdateItemFromCurrent(current, { status: 'inactive' });
            summary.deactivatedInAlegra++;
          }
          bySku[skuKey] = rec;
          continue;
        }

        summary.skippedNoSku++;
      } catch (err) {
        summary.errors++;
        autoSyncState.errors.push({ time: new Date().toISOString(), sku: skuKey, error: err.message });
        if (autoSyncState.errors.length > 100) autoSyncState.errors.shift();
      }
    }

    cache.bySku = bySku;
    saveAutoSyncCache(cache);

    // Si hubo creación automática, refrescamos mapping para que quede enlazado.
    if (summary.createdInAlegra > 0) {
      try { await buildMapping(); } catch (_) {}
    }

    autoSyncState.lastSummary = summary;
    console.log('[AUTO] Sync:', JSON.stringify(summary));
  } catch (err) {
    autoSyncState.errors.push({ time: new Date().toISOString(), error: err.message });
    if (autoSyncState.errors.length > 100) autoSyncState.errors.shift();
    console.error('[AUTO] Error:', err.message);
  } finally {
    autoSyncState.running = false;
  }
}

async function syncAlegraToShopify() {
  if (syncState.running) return;
  syncState.running = true;
  syncState.lastRun = new Date().toISOString();
  console.log(`\n[SYNC] Iniciando ${syncState.lastRun}`);
  try {
    const mapping = loadMapping();
    const syncAll = String(SHOPIFY_SYNC_ALL_LOCATIONS || '').toLowerCase() === 'true';
    const locationIds = syncAll
      ? (await shopifyGetLocations({ includeName: false })).map(l => l.id)
      : await shopifyResolveLocationIds();
    if (!locationIds.length) throw new Error('No hay locations configuradas para sincronizar');
    let okTargets = 0;
    let okItems = 0;
    for (const [alegraId, entry] of Object.entries(mapping)) {
      try {
        const qty = await alegraGetInventory(alegraId);
        const targets = getEntryTargets(entry);
        if (targets.length === 0) throw new Error('Mapping sin targets de Shopify');

        let updatedAny = false;
        for (const t of targets) {
          if (!t.inventoryItemId) continue;
          for (const locationId of locationIds) {
            await shopifySetInventory(t.inventoryItemId, locationId, qty);
            okTargets++;
            updatedAny = true;
            await new Promise(r => setTimeout(r, 200));
          }
        }
        if (updatedAny) okItems++;
      } catch (err) {
        console.error(`  [ERR] ${entry.alegraName}: ${err.message}`);
        syncState.errors.push({ time: new Date().toISOString(), item: entry.alegraName, error: err.message });
        if (syncState.errors.length > 50) syncState.errors.shift();
      }
    }
    console.log(`[SYNC] OK items ${okItems}/${Object.keys(mapping).length} | targets actualizados: ${okTargets}`);
  } catch (err) { console.error('[SYNC] Error:', err.message); }
  finally { syncState.running = false; }
}

app.post('/webhooks/shopify/order-created', async (req, res) => {
  res.sendStatus(200);
  const order = req.body;
  console.log(`\n[WEBHOOK] Orden #${order.order_number}`);
  const mapping = loadMapping();
  const inv = {};
  for (const [aid, e] of Object.entries(mapping)) {
    for (const t of getEntryTargets(e)) {
      if (t.variantId) inv[t.variantId] = aid;
    }
    if (e.shopifyVariantId) inv[e.shopifyVariantId] = aid;
  }
  for (const li of (order.line_items || [])) {
    const gid = `gid://shopify/ProductVariant/${li.variant_id}`;
    const aid = inv[gid];
    if (!aid) { console.log(`  [?] Sin mapeo: ${li.name}`); continue; }
    try {
      const cur = await alegraGetInventory(aid);
      await alegraInventoryAdjustment(aid, -Math.abs(Number(li.quantity) || 0), 'Ajuste automatico - venta en Shopify');
      console.log(`  [OK] ${li.name}: ${cur} → ${Math.max(0, cur - li.quantity)}`);
    } catch (err) { console.error(`  [ERR] ${li.name}: ${err.message}`); }
  }
});

app.get('/status', (req, res) => {
  try {
    const mapping = loadMapping();
    res.json({
      ok: true,
      status: 'online',
      shopifyTokenExpiry: shopify.expiresAt ? new Date(shopify.expiresAt).toISOString() : 'pendiente',
      syncState,
      autoSyncState,
      mappingItems: Object.keys(mapping).length,
      uptime: `${Math.round(process.uptime())}s`
    });
  } catch (e) {
    // Nunca romper el panel por errores de lectura/parsing.
    res.status(200).json({ ok: false, status: 'offline', error: e.message, syncState, autoSyncState, mappingItems: 0 });
  }
});

app.post('/sync/now', async (req, res) => {
  res.json({ ok: true, message: AUTO_SYNC_ENABLED ? 'Auto-sync bidireccional iniciada' : 'Sync iniciada' });
  const runner = AUTO_SYNC_ENABLED ? autoSyncBidirectional : syncAlegraToShopify;
  runner().catch(err => console.error('[SYNC] Error en /sync/now:', err.message));
});

app.post('/mapping/rebuild', async (req, res) => {
  try {
    const m = await buildMapping();
    res.json({ ok: true, total: Object.keys(m).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/mapping', (req, res) => {
  try {
    res.json(loadMapping());
  } catch (e) {
    res.status(200).json({});
  }
});
app.post('/mapping/add', (req, res) => {
  const { alegraId, shopifyVariantId, shopifyInventoryItemId, name, seasonal } = req.body;
  if (!alegraId || !shopifyVariantId) return res.status(400).json({ error:'Faltan IDs' });
  const m = loadMapping();
  const key = String(alegraId);
  const prev = m[key] || {};
  const prevTargets = getEntryTargets(prev);
  const merged = dedupeTargets([...prevTargets, { variantId: shopifyVariantId, inventoryItemId: shopifyInventoryItemId, name }]);
  const first = merged[0];
  m[key] = {
    ...prev,
    shopifyVariantId: first?.variantId || shopifyVariantId,
    shopifyInventoryItemId: first?.inventoryItemId || shopifyInventoryItemId,
    sku: prev.sku || 'manual',
    alegraName: prev.alegraName || name || 'Sin nombre',
    shopifyName: prev.shopifyName || name || 'Sin nombre',
    seasonal: prev.seasonal ?? !!seasonal,
    targets: merged
  };
  saveMapping(m); res.json({ ok:true });
});
app.delete('/mapping/:alegraId', (req, res) => {
  const m = loadMapping(); delete m[req.params.alegraId]; saveMapping(m); res.json({ ok:true });
});

// ── DIAGNÓSTICO: ver respuesta cruda de Alegra ──────────────────────────────
// Útil para depurar qué campos exactos devuelve tu cuenta de Alegra
app.get('/debug/alegra-items', async (req, res) => {
  try {
    const raw = await alegraGet('items?limit=5&start=0');
    res.json({
      ok: true,
      count: Array.isArray(raw) ? raw.length : 'no es array',
      sample: Array.isArray(raw) ? raw.slice(0, 2) : raw
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Ver inventario de un item específico
app.get('/debug/alegra-item/:id', async (req, res) => {
  try {
    const item = await alegraGet(`items/${req.params.id}`);
    res.json({ ok: true, item });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Ver variantes de Shopify (primeros 10)
app.get('/debug/shopify-variants', async (req, res) => {
  try {
    const variants = await shopifyGetAllVariants();
    res.json({ ok: true, count: variants.length, sample: variants.slice(0, 3) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Ver sucursales/locations de Shopify (para escoger la correcta en sync)
app.get('/debug/shopify-locations', async (req, res) => {
  try {
    const locations = await shopifyGetLocations({ includeName: true });
    res.json({ ok: true, count: locations.length, locations });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Diagnóstico: ver cantidades por location para un InventoryItem (available y on_hand)
app.get('/debug/shopify-inventory-levels/:inventoryItemId', async (req, res) => {
  try {
    const levels = await shopifyGetInventoryLevelsForItem(req.params.inventoryItemId);
    res.json({ ok: true, count: levels.length, levels });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Diagnóstico: buscar por SKU y ver inventoryItemId + niveles
app.get('/debug/shopify-sku/:sku', async (req, res) => {
  try {
    const skuKey = normalizeSku(req.params.sku);
    const variants = await shopifyGetAllVariants();
    const v = variants.find(x => normalizeSku(x.sku) === skuKey);
    if (!v) return res.status(404).json({ ok: false, error: 'SKU no encontrado en Shopify' });
    const locationId = (await shopifyResolveLocationIds())[0];
    const levels = await shopifyGetInventoryLevelsForItem(v.inventoryItemId);
    const atLocation = levels.find(l => String(l.locationId) === String(locationId)) || null;
    res.json({ ok: true, sku: v.sku, inventoryItemId: v.inventoryItemId, selectedLocationId: locationId, atLocation, levels });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Crear en Alegra los ítems que existen como variantes en Shopify pero no existen por SKU en Alegra.
// Útil cuando Shopify maneja inventario por color/talla (SKU distinto por variante) y en Alegra falta crear algunos.
app.post('/catalog/alegra/create-missing-from-shopify', async (req, res) => {
  try {
    const [alegraItems, shopifyVariants] = await Promise.all([alegraGetAllItems(), shopifyGetAllVariants()]);

    // Para inicializar el inventario nuevo, tomamos el "available" de la location que sincronizamos.
    const locationId = (await shopifyResolveLocationIds())[0];

    // Índice de Alegra por SKU (reference)
    const alegraBySku = new Map();
    for (const it of alegraItems) {
      const key = normalizeSku(it.reference);
      if (key) alegraBySku.set(key, it);
    }

    // Agrupar variantes por producto (productTitle)
    const groups = new Map();
    for (const v of shopifyVariants) {
      const gk = normalizeName(v.productTitle) || '(SIN_TITULO)';
      const arr = groups.get(gk) || [];
      arr.push(v);
      groups.set(gk, arr);
    }

    const created = [];
    const skipped = [];
    const errors = [];

    for (const [, variants] of groups.entries()) {
      // Encontrar un "template" en Alegra dentro de este grupo, para copiar category/price/etc.
      let templateId = null;
      for (const v of variants) {
        const skuKey = normalizeSku(v.sku);
        if (skuKey && alegraBySku.has(skuKey)) {
          templateId = String(alegraBySku.get(skuKey).id);
          break;
        }
      }

      if (!templateId) {
        // fallback: buscar por nombre de producto
        const nameKey = normalizeName(variants[0]?.productTitle);
        const byName = alegraItems.find(it => normalizeName(it.name) === nameKey);
        if (byName) templateId = String(byName.id);
      }

      if (!templateId) {
        for (const v of variants) {
          const skuKey = normalizeSku(v.sku);
          if (!skuKey) continue;
          if (!alegraBySku.has(skuKey)) {
            skipped.push({ reason: 'sin_template_en_alegra', sku: v.sku, productTitle: v.productTitle, variantName: v.name });
          }
        }
        continue;
      }

      const template = await alegraGet(`items/${templateId}`);

      for (const v of variants) {
        const skuKey = normalizeSku(v.sku);
        if (!skuKey) {
          skipped.push({ reason: 'variante_sin_sku', productTitle: v.productTitle, variantName: v.name, variantId: v.variantId });
          continue;
        }
        if (alegraBySku.has(skuKey)) continue;

        const payload = {
          name: v.name || `${v.productTitle} - Variante`,
          // En algunas cuentas de Alegra el campo `type` es obligatorio (p.ej. "product").
          // Si el template lo trae, lo copiamos; si no, asumimos producto inventariable.
          type: template.type || 'product',
          // Intentamos replicar la descripción desde Shopify; si no hay, usamos la del template.
          description: buildAlegraDescriptionFromShopifyVariant(v, template.description || ''),
          reference: String(v.sku).trim(),
          status: 'active',
          calculationScale: template.calculationScale,
          category: template.category?.id ? { id: template.category.id } : undefined,
          price: template.price,
          tax: template.tax?.id ? { id: template.tax.id } : undefined,
          // Clave para que aparezca "Ítem inventariable: Activado" en Alegra:
          // copiamos configuración de inventario (bodega, unidad, costo) del template.
          inventory: buildAlegraInventoryFromTemplate(template, { unitCostOverride: v.unitCost })
        };

        // limpiar undefined
        for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

        try {
          const createdItem = await alegraPost('items', payload);
          const newId = createdItem?.id ? String(createdItem.id) : null;

          // Inicializar inventario en Alegra con el valor actual en Shopify (para que queden iguales desde ya)
          if (newId) {
            const initialQty = await shopifyGetAvailableAtLocation(v.inventoryItemId, locationId);
            await alegraInventoryAdjustment(newId, initialQty, 'Inicializacion inventario desde Shopify');
          }

          created.push({ sku: v.sku, alegraId: newId, name: payload.name, initialQty: Number.isFinite(Number(v.quantity)) ? Number(v.quantity) : undefined });
          if (newId) alegraBySku.set(skuKey, { id: newId, reference: v.sku, name: payload.name });
        } catch (e) {
          errors.push({ sku: v.sku, productTitle: v.productTitle, variantName: v.name, error: e.message });
        }
      }
    }

    // Opcional: reconstruir mapping automáticamente después de crear
    let mapping = null;
    try { mapping = await buildMapping(); } catch (e) { /* no bloquea */ }

    res.json({ ok: true, createdCount: created.length, skippedCount: skipped.length, errorCount: errors.length, created, skipped: skipped.slice(0, 50), errors: errors.slice(0, 50), mappingTotal: mapping ? Object.keys(mapping).length : undefined });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Arregla ítems ya creados en Alegra que quedaron NO inventariables (sin campo `inventory`).
// Esto pasa cuando se crearon antes de añadir `inventory` al payload.
// También intenta copiar la descripción desde Shopify.
app.post('/catalog/alegra/fix-existing-items-from-template', async (req, res) => {
  try {
    const mapping = loadMapping();
    const shopifyVariants = await shopifyGetAllVariants();

    const shopifyBySku = new Map();
    for (const v of shopifyVariants) {
      const key = normalizeSku(v.sku);
      if (key) shopifyBySku.set(key, v);
    }

    // Plantillas por producto (título Shopify) tomadas de los ítems de Alegra que YA son inventariables.
    // Si a un target le falta productTitle (caso mappings antiguos), lo resolvemos vía SKU→Shopify.
    const templateByProduct = new Map();
    for (const [alegraId, entry] of Object.entries(mapping)) {
      const targets = getEntryTargets(entry);
      let productTitle = targets[0]?.productTitle || null;
      if (!productTitle) {
        const skuKey = normalizeSku(entry.sku || targets[0]?.sku);
        const sv = skuKey ? shopifyBySku.get(skuKey) : null;
        productTitle = sv?.productTitle || null;
      }
      if (!productTitle) continue;
      const pkey = normalizeName(productTitle);
      if (!pkey || templateByProduct.has(pkey)) continue;
      const item = await alegraGet(`items/${alegraId}`);
      if (item?.inventory) templateByProduct.set(pkey, item);
    }

    // Fallback global para activar inventario aunque no exista template inventariable por producto.
    const defaultWarehouseId = await alegraGetDefaultWarehouseId();

    const fixed = [];
    const skipped = [];
    const errors = [];

    for (const [alegraId, entry] of Object.entries(mapping)) {
      try {
        const current = await alegraGet(`items/${alegraId}`);
        if (current?.inventory) continue; // ya inventariable

        const targets = getEntryTargets(entry);
        const skuKey = normalizeSku(entry.sku || targets[0]?.sku);
        const sv = skuKey ? shopifyBySku.get(skuKey) : null;
        const productTitle = targets[0]?.productTitle || sv?.productTitle || null;

        const template = productTitle ? templateByProduct.get(normalizeName(productTitle)) : null;

        const inventory = template?.inventory
          ? buildAlegraInventoryFromTemplate(template, { unitCostOverride: sv?.unitCost ?? null })
          : (defaultWarehouseId
            ? {
              unit: 'unit',
              unitCost: Number.isFinite(Number(sv?.unitCost)) ? Number(sv.unitCost) : 0,
              initialQuantity: 0,
              initialQuantityDate: new Date().toISOString().split('T')[0],
              warehouses: [{ id: defaultWarehouseId, initialQuantity: 0 }]
            }
            : null);
        if (!inventory) {
          skipped.push({ alegraId, reason: 'no_se_pudo_construir_inventory', productTitle, sku: entry.sku, name: current?.name });
          continue;
        }

        const payload = {
          name: current.name,
          type: current.type || template?.type || 'product',
          reference: current.reference,
          status: current.status || 'active',
          description: buildAlegraDescriptionFromShopifyVariant(sv, current.description || template?.description || ''),
          calculationScale: current.calculationScale || template?.calculationScale,
          category: (current.category?.id || template?.category?.id) ? { id: (current.category?.id || template?.category?.id) } : undefined,
          price: current.price || template?.price,
          tax: (current.tax?.id || template?.tax?.id) ? { id: (current.tax?.id || template?.tax?.id) } : undefined,
          inventory
        };
        for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

        await alegraPut(`items/${alegraId}`, payload);
        fixed.push({ alegraId, sku: current.reference, name: current.name, productTitle });
      } catch (e) {
        errors.push({ alegraId, sku: entry.sku, error: e.message });
      }
    }

    res.json({ ok: true, fixedCount: fixed.length, skippedCount: skipped.length, errorCount: errors.length, fixed: fixed.slice(0, 50), skipped: skipped.slice(0, 50), errors: errors.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Copia inventario DESDE Shopify HACIA Alegra por SKU (útil sólo para “alineación inicial”).
// Luego se recomienda que Alegra sea la fuente de verdad y se use /sync/now.
app.post('/catalog/alegra/init-inventory-from-shopify', async (req, res) => {
  try {
    const [alegraItems, shopifyVariants] = await Promise.all([alegraGetAllItems(), shopifyGetAllVariants()]);
    const locationId = (await shopifyResolveLocationIds())[0];
    const alegraBySku = new Map();
    for (const it of alegraItems) {
      const key = normalizeSku(it.reference);
      if (key) alegraBySku.set(key, it);
    }

    const results = [];
    const errors = [];
    for (const v of shopifyVariants) {
      const skuKey = normalizeSku(v.sku);
      if (!skuKey) continue;
      const it = alegraBySku.get(skuKey);
      if (!it?.id) continue;
      try {
        const available = await shopifyGetAvailableAtLocation(v.inventoryItemId, locationId);
        const r = await alegraSetInventory(String(it.id), available, 'Inicializacion inventario desde Shopify');
        results.push({ sku: v.sku, alegraId: String(it.id), target: r.target, delta: r.delta });
      } catch (e) {
        errors.push({ sku: v.sku, alegraId: String(it.id), error: e.message });
      }
    }

    res.json({ ok: true, updated: results.length, errorCount: errors.length, sample: results.slice(0, 50), errors: errors.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Sincroniza campos de catálogo desde Shopify hacia Alegra (nombre, descripción y precio).
// Esto NO toca existencias (para eso usa /catalog/alegra/init-inventory-from-shopify o la sync Alegra→Shopify).
app.post('/catalog/alegra/update-fields-from-shopify', async (req, res) => {
  try {
    const mapping = loadMapping();
    const shopifyVariants = await shopifyGetAllVariants();

    const shopifyBySku = new Map();
    for (const v of shopifyVariants) {
      const key = normalizeSku(v.sku);
      if (key) shopifyBySku.set(key, v);
    }

    const updated = [];
    const skipped = [];
    const errors = [];

    for (const [alegraId, entry] of Object.entries(mapping)) {
      const skuKey = normalizeSku(entry.sku);
      if (!skuKey) {
        skipped.push({ alegraId, reason: 'sin_sku', alegraName: entry.alegraName });
        continue;
      }

      const sv = shopifyBySku.get(skuKey);
      if (!sv) {
        skipped.push({ alegraId, sku: entry.sku, reason: 'sku_no_encontrado_en_shopify', alegraName: entry.alegraName });
        continue;
      }

      try {
        const current = await alegraGet(`items/${alegraId}`);
        const payload = {
          name: sv.name || current.name,
          type: current.type || 'product',
          reference: current.reference,
          status: current.status || 'active',
          description: buildAlegraDescriptionFromShopifyVariant(sv, current.description || ''),
          calculationScale: current.calculationScale,
          category: current.category?.id ? { id: current.category.id } : undefined,
          tax: current.tax?.id ? { id: current.tax.id } : undefined,
          price: buildAlegraPriceFromExisting(current.price, sv.price)
        };
        for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

        await alegraPut(`items/${alegraId}`, payload);
        updated.push({ alegraId, sku: entry.sku, alegraName: current.name, shopifyName: sv.name, price: sv.price ?? null });
      } catch (e) {
        errors.push({ alegraId, sku: entry.sku, error: e.message });
      }
    }

    res.json({ ok: true, updatedCount: updated.length, skippedCount: skipped.length, errorCount: errors.length, updated: updated.slice(0, 50), skipped: skipped.slice(0, 50), errors: errors.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Forzar una cantidad por SKU en ambos sistemas (Alegra + Shopify) para resolver conflictos.
// Body: { "sku": "49844142", "quantity": 3 }
app.post('/inventory/set', async (req, res) => {
  try {
    const { sku, quantity } = req.body || {};
    const skuKey = normalizeSku(sku);
    if (!skuKey) return res.status(400).json({ ok: false, error: 'SKU requerido' });
    const qty = Math.max(0, Number(quantity));
    if (!Number.isFinite(qty)) return res.status(400).json({ ok: false, error: 'quantity inválido' });

    const mapping = loadMapping();
    let alegraId = null;
    let shopifyInventoryItemId = null;
    let shopifyVariantId = null;

    for (const [aid, entry] of Object.entries(mapping)) {
      const eSkuKey = normalizeSku(entry.sku);
      if (eSkuKey !== skuKey) continue;
      alegraId = aid;
      const targets = getEntryTargets(entry);
      shopifyInventoryItemId = targets[0]?.inventoryItemId || entry.shopifyInventoryItemId || null;
      shopifyVariantId = targets[0]?.variantId || entry.shopifyVariantId || null;
      break;
    }

    if (!alegraId || !shopifyInventoryItemId) {
      return res.status(404).json({ ok: false, error: 'SKU no encontrado en mapping (o falta inventoryItemId)' });
    }

    // 1) Set en Alegra
    const alegra = await alegraSetInventory(String(alegraId), qty, 'Forzado manual desde Bagatta Sync');

    // 2) Set en Shopify (location configurada)
    const locationIds = await shopifyResolveLocationIds();
    for (const locationId of locationIds) {
      await shopifySetInventory(shopifyInventoryItemId, locationId, qty);
    }
    const shopifyLevels = await shopifyGetInventoryLevelsForItem(shopifyInventoryItemId);

    res.json({
      ok: true,
      sku: String(sku).trim(),
      alegraId,
      shopifyVariantId,
      shopifyInventoryItemId,
      setQuantity: qty,
      alegra,
      shopify: { selectedLocationIds: locationIds, levels: shopifyLevels }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Comparación rápida: qué existe en un sistema y no en el otro (por SKU/nombre)
app.get('/debug/mapping-gaps', async (req, res) => {
  try {
    const [alegraItems, shopifyVariants] = await Promise.all([alegraGetAllItems(), shopifyGetAllVariants()]);

    const alegraSku = new Set();
    const alegraName = new Set();
    for (const it of alegraItems) {
      const s = normalizeSku(it.reference);
      if (s) alegraSku.add(s);
      const n = normalizeName(it.name);
      if (n) alegraName.add(n);
    }

    const shopifySku = new Set();
    const shopifyName = new Set();
    const shopifySkuCounts = new Map();
    for (const v of shopifyVariants) {
      const s = normalizeSku(v.sku);
      if (s) {
        shopifySku.add(s);
        shopifySkuCounts.set(s, (shopifySkuCounts.get(s) || 0) + 1);
      }
      const n = normalizeName(v.productTitle);
      if (n) shopifyName.add(n);
    }

    const alegraNoMatchAll = alegraItems
      .filter(it => {
        const s = normalizeSku(it.reference);
        const n = normalizeName(it.name);
        const skuMatches = s ? shopifySku.has(s) : false;
        const nameMatches = n ? shopifyName.has(n) : false;
        return !skuMatches && !nameMatches;
      })
      .map(it => ({ id: String(it.id), name: it.name, reference: it.reference || null }));

    const shopifyNoMatchAll = shopifyVariants
      .filter(v => {
        const s = normalizeSku(v.sku);
        const n = normalizeName(v.productTitle);
        const skuMatches = s ? alegraSku.has(s) : false;
        const nameMatches = n ? alegraName.has(n) : false;
        return !skuMatches && !nameMatches;
      })
      .map(v => ({ variantId: v.variantId, productTitle: v.productTitle, name: v.name, sku: v.sku || null }));

    const alegraNoMatch = alegraNoMatchAll.slice(0, 50);
    const shopifyNoMatch = shopifyNoMatchAll.slice(0, 50);

    const duplicatedSkus = [...shopifySkuCounts.entries()]
      .filter(([, count]) => count > 1)
      .slice(0, 50)
      .map(([sku, count]) => ({ sku, count }));

    res.json({
      ok: true,
      counts: {
        alegraItems: alegraItems.length,
        shopifyVariants: shopifyVariants.length,
        alegraNoMatch: alegraNoMatchAll.length,
        shopifyNoMatch: shopifyNoMatchAll.length,
        duplicatedSkus: duplicatedSkus.length
      },
      sample: {
        alegraNoMatch,
        shopifyNoMatch,
        duplicatedSkus
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`\n Bagatta Sync en puerto ${PORT} — tokens auto-renovacion c/24h\n`);
  await shopify.getToken().catch(e => console.error('[INIT] Credenciales Shopify invalidas:', e.message));
  if (Object.keys(loadMapping()).length === 0) await buildMapping().catch(console.error);
  if (AUTO_SYNC_ENABLED) {
    console.log(`[AUTO] Sync bidireccional habilitada cada ${AUTO_SYNC_INTERVAL_MS} ms`);
    await autoSyncBidirectional().catch(console.error);
    setInterval(() => autoSyncBidirectional().catch(console.error), AUTO_SYNC_INTERVAL_MS);
  } else {
    await syncAlegraToShopify().catch(console.error);
    setInterval(() => syncAlegraToShopify().catch(console.error), parseInt(SYNC_INTERVAL_MS));
  }
});

// ------------------------------------------------------------
// PANEL DE CONTROL — Interfaz web en el navegador
// Accesible en http://localhost:3000
// ------------------------------------------------------------
app.get('/', (req, res) => {
  // Evita que el navegador conserve una versión vieja del panel JS.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bagatta Sync — Panel de control</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #f0ebe0; min-height: 100vh; padding: 32px 24px; }
    h1 { font-size: 22px; font-weight: 300; letter-spacing: 0.1em; color: #c9a96e; margin-bottom: 6px; }
    .subtitle { font-size: 12px; color: #666; letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 32px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: #141414; border: 1px solid #222; border-radius: 8px; padding: 20px; }
    .card-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.15em; margin-bottom: 8px; }
    .card-value { font-size: 22px; font-weight: 300; color: #f0ebe0; }
    .card-value.gold { color: #c9a96e; }
    .card-value.green { color: #4caf82; }
    .card-value.red { color: #e05a5a; }
    .card-sub { font-size: 11px; color: #555; margin-top: 4px; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 32px; }
    button { padding: 12px 24px; border: 1px solid #c9a96e; background: transparent; color: #c9a96e; font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase; cursor: pointer; border-radius: 4px; transition: all 0.2s; }
    button:hover { background: #c9a96e; color: #0a0a0a; }
    button.danger { border-color: #e05a5a; color: #e05a5a; }
    button.danger:hover { background: #e05a5a; color: #fff; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .log { background: #0d0d0d; border: 1px solid #1a1a1a; border-radius: 8px; padding: 20px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.8; color: #888; max-height: 320px; overflow-y: auto; }
    .log .ok { color: #4caf82; }
    .log .err { color: #e05a5a; }
    .log .info { color: #c9a96e; }
    .section-title { font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 0.15em; margin-bottom: 12px; }
    .mapping-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .mapping-table th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #222; color: #555; font-weight: normal; text-transform: uppercase; letter-spacing: 0.1em; font-size: 10px; }
    .mapping-table td { padding: 8px 12px; border-bottom: 1px solid #141414; color: #888; }
    .mapping-table tr:hover td { color: #f0ebe0; background: #111; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; letter-spacing: 0.1em; }
    .badge.seasonal { background: #1a1200; color: #c9a96e; border: 1px solid #c9a96e44; }
    .badge.permanent { background: #001a0d; color: #4caf82; border: 1px solid #4caf8244; }
  </style>
</head>
<body>
  <h1>Bagatta Sync</h1>
  <p class="subtitle">Panel de control — sincronización Alegra ↔ Shopify</p>

  <div class="grid" id="stats">
    <div class="card"><div class="card-label">Estado</div><div class="card-value green" id="st-status">Cargando...</div></div>
    <div class="card"><div class="card-label">Productos mapeados</div><div class="card-value gold" id="st-mapping">—</div></div>
    <div class="card"><div class="card-label">Última sync</div><div class="card-value" id="st-last" style="font-size:14px">—</div></div>
    <div class="card"><div class="card-label">Token Shopify vence</div><div class="card-value" id="st-token" style="font-size:13px">—</div></div>
  </div>

  <div class="section-title">Acciones</div>
  <div style="font-size:11px;color:#555;margin-top:-6px;margin-bottom:12px;line-height:1.6">
    Operación normal recomendada: <span style="color:#c9a96e">Alegra → Shopify</span> (Alegra manda el inventario y Shopify se actualiza).
  </div>
  <div class="actions">
    <button onclick="action('/sync/now')">Sync inventario (Alegra → Shopify)</button>
    <button onclick="action('/mapping/rebuild')">Reconstruir mapping (SKU/Nombre)</button>
    <button onclick="loadMapping()">Ver mapping</button>
    <button onclick="refreshStatus()">Actualizar estado</button>
  </div>
  <div class="section-title" style="margin-top:20px">Diagnóstico</div>
  <div class="actions">
    <button onclick="debugGet('/debug/alegra-items')" style="border-color:#555;color:#888">Ver items de Alegra</button>
    <button onclick="debugGet('/debug/shopify-variants')" style="border-color:#555;color:#888">Ver variantes Shopify</button>
    <button onclick="debugGet('/debug/mapping-gaps')" style="border-color:#555;color:#888">Ver diferencias</button>
    <button onclick="debugGet('/debug/shopify-locations')" style="border-color:#555;color:#888">Ver sucursales</button>
  </div>

  <div class="section-title" style="margin-bottom:8px">Log de operaciones</div>
  <div class="log" id="log"><span class="info">Listo. Usa los botones. Por defecto el inventario se sincroniza de Alegra → Shopify.</span></div>

  <div class="section-title" style="margin-top:24px">Acciones avanzadas (Shopify → Alegra)</div>
  <div style="font-size:11px;color:#555;margin-top:-6px;margin-bottom:12px;line-height:1.6">
    Úsalas para <span style="color:#c9a96e">crear/ajustar</span> ítems en Alegra basados en Shopify. 
    <span style="color:#e05a5a">Importar inventario</span> puede sobrescribir cantidades en Alegra.
  </div>
  <div class="actions">
    <button onclick="action('/catalog/alegra/create-missing-from-shopify')" style="border-color:#777;color:#bbb">Crear ítems faltantes en Alegra (por SKU desde Shopify)</button>
    <button onclick="action('/catalog/alegra/fix-existing-items-from-template')" style="border-color:#777;color:#bbb">Activar inventario/costo en ítems de Alegra</button>
    <button onclick="action('/catalog/alegra/update-fields-from-shopify')" style="border-color:#777;color:#bbb">Copiar datos (Shopify → Alegra): nombre/descr/precio</button>
    <button class="danger" onclick="action('/catalog/alegra/init-inventory-from-shopify')">IMPORTAR inventario (Shopify → Alegra)</button>
  </div>

  <div class="section-title" style="margin-top:18px">Resolver conflicto rápido (por SKU)</div>
  <div class="actions" style="gap:8px">
    <input id="force-sku" placeholder="SKU (ej: 49844142)" style="padding:12px 12px;border-radius:4px;border:1px solid #333;background:#0d0d0d;color:#ddd;min-width:240px" />
    <input id="force-qty" placeholder="Cantidad (ej: 3)" style="padding:12px 12px;border-radius:4px;border:1px solid #333;background:#0d0d0d;color:#ddd;min-width:160px" />
    <button onclick="forceSetInventory()" style="border-color:#c9a96e;color:#c9a96e">Forzar en ambos</button>
  </div>

  <div style="margin-top:32px">
    <div class="section-title" style="margin-bottom:12px">Tabla de mapping</div>
    <div style="overflow-x:auto">
      <table class="mapping-table">
        <thead><tr><th>ID Alegra</th><th>Nombre Alegra</th><th>Nombre Shopify</th><th>SKU</th><th>Tipo</th></tr></thead>
        <tbody id="mapping-body"><tr><td colspan="5" style="color:#444;text-align:center;padding:20px">Haz clic en "Ver mapping" para cargar</td></tr></tbody>
      </table>
    </div>
  </div>

  <script>
    async function fetchJson(url, options) {
      if (!window.fetch) {
        // Fallback básico para navegadores antiguos sin fetch().
        return await new Promise(function (resolve, reject) {
          try {
            var xhr = new XMLHttpRequest();
            xhr.open((options && options.method) ? options.method : 'GET', url, true);
            if (options && options.headers) {
              for (var h in options.headers) {
                if (Object.prototype.hasOwnProperty.call(options.headers, h)) {
                  xhr.setRequestHeader(h, options.headers[h]);
                }
              }
            }
            xhr.onload = function () {
              resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, text: function () { return Promise.resolve(xhr.responseText); } });
            };
            xhr.onerror = function () { reject(new Error('Fallo de red (XHR)')); };
            xhr.send((options && options.body) ? options.body : null);
          } catch (e) {
            reject(e);
          }
        }).then(async function (res) {
          var text = await res.text();
          var data;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (e) {
            throw new Error('Respuesta no-JSON (' + res.status + ') en ' + url + ': ' + text.substring(0, 200));
          }
          if (!res.ok) {
            var msg = (data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + res.status);
            throw new Error(url + ': ' + msg);
          }
          return data;
        });
      }

      const res = await fetch(url, options);
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        throw new Error('Respuesta no-JSON (' + res.status + ') en ' + url + ': ' + text.substring(0, 200));
      }
      if (!res.ok) {
        const msg = (data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + res.status);
        throw new Error(url + ': ' + msg);
      }
      return data;
    }

    let lastStatusErrAt = 0;

    async function refreshStatus() {
      const st = document.getElementById('st-status');
      try {
        const r = await fetchJson('/status');
        const online = r.status === 'online';
        st.textContent = online ? 'En línea' : 'Offline';
        st.classList.remove('green', 'red');
        st.classList.add(online ? 'green' : 'red');

        document.getElementById('st-mapping').textContent = (r.mappingItems !== undefined && r.mappingItems !== null) ? r.mappingItems : '—';
        document.getElementById('st-last').textContent = (r.syncState && r.syncState.lastRun)
          ? new Date(r.syncState.lastRun).toLocaleString('es-CO')
          : 'Nunca';
        const exp = (r.shopifyTokenExpiry && r.shopifyTokenExpiry !== 'pendiente')
          ? new Date(r.shopifyTokenExpiry).toLocaleTimeString('es-CO')
          : '—';
        document.getElementById('st-token').textContent = exp;
      } catch (e) {
        st.textContent = 'Offline';
        st.classList.remove('green');
        st.classList.add('red');
        document.getElementById('st-mapping').textContent = '—';
        document.getElementById('st-last').textContent = '—';
        document.getElementById('st-token').textContent = '—';
        const now = Date.now();
        if (now - lastStatusErrAt > 60000) {
          lastStatusErrAt = now;
          log('No se pudo cargar /status: ' + e.message, 'err');
        }
      }
    }

    function log(msg, type) {
      type = type || '';
      var el = document.getElementById('log');
      var line = document.createElement('div');
      line.className = type;
      line.textContent = '[' + new Date().toLocaleTimeString('es-CO') + '] ' + msg;
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
    }

    async function debugGet(endpoint) {
      log('Diagnóstico: ' + endpoint, 'info');
      try {
        const r = await fetchJson(endpoint);
        const c = (r.count !== undefined && r.count !== null) ? r.count : '?';
        log('count=' + c + ' | ' + JSON.stringify(r.sample || r).substring(0, 300), r.ok ? 'ok' : 'err');
      } catch(e) { log('Error: ' + e.message, 'err'); }
    }

    async function action(endpoint) {
      log('Llamando ' + endpoint + '...', 'info');
      try {
        if (endpoint === '/catalog/alegra/init-inventory-from-shopify') {
          const ok = confirm('IMPORTAR inventario desde Shopify hacia Alegra.\\n\\nEsto puede SOBREESCRIBIR cantidades en Alegra.\\n¿Deseas continuar?');
          if (!ok) { log('Acción cancelada por el usuario', 'info'); return; }
        }
        const r = await fetchJson(endpoint, { method: 'POST' });
        log('Respuesta: ' + JSON.stringify(r).substring(0, 400), (r && r.ok === false) ? 'err' : 'ok');
        setTimeout(refreshStatus, 1500);
      } catch(e) { log('Error: ' + e.message, 'err'); }
    }

    async function loadMapping() {
      log('Cargando mapping...', 'info');
      let data;
      try {
        data = await fetchJson('/mapping');
      } catch (e) {
        log('No se pudo cargar /mapping: ' + e.message, 'err');
        return;
      }
      var tbody = document.getElementById('mapping-body');
      var entries = [];
      for (var k in data) {
        if (Object.prototype.hasOwnProperty.call(data, k)) entries.push([k, data[k]]);
      }
      if (entries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:#444;text-align:center;padding:20px">Sin mapeos — haz clic en Reconstruir mapping</td></tr>';
        return;
      }
      var html = '';
      for (var i = 0; i < entries.length; i++) {
        var id = entries[i][0];
        var e = entries[i][1] || {};
        var targets = Array.isArray(e.targets) ? e.targets : [];
        var tCount = targets.length || (e.shopifyVariantId ? 1 : 0);
        var firstTargetName = (targets[0] && targets[0].name) ? targets[0].name : null;
        var shopName = (e.shopifyName || firstTargetName || '—') + (tCount > 1 ? (' (+' + (tCount - 1) + ')') : '');
        html += '<tr>'
          + '<td style="color:#555">' + id + '</td>'
          + '<td>' + (e.alegraName || '—') + '</td>'
          + '<td>' + shopName + '</td>'
          + '<td style="color:#c9a96e88">' + (e.sku || '—') + '</td>'
          + '<td><span class="badge ' + (e.seasonal ? 'seasonal' : 'permanent') + '">' + (e.seasonal ? 'Temporada' : 'Permanente') + '</span></td>'
          + '</tr>';
      }
      tbody.innerHTML = html;
      log(entries.length + ' productos en la tabla de mapping', 'ok');
    }

    async function forceSetInventory() {
      var sku = document.getElementById('force-sku').value;
      var quantity = Number(document.getElementById('force-qty').value);
      if (!sku || !isFinite(quantity)) {
        log('SKU y cantidad son requeridos', 'err');
        return;
      }
      const ok = confirm('Esto FORZARÁ el inventario para ese SKU en Alegra y en Shopify (location configurada).\\n\\n¿Deseas continuar?');
      if (!ok) { log('Acción cancelada por el usuario', 'info'); return; }
      log('Forzando SKU ' + sku + ' → ' + quantity + ' en Alegra + Shopify...', 'info');
      try {
        const r = await fetchJson('/inventory/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku, quantity })
        });
        log('Respuesta: ' + JSON.stringify(r).substring(0, 300), r.ok ? 'ok' : 'err');
      } catch (e) {
        log('Error: ' + e.message, 'err');
      }
    }

    // Registrar errores JS en el log para que el panel no quede “silencioso”.
    window.onerror = function (message, source, lineno, colno) {
      try {
        log('Error JS: ' + message + ' (' + (source || '') + ':' + lineno + ':' + colno + ')', 'err');
      } catch (e) {}
    };

    refreshStatus().catch(function () {});
    setInterval(function () { refreshStatus().catch(function () {}); }, 15000);
  </script>
</body>
</html>`);
});
