---
date: 2026-10-08
tags: [labos, field-test]
status: reference
---

# Uso real de LabOS — 2026-09-28 a 2026-10-08

Prueba de campo: LabOS se uso en trabajo real mientras se construia. Este informe sale de la base de datos
(`~/labos-data/labos.db`, 41 eventos originales) y de las 23 notas del vault. Sin juicios sobre ti: es lo que dejaron los datos.

## Que paso (numeros)

| Dato | Valor |
|---|---|
| Sesiones LabOS | 1 (abierta 10 dias, cerrada 10-08 17:40) |
| Dias de trabajo | 11 (09-28 a 10-08) |
| Dias con alguna entrada en LabOS | 4 (09-28, 09-29, 10-05, 10-08) |
| Notas del quick box | 14 |
| Checkpoints (`good`/`bad`) | 3 |
| Cambios de setup guardados | 13 (8 de ellos en 3 minutos, el 10-04, arrastrando equipos) |
| Equipos registrados | 5 (placa, 2 Zynq, mezzanine, generador de señal) |
| Medidas (`measurement`) | 0 |
| Etiquetas (tags) | 0 |
| Correcciones (`revise`) | 0 |
| Archivos adjuntos (`attach`) | 1 (y con ruta rota, 0 bytes) |
| Reportes IA | 1 (09-30) |
| Perfiles de potencia | 1 (dia 1: 5 V, 3 A) |
| Notas en el vault | 23 + 1 plantilla, ~150 KB, 25 imagenes |

## Lo que si usaste mucho

- **Markdown largo.** Guias paso a paso, logs de consola, listas con casillas, capturas pegadas. Aqui vive el 95 % del contenido.
- **Registro de equipos y canvas de setup.** Se registraron 5 equipos y se conectaron. Sirvio para saber que Zynq se uso cuando.
- **Notas cortas con hechos duros** en el quick box (HEAD de git, resultado de sintesis y timing, pines y direcciones).

## Lo que usaste poco o nada

- **Plantilla diaria.** `2026-09-28 - Reconexion a TGC-CMS` tiene Intento / Hecho / Resultado / Evidencia, pero el 09-28 queda a medio llenar y no se vuelve a usar. Despues ganaron las notas libres.
- **Tags, measurement, revise, compare.** Cero eventos. No queda claro si faltaba saber que existen, si no hacian falta o si no se entendio para que sirven.
- **Perfil de potencia.** Se creo el primer dia. El 09-29 la placa recibio 12 V en vez de 5 V; el perfil 5 V / 3 A existia, pero ningun evento lo uso en ese momento.
- **attach.** Una sola vez; las 25 imagenes quedaron solo dentro de las notas, sin evento.
- **Cerrar la sesion.** Estuvo abierta 10 dias. Varios temas quedaron dentro de una sola sesion.

## Lo que tuviste que escribir tu y LabOS debia hacer

- Horas a mano: "4:30pm", "8pm", "1:00 am", "14:23", "Hora: 4pm". Al menos 5 veces. Es justo lo que hoy cubre `New entry` (feature nueva del 10-08).
- Hash y version del firmware: `template/prueba_versiones_tcp.md` pide SHA256 de `main.c`, del ELF, bitstream y cliente. Lo llenabas a mano. Es lo que mas ayuda a reproducir y LabOS no lo captura (adjuntar con hash es opcional).
- Un mapa "que version corre cual cosa": la `Code Ladder` V0-V5 son 1243 lineas escritas a mano.

## Lo que se rompio o confundio

