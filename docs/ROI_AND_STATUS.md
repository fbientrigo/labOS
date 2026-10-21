# ROI, Estado Técnico y Prioridades de LabOS

**Fecha de referencia:** 2026-10-21
**Rama base:** `main` (integración local de `feature/session-note`)
**Idioma del documento:** Español

---

## 1. Resumen Ejecutivo y Distinción de Ramas

Este documento establece la priorización técnica de LabOS por Retorno de Inversión (ROI = Impacto / Esfuerzo), documenta el estado real de la arquitectura combinada y define con precisión el estado de los archivos y ramas tras la decisión explícita de incorporar `feature/session-note` en `main`.

### Estado de Ramas y Árbol de Trabajo (Working Tree)
- **`origin/main` (HEAD actual: `1b07332`)**: Rama principal remota. Contiene la base de SQLite (`labos.db`), reportes con soporte No-AI, registro de dispositivos y vistas básicas de Obsidian.
- **`feature/session-note` (último commit: `f6e344b`)**: Rama donde se originó el concepto de Session Notes, el informe de campo (`docs/FIELD_TEST_2026-10.md`), el borrador de setup con puertos y el fingerprinting de checkpoints.
- **`main` local**: Contiene la integración combinada y sus correcciones como un commit local. No se ha publicado en un remoto. Incluye:
  1. Módulos TypeScript de notas, borradores, setup, shorthand y fingerprint junto a sus suites de test.
  2. Ajustes técnicos críticos de concurrencia y robustez en Python (`cli.py`, `logbook.py`, `resources.py` con CAS atómico en `sync-entries`, validación transaccional en `use`/`remove` de dispositivos y soporte de `--base-event-id` en setups).
  3. Modificaciones en `obsidian/src/view.ts` para borradores con ámbito (`scoped_drafts`), previsualización CAS y gestión de notas conectadas.
- **Base para Worktrees y Nuevos Agentes**: La integración está versionada en `main` local y puede usarse como `HEAD` al crear worktrees para ensayos. Aún no se ha publicado; un clon desde el remoto seguirá usando la versión anterior hasta publicar el commit.
- **Carácter de la Evidencia Histórica**: El informe `docs/FIELD_TEST_2026-10.md` refleja la experiencia de uso real en un periodo de 11 días de desarrollo; es una evidencia histórica e intención de diseño, **no una medición del vault actual**. Asimismo, los tests reflejan el cumplimiento automatizado del código (`pytest` y `node --test`), sin asumir validación interactiva en vivo dentro de Obsidian.

---

## 2. Tabla de Prioridades por Retorno de Inversión (ROI)

La priorización se basa en el principio de `AGENTS.md`: **"Resolver problemas observados en el laboratorio real antes de expandir la arquitectura"**. El 95% del contenido real generado por los investigadores reside en notas Markdown libres; por tanto, las características que conectan las notas con el ledger de evidencia ofrecen el máximo retorno.

