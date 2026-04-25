// ============================================================
// SHOPIFY AUTH — Manejo automático de tokens (expiran c/24h)
// Compatible con el nuevo flujo de Dev Dashboard 2026
// ============================================================

const fetch = require('node-fetch');

class ShopifyTokenManager {
  constructor(store, clientId, clientSecret) {
    this.store       = store;
    this.clientId    = clientId;
    this.clientSecret = clientSecret;
    this.accessToken  = null;
    this.expiresAt    = null;
  }

  // Obtiene un token nuevo usando client_credentials grant
  async fetchNewToken() {
    console.log('[AUTH] Obteniendo nuevo token de Shopify...');
    const res = await fetch(
      `https://${this.store}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type:    'client_credentials',
          client_id:     this.clientId,
          client_secret: this.clientSecret
        })
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`No se pudo obtener token de Shopify: ${res.status} — ${body}`);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    // Guardamos expiración con 5 minutos de margen de seguridad
    const expiresInMs = ((data.expires_in || 86400) - 300) * 1000;
    this.expiresAt = Date.now() + expiresInMs;

    const expiresDate = new Date(this.expiresAt).toLocaleTimeString();
    console.log(`[AUTH] Token obtenido. Válido hasta las ${expiresDate}`);
    return this.accessToken;
  }

  // Retorna el token vigente, o renueva si está por vencer
  async getToken() {
    const needsRefresh = !this.accessToken || Date.now() >= this.expiresAt;
    if (needsRefresh) await this.fetchNewToken();
    return this.accessToken;
  }

  // Wrapper para llamadas a la API de Shopify con renovación automática
  async graphQL(query, variables = {}) {
    const token = await this.getToken();
    const res = await fetch(
      `https://${this.store}/admin/api/2024-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, variables })
      }
    );

    // Si el token expiró en medio de la operación, lo renovamos una vez
    if (res.status === 401) {
      console.log('[AUTH] Token expirado en medio de la operación. Renovando...');
      await this.fetchNewToken();
      return this.graphQL(query, variables); // reintento único
    }

    const data = await res.json();
    if (data.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(data.errors)}`);
    return data.data;
  }
}

module.exports = ShopifyTokenManager;
