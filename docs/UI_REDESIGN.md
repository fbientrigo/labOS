# Rediseño de UI de LabOS, Modularización y Guía de Ensayos para LLMs

**Fecha:** 2026-10-21
**Línea base de código:** Integración local en `main`
**Idioma:** Español
**Propósito:** Proponer una experiencia de usuario natural y de baja fricción basada en datos de uso real, documentar la estructura modular del código actual y suministrar un protocolo estricto para que otros modelos LLM evalúen variantes sin romper la integridad del proyecto.

---

## 1. Fundamentos y Diagnóstico de Campo (Evidencia Real)

### 1.1. Lo que revelan los datos de campo (`docs/FIELD_TEST_2026-10.md`)
Durante la prueba de 11 días de desarrollo activo de LabOS se recopilaron métricas objetivas del ledger SQLite (`labos.db`) y de las 23 notas generadas en el vault:
- **1 sesión abierta durante 10 días seguidos**: El concepto de "abrir sesión al llegar y cerrarla al salir" no se adapta al ritmo real del laboratorio, donde el trabajo se interrumpe y reanuda constantemente.
- **Solo 4 de 11 días tuvieron entradas directas en LabOS**: En 7 días hubo trabajo experimental intenso pero quedó registrado exclusivamente en notas ordinarias de Obsidian.
- **23 notas en el vault (~150 KB, 25 imágenes)** frente a **0 mediciones (`measurement`), 0 tags y 0 revisiones**: El **95% del contenido real vive en Markdown libre**. Los selectores de tags, campos de medición eléctrica y formularios especializados tuvieron un uso prácticamente nulo.
- **8 guardados de setup en 3 minutos**: El lienzo de hardware guardaba eventos cada vez que se movía una tarjeta, generando ruido en la historia sin cambios reales de conexionado.
- **Horas escritas a mano repetidamente**: El usuario escribió manualmente "4:30pm", "8pm", "1:00 am", "14:23" al menos 5 veces.
- **Confusión crítica con el Log Diario Gestionado**: Un usuario pegó una guía técnica de 650 líneas dentro del bloque `<!-- labos-entries-start -->` en `LabOS/Logs/2026-10-08.md`. De haber regenerado el log, LabOS habría borrado ese contenido.

### 1.2. Diagnóstico del problema de UX
> **Cambiar colores, fuentes o márgenes no soluciona el problema de fondo.**
> La interfaz actual se siente "clunky, vieja y poco intuitiva" porque fue diseñada como un panel de control con cuatro pestañas de igual jerarquía (`Logs / Setup / Devices / Reports`), cuando en la práctica el usuario está con el 95% de su atención en el editor de notas de Obsidian.
> El desafío central de UX es **hacer que escribir notas ordinarias en Obsidian deje evidencia durable de forma natural y sin fricción**.

### 1.3. Filosofía de diseño (`AGENTS.md`)
- **Adaptarse a las notas del usuario; no reemplazarlas.**
- **Dos modos de captura, un solo registro:** La caja rápida (tiempo automático) y la nota Markdown conectada (texto libre, capturas de pantalla, código) alimentan la misma evidencia.
- **LabOS es dueño del tiempo y la identidad, no el usuario.** El usuario nunca debe escribir timestamps; LabOS inserta la hora redondeada a 5 minutos (`~14:25`) y el ID del evento en un comentario HTML oculto de la cabecera (`%%labos:<event-id>%%`).
- **Conexiones bidireccionales resistentes a movimientos:** La vinculación reside en `labos-id` en el frontmatter de la nota, no en su ruta.
- **Compacto primero, profundo bajo demanda:** La vista principal muestra exclusivamente lo que se usa de forma continua; las herramientas secundarias viven en el menú `☰`.
- **Reutilizar Obsidian:** Aprovechar frontmatter, callouts nativos y backlinks en lugar de inventar frameworks o parsers complejos.

---

## 2. Propuesta de Experiencia Principal Unificada ("Note-First")

En lugar de obligar al investigador a cambiar entre cuatro pestañas para interactuar con LabOS, se propone una **única pantalla principal vertical** optimizada para el panel lateral de Obsidian (ancho estrecho típico: 280–320 px), con herramientas secundarias bajo demanda.