| # | Que paso | Evidencia | Causa (verificada) |
|---|---|---|---|
| 1 | Guia de 650 lineas pegada dentro del bloque que genera LabOS en el log diario | `LabOS/Logs/2026-10-08.md` (ya separado) | El bloque `LabOS entries` parece una zona normal de nota. Regenerar el log lo habria borrado. |
| 2 | Nota 25 (10-05) quedo sin sesion y con hora UTC | evento 25 | En `capture`, si se da hora explicita sin elegir sesion, no hereda la sesion activa (`logbook.py`, `event_session`) |
| 3 | Nota duplicada en el mismo segundo | eventos 34 y 35 | Doble envio; no hay proteccion |
| 4 | Mismo texto como nota y como checkpoint | eventos 29 y 30 | Checkpoint pide texto; se repitio el de la nota |
| 5 | Setup de la nota 38 muestra 1 equipo; vecinas muestran 4 | evento 38 | Parece el borrador inicial (posicion 16,16). Causa no confirmada |
| 6 | 7 de 11 dias sin ninguna entrada LabOS (09-30, 10-01, 10-02, 10-03, 10-04, 10-06, 10-07) aunque hubo notas largas en el vault | `labos log` antes de la limpieza | El trabajo quedo solo en Markdown; las notas del vault no estaban conectadas a la sesion |
| 7 | Cada arrastre de un equipo en el canvas guarda un evento | eventos 11-18 | El canvas guarda en cada cambio; son ruido en la historia |
| 8 | Rutas de puerto vacias en 2 de 3 conexiones | evento 32 (`from_port` y `to_port` vacios) | No esta claro para que sirve el puerto |
| 9 | Ruta del adjunto apunta a un archivo que se movio | evento 5 | Las rutas se guardan absolutas; se arreglo con `asset rename` |
| 10 | Serie de la Zynq danada: BD dice 908016, el reporte dice #908612 | `resources.json` vs reporte 09-30 | Sin resolver, pendiente tu confirmacion |

## Cambios hechos hoy (todo reversible)

- Respaldo: `~/labos-data.backup-2026-10-08/`, commit `f48cfec` en el vault, `exports/events.before-cleanup.jsonl`.
- BD (solo se anadio, los 41 eventos originales siguen byte a byte): 17 resumenes retroactivos con etiqueta y link a la nota, 1 copia corregida del evento 25, 19 revisiones (tags, 2 ocultos, texto del checkpoint 30), 1 `asset rename`, 16 colores de tag.
- Vault: carpetas por tema, nombres `AAAA-MM-DD - tema`, frontmatter igual en todas (`date`, `tags`, `status`, `labos-id`, `labos-sessions`, `labos-project`), imagenes en `img/AAAA-MM/`, `00 Index.md`.
- Log del 10-08 y del 10-05 regenerados desde la BD.
- No se toco tu texto, salvo quitar `claude --resume ...` pegado en `2026-10-06 - Probando server`.

## Propuestas (no implementadas)

Cada una con el problema que resuelve y como medir si funciono.

| Propuesta | Problema | Exito si... |
|---|---|---|
| Avisar al escribir dentro del bloque `LabOS entries` | #1 | 0 notas largas dentro del bloque en 2 semanas |
| `capture` con hora explicita usa la sesion activa por defecto | #2 | 0 eventos sin sesion mientras hay sesion activa |
| Ignorar un envio igual al anterior en menos de 5 s | #3, #4 | 0 duplicados exactos |
| Guardar setup solo al soltar el arrastre (o con un boton) | #7 | menos de 3 setup_snapshot por cambio real |
| Checkpoint pregunta "firmware / ELF / bitstream" y calcula hash (opt-in) | hash a mano | 80 % de los checkpoints traen version y hash |
| Si pasan 24 h con trabajo y sin entradas, sugerir "New entry" en la nota abierta | #6 | dias sin entrada LabOS: de 7 de 11 a menos de 3 de 11 |
| Quitar campos de puerto vacios del canvas o explicarlos | #8 | conexiones con puerto lleno sube de 1/3 a mas de 2/3 |

## Pendientes tuyos

1. ¿Cual es la serie de la Zynq danada, 908016 o 908612? (La BD dice 908016, el reporte 09-30 dice #908612.)
2. Hay dos carpetas de plugin con el mismo id `labos`: `.obsidian/plugins/labos` (build del 09-28, sin tocar desde el 09-30) y `.obsidian/plugins/labos-obsidian` (build actual, la que guarda `data.json`). Verificado: el indice de notas ya tiene las 25 notas con su ruta nueva. No borres nada; si quieres, mueve la vieja fuera del vault.
