# Pipeline Reclamos · Juárez Beltrán

Herramienta interna para gestionar los **reclamos por el estado de los inmuebles administrados**, desde que ingresan
hasta que se cierran, con porcentaje de avance por reclamo. Es el panel de operador previsto para Roque: hoy la carga
es manual; a futuro el bot escribe en la misma base.

Corre sobre **Google Apps Script + Google Sheets + Google Drive**, con el mismo patrón que
[Biprop](https://github.com/Majaxu/Biprop) y [Pipeline ACM](https://github.com/Majaxu/pipelineacm): acceso con la cuenta
de Google del dominio, registro de quién hizo cada cambio y todo guardado en el Drive de `mantenimiento@`.

## Acceso

**https://majaxu.github.io/reclamos/** redirige a la aplicación. Entran solo Rodrigo (mantenimiento@), Gerardo y Máximo.

## Estructura

```
reclamos/
├── apps-script/
│   ├── Code.gs           → backend
│   ├── Index.html        → interfaz (HTML + CSS + JS en un solo archivo)
│   ├── appsscript.json   → manifiesto
│   └── DEPLOY.md         → puesta en marcha paso a paso
├── index.html            → página de acceso (GitHub Pages)
├── íconos y logos de JB
└── README.md
```

## Etapas

| Etapa | % | Se completa cuando |
|---|---|---|
| 1. Ingresado | 10 | Reclamo cargado con propiedad y descripción |
| 2. Evaluado | 25 | Rubro, urgencia y quién paga definidos |
| 3. Presupuestado | 40 | Al menos un presupuesto recibido, o marcado "sin presupuesto" |
| 4. Aprobado | 55 | Se registra la aprobación de quien paga |
| 5. Asignado | 70 | Proveedor y fecha programada de inicio cargados (80 con "trabajo iniciado") |
| 6. Terminado | 90 | Trabajo realizado y verificado |
| 7. Cerrado | 100 | Conformidad y costo final cargados |

Fuera de la línea principal: **Desestimado** (con motivo), **En pausa** (aprobación rechazada), **Reabierto** (vuelve a la
etapa 5 y se cuenta) y **reclamo derivado** (uno nuevo en la misma propiedad, enlazado).

## Pantallas

Tablero (lista ordenable, contadores y filtros), ficha del reclamo (una sección por etapa, notas, adjuntos e historial),
historial (cerrados y desestimados, con exportación a planilla), proveedores (ficha con estadísticas y gestión de rubros)
y supervisión.

## Dónde queda todo

**Planilla `Pipeline Reclamos · Base`**, con ocho hojas: `Reclamos`, `Presupuestos`, `Proveedores`, `Rubros`, `Adjuntos`,
`Notas`, `Historial` y `Config`. El porcentaje, las alertas, los días abierto y las estadísticas de proveedores se
calculan; no se guardan.

**Drive**, carpeta `Reclamos`: una subcarpeta por reclamo (`R-0001_0317/`) con sus archivos renombrados
`R-0001_ingreso_001.jpg`. No se comparte con todo el dominio porque tiene presupuestos y facturas.

## Integración con Biprop

- **Padrón de propiedades:** se lee de la planilla de Biprop. Si la propiedad no está, se da de alta en Biprop con el
  ID y la dirección que se cargan en el reclamo.
- **Adjuntos:** los del ingreso (etapa 1) y los de la finalización (etapa 6) se copian a Biprop como dos eventos
  separados (Reclamo y Reparación, vinculados entre sí). Los que se suben más tarde se agregan al mismo evento.
- No van a Biprop: adjuntos de la visita de diagnóstico, presupuestos, comprobantes y facturas.
- Se prende y se apaga con `biprop_activo` en la hoja `Config`. Lo que queda pendiente se reintenta solo cada hora.

## Alertas y mails

Alertas (suben el reclamo en el tablero): Trabado, En pausa sin resolver, Inicio vencido y Obra demorada. Mail diario a
Rodrigo con todos los reclamos abiertos y resumen semanal a Gerardo y a Máximo. Horarios, destinatarios y umbrales se
cambian en la hoja `Config`.

## Pendientes del diseño

1. Confirmar con Máximo los horarios y el contenido de los mails.
2. Integración con Roque: formato en que el bot escribe los reclamos en la etapa 1 (la base ya guarda el origen
   Manual o Roque).
