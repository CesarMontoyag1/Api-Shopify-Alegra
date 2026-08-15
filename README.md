# Este repositorio fue una versión muy alpha de lo que se construyó, no se continuara con el desarrollo de este. 
# Bagatta Sync — Middleware Alegra POS ↔ Shopify

Sincronización bidireccional de inventario entre Alegra POS (tienda física) y Shopify (tienda online).

## Cómo funciona

- **Auto-sync bidireccional (recomendado):** El servidor compara ambos catálogos por SKU cada pocos segundos y sincroniza desde la plataforma donde detecta el último cambio.
- **Altas automáticas Shopify → Alegra:** Si aparece un SKU nuevo en Shopify y no existe en Alegra, se crea automáticamente en Alegra.
- **Bajas/desactivaciones Shopify → Alegra:** Si un SKU desaparece o el producto queda archivado en Shopify, el ítem correspondiente en Alegra se desactiva automáticamente.
- **Inventario y estado:** El inventario se mantiene alineado en ambas plataformas; los botones del panel quedan como herramientas manuales de soporte.

## Instalación local (para desarrollo y pruebas)

```bash
# 1. Clona o copia la carpeta
cd bagatta-sync

# 2. Instala dependencias
npm install

# 3. Crea tu archivo de configuración
cp .env.example .env
# Abre .env y llena ALEGRA_EMAIL, ALEGRA_TOKEN, SHOPIFY_STORE, SHOPIFY_TOKEN

# 4. Inicia el servidor
npm run dev

# El servidor corre en http://localhost:3000
```

## Endpoints disponibles

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/status` | Estado del servidor, sync legacy y auto-sync bidireccional |
| POST | `/sync/now` | Ejecutar una corrida inmediata (auto-sync si está habilitado) |
| GET | `/mapping` | Ver tabla de mapeo Alegra ↔ Shopify |
| POST | `/mapping/rebuild` | Reconstruir mapping automáticamente por SKU/nombre |
| POST | `/mapping/add` | Agregar mapeo manual para producto sin SKU |
| POST | `/webhooks/shopify/order-created` | Receptor de webhooks de Shopify |

## Agregar mapeo manual (productos de temporada sin SKU)

Cuando un producto nuevo entra a la tienda y no tiene SKU estándar, puedes mapearlo manualmente:

```bash
curl -X POST http://localhost:3000/mapping/add \
  -H "Content-Type: application/json" \
  -d '{
    "alegraId": "123",
    "shopifyVariantId": "gid://shopify/ProductVariant/456789",
    "shopifyInventoryItemId": "gid://shopify/InventoryItem/987654",
    "name": "Vestido floral temporada",
    "seasonal": true
  }'
```

## Configurar el Webhook en Shopify

En el admin de Shopify ve a:
**Configuración → Notificaciones → Webhooks → Crear webhook**

- Evento: `Creación de pedido`
- Formato: `JSON`
- URL: `https://TU-SERVIDOR.railway.app/webhooks/shopify/order-created`

## Despliegue en Railway (gratis)

```bash
# Instala Railway CLI
npm install -g @railway/cli

# Login
railway login

# Crea el proyecto
railway init

# Sube las variables de entorno (una por una o desde el dashboard)
railway variables set ALEGRA_EMAIL=tu@email.com
railway variables set ALEGRA_TOKEN=tu_token
railway variables set SHOPIFY_STORE=tienda.myshopify.com
railway variables set SHOPIFY_TOKEN=shpat_xxx

# Despliega
railway up
```

## Manejo de productos sin SKU (temporada/tendencia)

Los productos de tendencia que no se reabastecen se manejan con `seasonal: true` en el mapping. El servidor los sincroniza normalmente hasta que lleguen a 0. Cuando llegan a 0, simplemente quedan agotados en Shopify sin afectar el resto del inventario.

## Estructura de archivos

```
bagatta-sync/
├── server.js      # Servidor principal con toda la lógica
├── mapping.json   # Tabla de equivalencias (se genera automáticamente)
├── .env           # Tus credenciales (NO subir a GitHub)
├── .env.example   # Plantilla de variables de entorno
├── package.json   # Dependencias
└── README.md      # Esta documentación
```

## Variables nuevas para auto-sync

En `.env`:

```dotenv
AUTO_SYNC_ENABLED=true
AUTO_SYNC_INTERVAL_MS=10000
```

- `AUTO_SYNC_ENABLED=true` habilita sincronización automática por último cambio detectado.
- `AUTO_SYNC_INTERVAL_MS` define cada cuánto se revisan cambios en ambas plataformas.

