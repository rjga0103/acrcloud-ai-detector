# ACRCloud AI Detector

App local (una sola máquina, sin dependencias npm) para analizar **por lote** si una canción es
generada por IA usando **ACRCloud AI Music Detection**, con cola, progreso, resultado en porcentaje,
fuente probable (Suno, Udio, ElevenLabs…) y exportación a CSV.

## 1. Qué hace

- Arrastras **muchas canciones** (MP3, WAV, FLAC, M4A, OGG, MP4…).
- Cada archivo se sube a ACRCloud (S3 con URL prefirmada), se encola y se analiza con concurrencia configurable.
- Se consulta el resultado hasta que ACRCloud termina y se calcula:
  - **Probabilidad IA** (0–100 %), ponderada por duración y stems.
  - **Predicción binaria**: `ai_generated` si `ai_probability >= 50 %`, si no `human`.
  - **Fuente probable** (Suno, Udio, Sonauto/Treblo, Mureka, Riffusion, Seedmusic, Minimax, ElevenLabs, Lyria, Boomy, Humano).
  - Desglose por **stem** (voz / acompañamiento / original), **fuentes** y **segmentos**.
- Cola persistente (sobrevive reinicios), reintentos, cancelar, borrar, buscador, filtros y **CSV**.
- **Un solo contenedor de File Scanning**, reutilizado entre lotes y reinicios. Evita el error
  `Your containers exceeds limits` de los planes con cupo pequeño.

## 2. Cómo se usa

1. Doble clic en `Iniciar app.bat` (o `node server.js`).
2. Abre <http://127.0.0.1:8787>.
3. **Ajustes**:
   - **API token** (Bearer): Consola ACRCloud → *Account* → *Developer* → crear token.
     <https://console.acrcloud.com/account#/developer>
   - **Región**: la de tu proyecto (`eu-west-1`, `us-west-2`, `ap-southeast-1`).
   - **Engine**: `5` (AI Music Detection, recomendado) o `1` (fingerprinting + IA).
   - **Buckets**: id o nombre del bucket del proyecto, separados por coma (la API lo exige).
4. Suelta archivos. Si "Encolar automáticamente" está activo, empiezan solos.
5. Pulsa una fila para ver detalle. Botón **CSV** para exportar.

Sin token la app funciona en **modo demo** (resultados simulados) para probar la interfaz.

## 3. Cómo funciona la API (resumen de la documentación)

La detección de IA **no** está en la API clásica `/v1/identify` (esa devuelve huella musical y no
incluye `ai_detection`). Está en **Console API v2 → File Scanning**:

| Paso | Llamada |
| --- | --- |
| 1. Crear contenedor | `POST https://api-v2.acrcloud.com/api/fs-containers` con `engine: 5`, `region`, `audio_type`, `buckets`, `policy.ai_detection: 1`. Se crea **una vez** y se reutiliza (se busca por nombre/región/engine). |
| 2. URL prefirmada | `GET https://api-{region}.acrcloud.com/api/fs-containers/{id}/presigned-upload?filename=…` |
| 3. Subir a S3 | `PUT {presigned_url}` sin cabecera Authorization |
| 4. Avisar a ACRCloud | `POST …/api/fs-containers/{id}/files` con `{data_type:"audio", key, filename}` |
| 5. Consultar | `GET …/api/fs-containers/{id}/files/{file_id}` → `data[0].state` (0 procesando, 1 listo, -1 sin resultados, -2/-3 error) |
| 6. Resultado | `data[0].results.ai_detection[]` con `ai_probability`, `prediction`, `likely_source`, `source_probabilities`, `stems`, `segments` |

Todos los endpoints llevan `Authorization: Bearer <token>` (excepto el PUT a S3).

Reglas de negocio documentadas:

- Umbral oficial **50 %** para decidir `ai_generated` vs `human`.
- **Máximo 15 minutos (900 s)** por archivo; hay que recortar o dividir.
- El resultado es **probabilístico**, no prueba definitiva de autoría.

Fuentes:

- <https://docs.acrcloud.com/reference/console-api/file-scanning>
- <https://docs.acrcloud.com/reference/console-api/file-scanning/file-scanning>
- <https://docs.acrcloud.com/reference/console-api/file-scanning/metadata/ai-music-detection>
- <https://docs.acrcloud.com/reference/console-api/accesstoken>
- <https://docs.acrcloud.com/faq/ai-music-detection>

## 4. Cómo se calcula el porcentaje

1. Se recogen todos los bloques `ai_detection` de la respuesta (a cualquier profundidad).
2. Si hay varios stems se prioriza `original`; si no existe, se usan todos.
3. Si el bloque trae `segments`, se pondera `ai_probability` por duración de cada segmento.
4. El total se pondera por duración de cada stem.
5. `humanProbability = 100 - aiProbability`; confianza = distancia al 50 %.

### Cuota y detecciones restantes

ACRCloud **no expone la cuota restante** en su API de File Scanning. Comprobado contra la cuenta real:

| Endpoint | Estado | Devuelve |
| --- | --- | --- |
| `GET /api/billing/next-bill-date` | 200 | `next_bill_date`, `left_days` (sirve para el ciclo) |
| `GET /api/billing/preferences` | 200 | email, uid, `billing_cycle_type` |
| `GET /api/billing/available-credits` | 200 | `{"avaliable":0}` (así, con la errata) |
| `GET /api/billing/current-bill` | 200 | `{"data":[]}` sin cargos |
| `GET /api/billing/current-bills`, `/bills`, `/due-bills` | 400 | sin permiso con token de proyecto |