### 2.1. Anatomía del Panel Lateral Principal

```text
┌───────────────────────────────────────────────┐
│ [●] LabOS · tgc-debug (2h 15m)       [End] [☰]│  <-- 1. Barra de Sesión Compacta
├───────────────────────────────────────────────┤
│ [✓] 2026-10-21-trigger-tests.md               │  <-- 2. Barra de Nota Activa
│     [+ Entrada (~11:25)]   [Sincronizar (CAS)]│
├───────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────┐ │  <-- 3. Captura Rápida
│ │ Nota rápida... (!ok, !broken, #tag, !m)   │ │
│ └───────────────────────────────────────────┘ │
│ [✓ Working]   [✗ Broken]      [Capturar (↵)]  │
├───────────────────────────────────────────────┤
│ ── Actividad de hoy (4 eventos) ───────────── │  <-- 4. Timeline Reciente
│ 11:20 [✓] working: firmware v2 timing OK     │
│       └─ git: a1b2c3d · hash: f7e8d9...       │
│ 10:45 [note] DMA buffer allocated @ 0x8000    │
│       └─ nota: [[2026-10-21-trigger-tests]]   │
│ 09:10 [start] tgc-debug · Zynq #2             │
└───────────────────────────────────────────────┘
```

### 2.2. Componentes y Comportamiento de la Pantalla Principal

1. **Barra de Sesión y Contexto Compacta (Cabecera)**:
   - *Con sesión activa*: Indicador sutil activo (`●`), nombre del proyecto (`tgc-debug`), tiempo transcurrido aproximado, botón discreto `[End]` con confirmación rápida y botón de menú contextual `[☰]`.
   - *Sin sesión activa*: Botón destacado `[Iniciar trabajo]` que despliega proyecto y directorio sin cambiar de pantalla. Acciones de captura rápida funcionan en modo sessionless sin bloquear al usuario.
2. **Barra de Acción de Nota Activa (Core Note Operations)**:
   - Detecta automáticamente el archivo abierto en el workspace de Obsidian.
   - *Si la nota ya está conectada*: Muestra nombre del archivo con badge verde `[✓]`, botón `[+ Entrada (~HH:MM)]` (atajo para insertar callout en la posición del cursor) y botón `[Sincronizar]` (con indicador si hay cambios en el archivo no incorporados al ledger).
   - *Si la nota no está conectada*: Muestra botón `[Conectar esta nota]` y enlace a `[Crear nota de sesión]`.
3. **Caja de Captura Inmediata (Quick Box) y Checkpoints**:
   - Área de texto compacta (1–2 líneas que se expanden al escribir).
   - Soporte directo de comandos *shorthand* (`#etiqueta`, `!ok mensaje`, `!broken mensaje`, `!m 120mA @VIN`).
   - Botones de un clic `[✓ Working]` y `[✗ Broken]`: Destacados visualmente para registrar checkpoints sin fricción mental, calculando de inmediato el fingerprint SHA-256 de los archivos de trabajo configurados.
   - Atajo de teclado: `Enter` envía la nota; `Shift + Enter` introduce salto de línea.
4. **Timeline Reciente Legible**:
   - Muestra las entradas de la jornada o sesión actual en orden cronológico inverso.
   - Cada entrada muestra hora, icono de estado (`✓`, `✗`, nota, imagen), texto legible, hashes calculados y enlaces directos (`[[nota]]`) para saltar al fragmento en el vault.
5. **Cajón de Herramientas Secundarias (Menú `☰`)**:
   - Para no sobrecargar el 95% del uso diario, las funciones operativas avanzadas se concentran en el menú `☰`:
     - *Lienzo de Hardware (Setup Canvas)*: Modal o vista expandida para editar tarjetas y conexiones solo cuando el montaje físico cambia.
     - *Inventario de Equipos (Devices)*: Para dar de alta hardware o registrar perfiles de potencia.
     - *Generación de Reportes*: Asistente para producir Session Records o reportes Factual / AI.
     - *Abrir Log Diario Gestionado*: Vista de consulta del archivo `LabOS/Logs/YYYY-MM-DD.md`.
     - *Diagnóstico (`labos doctor`)*: Chequeo de salud del entorno.