| # | Iniciativa / Problema Observado | Impacto | Esfuerzo | ROI | Estado Actual | Criterio de Éxito Observable |
|---|---|---|---|---|---|---|
| **1** | **Session Notes (`Connect note`, `New entry`, `Sync note`)**<br>El 95% del contenido vive en Markdown libre; escribir horas a mano ("4:30pm") y copiar manualmente al ledger genera fricción extrema. | **Muy Alto** | **Medio** | **Muy Alto** | **Implementado**<br>(Probado en tests unitarios) | El usuario trabaja en sus notas normales; `New entry` inserta callouts con hora aproximada e ID oculto; `Sync note` extrae revisiones sin duplicar eventos. >80% de días de trabajo dejan rastro sin salir del editor. |
| **2** | **Borradores con Ámbito (`scoped_drafts`)**<br>Cambiar de pestaña o de día borraba notas a medio escribir o imágenes pegadas pendientes de guardar. | **Alto** | **Bajo** | **Muy Alto** | **Implementado**<br>(Probado en tests unitarios) | El texto no guardado y las imágenes pegadas se conservan al navegar entre días, sesiones o pestañas, y se limpian estrictamente tras un guardado exitoso. |
| **3** | **Sincronización CAS con Previsualización Atómica (`sync-entries`)**<br>Riesgo de condiciones de carrera al editar notas externamente mientras se sincroniza; riesgo de sobrescritura silenciosa. | **Alto** | **Medio** | **Alto** | **Implementado**<br>(Probado en tests unitarios) | `labos sync-entries` compara contra un baseline JSON. Si una sola entrada cambió en el archivo durante la revisión, el lote completo se rechaza atómicamente sin mutar SQLite. |
| **4** | **Transacciones Atómicas de Hardware (`setup set --base-event-id`, `use`/`remove`)**<br>Arrastrar tarjetas en el canvas generaba múltiples eventos espurios (8 eventos en 3 min) y desincronizaba recursos activos. | **Alto** | **Medio** | **Alto** | **Implementado**<br>(Probado en tests unitarios) | Edición en memoria (Draft-then-commit). `Commit setup` emite exactamente 1 evento `setup_snapshot` en la misma transacción SQLite que los cambios de recursos; rechaza commits si el estado base cambió. |
| **5** | **Fingerprinting SHA-256 en Checkpoints Working/Broken**<br>El usuario registraba hashes a mano en notas (`main.c`, ELF, bitstream) para saber qué versión funcionaba. | **Alto** | **Bajo** | **Alto** | **Implementado**<br>(Probado en tests unitarios) | Al marcar `✓ Working` o `✗ Broken`, LabOS calcula y registra opcionalmente el SHA-256 de los archivos configurados en settings, sin bloquear ni duplicar archivos gigantes. |
| **6** | **Comandos Shorthand en Composer (`!ok`, `!broken`, `!m`, `#tag`)**<br>Cambiar de campo con ratón para registrar checkpoints o medidas eléctricas interrumpe la concentración de laboratorio. | **Medio** | **Bajo** | **Alto** | **Implementado**<br>(Probado en tests unitarios) | Escribir `!ok firmware listo` o `!m 120mA @VIN` en la caja de texto ejecuta directamente la acción correspondiente sin tocar controles adicionales. |
| **7** | **Modos de Reporte y Soporte No-AI (Factual, Reviewed, Rigorous)**<br>Necesidad de exportar resúmenes profesionales y reproducibles sin depender de conexión a internet ni incurrir en costos de tokens. | **Medio** | **Medio** | **Medio** | **Implementado**<br>(Probado en tests unitarios) | El modo `Factual` genera Session Record y reportes Markdown/LaTeX 100% deterministas sin invocar LLMs. Modos `Reviewed`/`Rigorous` operan como capas derivadas opcionales. |
| **8** | **Prevención de Confusión en Log Diario Gestionado (`LabOS/Logs/`)**<br>Un usuario pegó una guía de 650 líneas dentro del bloque generado de LabOS, arriesgándose a perderla al regenerar el log. | **Alto** | **Bajo** | **Muy Alto** | **Propuesto en UI_REDESIGN**<br>(Pendiente de diseño UI) | Señalización visual y aviso explícito al abrir el log gestionado para diferenciarlo de las notas de trabajo ordinarias. Cero contenido libre dentro de bloques gestionados. |
| **9** | **Rediseño de Jerarquía Note-First en UI Principal**<br>La interfaz actual presenta 4 pestañas con igual jerarquía visual, sobrecargada de controles de bajo uso (medidas, canvas) frente a la nota activa. | **Muy Alto** | **Medio** | **Alto** | **Propuesto en UI_REDESIGN**<br>(Handoff para LLMs) | Panel lateral unificado: barra compacta de sesión, acciones directas sobre la nota activa (`Connect`/`New entry`/`Sync`), Timeline legible y funciones secundarias en menú ☰. |
| **10** | **Refactorizaciones Especulativas / FastAPI / Embeddings / FTS5**<br>Tentación de añadir servidores web locales, bases de datos vectoriales o arquitecturas de microservicios sin fallo observado en Fase 0. | **Bajo / Negativo** | **Muy Alto** | **Negativo** | **Diferido**<br>(Invariante de AGENTS.md) | No implementar hasta que una deficiencia real en la práctica experimental demuestre que el almacenamiento SQLite local y archivos planos no son suficientes. |

---

## 3. Estado Factual de la Arquitectura e Invariantes

### Flujo Natural de Uso y Qué Pasa con las Notas
1. **Preparar una vez**: instala el plugin en `.obsidian/plugins/labos-obsidian`, configura el ejecutable `labos` y el directorio local de datos. La bóveda y el ledger pueden estar desconectados; el plugin no exige una sesión para capturar una nota.
2. **Al empezar trabajo estructurado**: desde `Logs`, inicia una sesión indicando proyecto y directorio de trabajo. La sesión guarda el contexto Git observado y su setup inicial. Si solo se quiere apuntar una observación, se puede usar la caja rápida sin abrir sesión.
3. **Registrar mientras se trabaja**: captura texto libre con el botón principal o `Enter`; `!ok` y `!broken` crean checkpoints, `!m` crea una medición y `#tag` agrega una etiqueta. Los checkpoints Working/Broken incluyen texto opcional y fingerprint optativo. Usar y quitar dispositivos requiere una sesión activa; editar el canvas mantiene un borrador hasta `Commit setup`.
4. **Seguir escribiendo en Markdown (interacción principal con notas)**: el usuario conserva su nota normal. `Connect note` agrega identidad y asociación de sesión al frontmatter. `New entry` registra un evento vacío con ID estable y agrega un callout en la posición del cursor; la hora visible es aproximada y el texto de observación se escribe debajo. Si `copyQuickToNote` está activado, las capturas rápidas también se copian a una nota conectada; está desactivado por defecto.
5. **Sincronizar deliberadamente**: al pulsar `Sync note`, LabOS muestra una vista previa de los cambios entre el Markdown y el ledger. `Apply` compara el estado revisado dentro de una transacción y aplica el lote completo como eventos de revisión; si una entrada cambió durante la revisión, rechaza el lote y solicita revisar de nuevo. Nunca reescribe el evento crudo ni importa notas no conectadas automáticamente.
6. **Revisar y compartir**: consulta el timeline, `Session Record`, el log diario generado o reportes. El log diario es una vista derivada con región gestionada; las notas libres pertenecen a cualquier Markdown del usuario. Los reportes Factual funcionan sin IA ni red. Los modos Reviewed/Rigorous son optativos.