Los límites de plan (minutos incluidos, contenedores) solo se ven en la consola web. Por eso la app:

1. Lleva un **ledger local** (`data/db.json` → `usage`) con los segundos que ACRCloud dice haber analizado, por día.
2. Usa la **fecha de próximo cobro** para calcular el ciclo (o el día de corte configurado). Si esa
   fecha es simplemente «hoy + 30 días» (cuentas sin suscripción), se ignora y manda el día de corte.
3. Si pones la **cuota del plan en minutos** (Ajustes), muestra consumido, restante, % y **detecciones restantes estimadas** = restante ÷ duración media.
4. El consumo no se reinicia al limpiar la lista: es histórico de facturación. Borrar `data/db.json` lo reinicia.
5. La detección por archivo se limita a **900 s** por la propia API.

Cómo saber tu cuota real: consola ACRCloud → *Billing* / *Usage* del proyecto, o el contrato del plan.

## 5. API propia

| Método | Ruta | Uso |
| --- | --- | --- |
| GET | `/api/state` | Config saneada, archivos, contadores y **consumo del ciclo** |
| POST | `/api/config` | Guardar token/región/engine/buckets/paralelo |
| POST | `/api/test` | Validar token |
| POST | `/api/upload?name=&batch=` | Subir bytes crudos de un archivo |
| POST | `/api/queue` | Encolar pendientes (`{ids?}`) |
| POST | `/api/retry` | Reintentar fallidos |
| POST | `/api/cancel` | Cancelar `{ids}` |
| DELETE | `/api/files/:id` | Quitar archivo y copia local |
| POST | `/api/clear` | Limpiar terminados (`{mode:"all"}` para todo) |
| POST | `/api/container/reset` | Borrar contenedores remotos creados |
| GET | `/api/export.csv` | Descargar resultados |

## 6. Estructura

```
server.js            HTTP, rutas y subida en streaming
lib/config.js        configuración (data/config.json)
lib/store.js         persistencia de archivos y contenedores (data/db.json)
lib/acr.js           cliente ACRCloud (contenedores, presigned, resultados)
lib/pipeline.js      cola, concurrencia, polling, modo demo
lib/parse.js         normalización de ai_detection, resumen y CSV
public/              interfaz (HTML/CSS/JS sin build)
tests/               pruebas del parser y flujo completo contra un ACRCloud falso
```

## 7. Configuración (`data/config.json`)

```json
{
  "token": "",
  "region": "eu-west-1",
  "engine": 5,
  "buckets": [1],
  "concurrency": 3,
  "pollMs": 2500,
  "timeoutMs": 600000,
  "demo": false,
  "autoQueue": true,
  "planQuotaMinutes": 120,
  "cycleDay": 1
}
```

También puedes usar `ACRCLOUD_TOKEN` como variable de entorno. `PORT` y `DATA_DIR` son configurables.

## 8. Pruebas

```bash
node --test "tests/*.test.js"
```

Las pruebas levantan un ACRCloud simulado y recorren contenedor → prefirmado → metadata → polling →
resumen, además de casos del parser (stems, segmentos, umbral 50 %, CSV).

## 9. Límites y avisos

- **Credenciales fuera del repositorio.** El token y los audios viven en `data/`, excluido por
  `.gitignore`. No hay claves en el código ni en el historial. Si alguna vez publicas el proyecto,
  revisa `git log -p` antes.
- ACRCloud cobra por tiempo/proyecto: revisa tu plan antes de lotes grandes.
- Archivos de más de 900 s deben dividirse; la app mostrará el error de la API.
- **Límite de contenedores.** La app usa un contenedor fijo (`ACRCloud AI Detector`) por combinación
  región + engine y lo reutiliza. Si aun así aparece `Your containers exceeds limits`, ve a
  **Ajustes → Borrar contenedores remotos**: elimina los de esta app y, si quedan ajenos, ofrece
  borrarlos también. La cola se recupera sola: si el plan está lleno, purga lo suyo y reintenta una vez.
- **Capacidad de almacenamiento de File Scanning (por región).** Si el último paso de la subida
  (`POST …/files`) responde `Your container's size exceeds limits`, incluso con un contenedor vacío,
  esa **región** se quedó sin capacidad. Comprobado en la cuenta real: `eu-west-1` bloqueaba y el
  mismo archivo funcionó en `us-west-2` con un contenedor nuevo. Borrar archivos o rotar contenedor
  **no** lo libera. Solución: cambia la región en Ajustes o amplía el plan.
- **La página de límites engaña.** `File Bucket Capacity Limit 300 Min` es capacidad de *buckets*
  (huellas del catálogo), no de análisis. Los límites reales están en `GET /api/limits/current`:
  `fs: {containers: 10, size: 300}` y `GET /api/users/:uid` → `limit_type: FreeTrial`, `left_days`.
  `fs.size` se consume por tamaño de audio subido (36 min de WAV ≈ 380 MB), no por minutos.
- Un token caducado devuelve 401: genera uno nuevo y pégalo en Ajustes.
- Los resultados son orientativos. No los uses como única prueba en decisiones legales o de moderación.