---

## 3. Matriz de Estados, Acciones y Clarificación Conceptual

### 3.1. Clarificación Conceptual: Nota vs Log Diario vs Reporte

| Tipo de Documento | Ubicación Típica | Naturaleza y Propiedad | Reglas de Interacción de la UI |
|---|---|---|---|
| **Nota de Usuario (Session Note)** | Cualquier carpeta del vault (ej. `Proyectos/TGC/`) | **Propiedad 100% del usuario.** Texto libre, capturas de pantalla, tablas, código. Conectada mediante `labos-id` en frontmatter. | La UI la asiste mediante `New entry` (callout) y `Sync note` (CAS). LabOS jamás borra contenido no gestionado. |
| **Log Diario Gestionado** | `LabOS/Logs/YYYY-MM-DD.md` | **Vista derivada generada por LabOS.** Contiene bloques delimitados `<!-- labos-entries-start -->`. | **No es un cuaderno de notas libre.** La UI debe mostrar una advertencia visible para evitar que el usuario pegue guías o notas dentro del bloque autogenerado. |
| **Reporte Formal** | `LabOS/Reports/<run>/` | **Artefacto inmutable y auditable.** Incluye `session_record.md`, `generated.md`, `main.tex` y copia editable `report.md`. | Se genera bajo demanda. Posee hash de evidencia (`evidence_sha256`) y proveniencia estricta. |

### 3.2. Estados del Sistema en la Interfaz

- **`Loading`**: Deshabilitación temporal de botones con texto atenuado (`Guardando…`, `Sincronizando…`). No debe parpadear la pantalla completa.
- **`Error`**: Banner no intrusivo en la parte superior del panel con el mensaje concreto devuelto por el CLI y botón de reintento. El contenido escrito en la caja de texto o en la nota se preserva íntegro en memoria (`scoped_drafts`).
- **`Saved`**: Micro-confirmación visual (badge sutil o notificación breve de Obsidian) que desaparece en 2 segundos.
- **`Pending-Sync`**: Cuando el hash de la nota conectada difiere del último baseline sincronizado, el botón `[Sincronizar]` muestra un punto indicador de cambios pendientes.
- **`Sessionless`**: Permite capturar notas y adjuntos sin obligar a crear una sesión formal. El selector de proyecto queda disponible pero no bloquea la escritura.
- **`Historical Day`**: Al navegar a días anteriores, los controles de captura se adaptan exigiendo hora explícita para no falsear la cronología de eventos.

---

## 4. Mapa de Modularización del Código (`obsidian/src/`)

### 4.1. Diagnóstico del Estado Actual
Actualmente, la lógica de presentación de la interfaz se concentra en un único archivo monolítico:
- **`obsidian/src/view.ts` (~2239 líneas)**: Contiene la clase `LabOSView`. Agrupa en métodos privados la gestión del ciclo de vida (`refresh`, `getState`), cabecera (`renderHeader`), navegación en 4 pestañas (`renderNavigation`), vista diaria (`renderToday`, `renderActiveSession`, `renderNotes`, `renderComposer`), editor visual de hardware (`renderSetup`, `drawSetup`), vista de dispositivos (`renderDevices`), vista de reportes (`renderReports`, `renderCoverage`) y asistentes de acción (`act`, `captureCheckpoint`, etc.).
- **Aclaración honesta:** Aunque existen métodos con nombres delimitados, **siguen siendo métodos privados acoplados dentro de una misma clase**, no componentes independientes ni módulos desacoplados.