**Nivel de interacción con notas:** existe integración explícita y bidireccional para una nota conectada: LabOS inserta entradas identificadas y puede importar ediciones revisadas como revisiones. La captura rápida puede copiar texto si se activa una preferencia. La búsqueda/indexación de notas conectadas es local y opcional. No hay sincronización automática de cada archivo, conversión de una bóveda completa ni escaneo para asociar adjuntos; texto e imágenes se adjuntan por acción explícita.

### Motor de Persistencia y SQLite
- `~/labos-data/labos.db` es la **única fuente operativa de verdad** (modo WAL, `synchronous=FULL`, foreign keys activadas, timeout de 5 segundos).
- Los eventos son **estrictamente de sólo adición (append-only)**. Nunca se edita ni reinterpreta un evento histórico anterior.
- `exports/events.jsonl` es un artefacto derivado de exportación portátil bajo demanda (`labos export`); no se utiliza como estado en vivo.
- El importador de migraciones (`labos doctor`) valida la integridad de archivos JSONL históricos y rechaza la importación ante contradicciones con `.active-session.json`.

### Navegación y Vistas en Obsidian
- La navegación actual cuenta con cuatro pestañas operativas en `obsidian/src/view.ts`:
  1. **Logs (`today`)**: Gestión de sesión activa o inicio de sesión, acciones de notas de sesión (`Connect note`, `New entry`, `Sync note`), selector de día, filtros por etiquetas/sesión, caja rápida de notas con shorthand y línea temporal de eventos.
  2. **Setup (`setup`)**: Lienzo visual e interactivo de tarjetas de hardware con arrastre, gestión de puertos y conexiones, y botón de compromiso atómico (`Commit setup`) mediante draft local.
  3. **Devices (`devices`)**: Directorio de equipos físicos registrados (`resources.json`), visualización de perfiles de potencia aprobados y hechos verificados con proveniencia (`device_knowledge.json`).
  4. **Reports (`reports`)**: Generador de Session Records y reportes en modos Factual, Reviewed y Rigorous, con indicación de estado, auditoría y exportación ZIP.

### Empaquetado, Compatibilidad del Instalador e IDs
- El instalador automatizado (`python install.py "<vault>"`) compila el plugin y lo despliega en:
  ```text
  <Vault>/.obsidian/plugins/labos-obsidian/
  ```
- El `manifest.json` define el identificador único:
  ```json
  "id": "labos"
  ```
- **Compatibilidad con instalaciones manuales**: Para instalaciones manuales o enlaces simbólicos de desarrollo, se debe emplear la ruta `<Vault>/.obsidian/plugins/labos-obsidian/`. Si un vault contiene simultáneamente la carpeta antigua `.obsidian/plugins/labos/` y la nueva `labos-obsidian/`, Obsidian experimentará colisiones de ID de plugin. Debe eliminarse la carpeta obsoleta.

### Integración de Notas de Sesión y Borradores
- **Identidad estable por frontmatter**: Las notas ordinarias conectadas incorporan en sus propiedades `labos-id` y `labos-sessions`. La vinculación es independiente de la ruta del archivo; renombrar o mover la nota en el vault no rompe la relación.
- **Entradas mediante ID oculto**: `New entry` inserta callouts con hora redondeada a 5 minutos (ej. `> [!labos] ~14:25`) y un comentario HTML `%%labos:<event-id>%%` en la cabecera. La sincronización usa ese ID estable, nunca la hora visible.
- **Aislamiento de borradores (`scoped_drafts.ts`)**: Los textos en edición e imágenes pegadas residen en memoria categorizados por ámbito (`session:<id>` o `day:<fecha>`). Un fallo de red o error de validación preserva el contenido íntegro en la interfaz.

### Invariantes de Confianza y Reglas de Guardia
1. **Sin Git Automático**: LabOS inspecciona el estado de Git (`git rev-parse HEAD`, `git status`) de forma estrictamente observacional durante checkpoints e inicios de sesión. Jamás realiza `commit`, `push` ni modifica repositorios del usuario.
2. **Sin Monitorización Pasiva del Sistema**: No existen daemons vigilando el sistema de archivos ni rastreando carpetas completas. La asociación de archivos es explícita (`labos attach` o enlaces de nota).
3. **Sin Suposición de Estado Físico**: La ausencia de cambios registrados en un dispositivo no se interpreta como garantía de que el estado físico permanezca inalterado. El conocimiento físico (`device_knowledge.json`) requiere aprobación humana explícita.
4. **Independencia de Red e Inteligencia Artificial**: La totalidad del registro de evidencia, consultas temporales, exportaciones y sincronizaciones de notas opera sin conexión de red y sin modelos de lenguaje.