### 4.2. Módulos Auxiliares Desacoplados (Precedentes Establecidos)
El repositorio ya cuenta con una arquitectura de módulos puros y desacoplados que deben servir de modelo:
1. **`device_knowledge.ts`**: Precedente de extracción limpia. Contiene renderizadores específicos para conocimiento de hardware y perfiles de potencia con callbacks fuertemente tipados.
2. **`notes.ts`, `session_note.ts`, `note_index.ts`**: Módulos recién incorporados en el working tree para la manipulación de notas ordinarias, análisis de callouts por ID de evento oculto en la cabecera y mantenimiento del índice local sin escaneos globales del vault.
3. **`setup_draft.ts`**: Modelo de datos puro del borrador de hardware en memoria (tarjetas, conexiones, rebase y detección de conflictos con CAS).
4. **`shorthand.ts`**: Parser puro para sintaxis de atajos (`!ok`, `!broken`, `!m`, `#tag`), testeable en Node.js sin Obsidian.
5. **`fingerprint.ts`**: Cálculo rápido de hashes SHA-256 de archivos de trabajo configurados.
6. **`scoped_drafts.ts`**: Almacén en memoria de borradores y adjuntos indexados por ámbito (`session:<id>`, `day:<fecha>`).
7. **`backend.ts` y `types.ts`**: Adaptador CLI tipado y contrato formal del backend.
8. **`styles.css`**: Hoja de estilo global consciente de temas (light/dark mode).

---

## 5. Protocolo de Ensayos para Otros Modelos LLM

Para permitir que otros modelos de lenguaje exploren y propongan variantes de la interfaz sin introducir regresiones ni sobreingeniería, se establecen tres experimentos progresivos y acotados.

### Principio Rector
> **No realizar refactorizaciones estructurales gigantes de componentes antes de que el diseño visual y de interacción haya sido validado por un usuario real.**

---

### Experimento 1: Variante Visual Solo-CSS (`styles.css`)

- **Objetivo**: Hacer que la interfaz se sienta moderna, compacta y menos tosca manipulando exclusivamente la hoja de estilos, sin modificar código TypeScript.
- **Archivos permitidos**: Únicamente `obsidian/styles.css`.
- **Archivos estrictamente prohibidos**: Cualquier archivo `.ts`, archivos Python o archivos en `docs/`.
- **Criterios de parada**: El panel se visualiza correctamente en tema claro y oscuro, ancho de 300px, badges de estado legibles y jerarquía visual nítida.

#### Prompt Copy-Paste para LLM — Experimento 1
```text
Actúa como desarrollador frontend especializado en Obsidian CSS.
CONTEXTO:
- Repositorio LabOS (rama main, working-tree actual).
- Tarea: Mejorar la apariencia visual y reducir la sensación de interfaz tosca/antigua del panel lateral de LabOS.
REGLAS ESTRICTAS:
1. Tu propiedad está LIMITADA a un único archivo: `obsidian/styles.css`. No toques ningún archivo .ts, .py ni documentación.
2. No realices commits ni push en git.
3. No instales dependencias externas, frameworks CSS ni fuentes remotas.
4. Diseña para un panel lateral estrecho (280px - 320px) respetando las variables de tema nativas de Obsidian (--background-primary, --text-normal, --interactive-accent, etc.).
5. Mejora: densidad visual de la cabecera, visibilidad de los botones de checkpoint (Working en verde discreto, Broken en rojo apagado), legibilidad del timeline y diferenciación de notas conectadas.
ENTREGABLE:
El contenido actualizado de `obsidian/styles.css` y una breve justificación de las mejoras de densidad aplicadas.
```

---

### Experimento 2: Reorganización de Jerarquía en Pantalla Principal (`view.ts`)

- **Objetivo**: Implementar la jerarquía "Note-First" descrita en la sección 2 reorganizando las llamadas y la estructura del DOM en `renderToday` y `renderActiveSession`, utilizando las funciones y callbacks existentes.
- **Archivos permitidos**: Únicamente `obsidian/src/view.ts`.
- **Archivos estrictamente prohibidos**: `backend.ts`, `types.ts`, `main.ts`, código Python, esquema de SQLite o semántica de eventos.
- **Criterios de parada**: La pantalla muestra primero la nota activa y sus acciones (`Connect note`, `New entry`, `Sync note`), seguidas de la caja rápida y el timeline. `npm test` y `npm run build` en `obsidian/` deben compilar con código 0.

#### Prompt Copy-Paste para LLM — Experimento 2
```text
Actúa como ingeniero de software TypeScript en el plugin de Obsidian de LabOS.
CONTEXTO:
- Repositorio LabOS en la rama main local con la integración aplicada.
- Tarea: Reorganizar la jerarquía de la pantalla principal en `obsidian/src/view.ts` para adoptar el modelo "Note-First".
REGLAS ESTRICTAS:
1. Tu propiedad está LIMITADA a: `obsidian/src/view.ts`.
2. Preserva todos los métodos existentes y sus firmas. No toques `backend.ts`, `types.ts`, ni lógica de persistencia.
3. No realices commits ni push en git. No generes llamadas a APIs de pago.
4. La pantalla de hoy/sesión activa debe priorizar:
   a) Barra de sesión compacta superior con botón End y menú ☰.
   b) Barra de acciones de la nota activa (Conectar nota, Nueva entrada ~HH:MM, Sincronizar).
   c) Caja de notas rápida con botones Working/Broken accesibles de inmediato.
   d) Timeline cronológico legible.
5. Los selectores de tags, filtros avanzados y controles de setup deben quedar replegados bajo <details> ("More options") o en el menú ☰ para no saturar la vista.
6. Ejecuta `npm run build` en obsidian/ y reporta honestamente los resultados de la compilación.
ENTREGABLE:
Diff o reemplazo contiguo en `obsidian/src/view.ts` que implemente la jerarquía respetando los contratos tipados existentes.
```

---

### Experimento 3: Extracción Modular Opcional de Renderers (Post-Diseño)

- **Objetivo**: Una vez que un diseño de UI haya sido probado y aceptado por el usuario, desacoplar los métodos privados de `view.ts` en submódulos de renderizado dedicados, siguiendo el patrón probado de `device_knowledge.ts`.
- **Archivos permitidos**: `obsidian/src/view.ts` y nuevos archivos `obsidian/src/today_renderer.ts`, `obsidian/src/setup_renderer.ts`.
- **Criterios de parada**: `view.ts` se reduce a un coordinador de eventos y estado; los renderers son funciones puras o clases de presentación con interfaces de callback tipadas; 100% de los tests unitarios pasan.

---

## 6. Gestión de Worktrees y Banco de Pruebas Común

### 6.1. Transporte del Baseline Uncommitted a Nuevos Worktrees
La integración y las correcciones están consolidadas en un commit local de `main`; un worktree nuevo creado desde ese `HEAD` tendrá la misma base completa. El remoto no se ha actualizado, así que no uses un clon remoto como baseline sin traer primero este commit.

### 6.2. Reglas de Concurrencia entre Modelos
- **Un único escritor por worktree**: Cada modelo debe trabajar en un directorio de trabajo aislado.
- **Mismo banco de datos de prueba**: Utilizar las mismas fixtures de sesión y eventos sintéticos para comparar las variantes de pantalla.

### 6.3. Rúbrica de Comparación Objetiva

| Criterio de Evaluación | Métrica Observable | Objetivo de Éxito |
|---|---|---|
| **1. Clics para reanudar trabajo** | Número de interacciones para conectar nota o capturar nota | <= 1 clic |
| **2. Visibilidad de Checkpoints** | Tiempo visual para encontrar `✓ Working` / `✗ Broken` | Inmediatamente visible sin scroll |
| **3. Densidad de controles** | Controles interactivos visibles simultáneamente en pantalla | Reducción de >40% frente al baseline actual |
| **4. Preservación de borradores** | Integridad del texto ante cambio de pestaña o recarga | Cero pérdidas de texto en `scoped_drafts` |
| **5. Operatividad en panel estrecho** | Comportamiento en contenedor de 300 px de ancho | Sin scroll horizontal ni solapamiento de texto |
| **6. Ergonomía de teclado** | Capacidad de registrar entradas mediante `Enter` y shorthand | Flujo completo operable sin ratón |
| **7. Seguridad de evidencia** | Verificación de que ninguna acción de UI muta eventos pasados | Cero violaciones de invariantes append-only |

*(Nota de rigor: No se debe declarar ninguna mejora de UX como "demostrada" hasta que un usuario real complete un periodo de prueba de campo con la variante seleccionada).*
