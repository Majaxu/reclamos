/**
 * Pipeline Reclamos · Juárez Beltrán
 * Backend en Google Apps Script + Google Sheets + Google Drive.
 *
 * Qué hace: gestiona los reclamos por el estado de los inmuebles administrados,
 * desde que ingresan hasta que se cierran, con porcentaje de avance. Es el panel
 * de operador previsto para Roque. Carga en Biprop los adjuntos del ingreso y de
 * la finalización.
 *
 * Cómo se publica: como aplicación web, "Ejecutar como: yo" (mantenimiento@) y
 * acceso para el dominio. Ver DEPLOY.md.
 *
 * Seguridad: los permisos se deciden SIEMPRE acá, en el servidor, con el email
 * real de Google (Session.getActiveUser()). Solo entran las cuentas de USUARIOS.
 *
 * La especificación completa está en el documento de diseño del proyecto
 * (versión del 11/11/2026). Lo que no figura ahí no está decidido.
 */

/* ================================================================== */
/* CONFIGURACIÓN                                                       */
/* ================================================================== */

/**
 * Los IDs de la planilla y de la carpeta NO se pegan acá: los crea y los guarda
 * la función instalar() en las "Propiedades de la secuencia de comandos":
 *   SHEET_ID        planilla "Pipeline Reclamos · Base"
 *   ROOT_FOLDER_ID  carpeta "Reclamos" (adjuntos, una subcarpeta por reclamo)
 *   BIPROP_SHEET_ID planilla de Biprop (se lee el padrón de propiedades)
 *   BIPROP_URL      URL /exec de Biprop (puerta de servicio)
 *   BIPROP_TOKEN    la misma clave que API_TOKEN en Biprop
 */

const DOMINIO = 'juarezbeltran.com.ar';
const OWNER   = 'mantenimiento@juarezbeltran.com.ar';

/**
 * USUARIOS (regla de negocio). Nadie más accede.
 *  - Rodrigo: operador principal (usa la cuenta mantenimiento@).
 *  - Gerardo y Máximo: ven todo, editan, agregan notas y administran.
 * Los tres pueden hacer todo lo que la herramienta permite; el rol es informativo.
 */
const USUARIOS = {
  'mantenimiento@juarezbeltran.com.ar': { nombre: 'Rodrigo', rol: 'Operador' },
  'gperez@juarezbeltran.com.ar':        { nombre: 'Gerardo', rol: 'Administrador' },
  'mjuarez@juarezbeltran.com.ar':       { nombre: 'Máximo',  rol: 'Administrador' }
};

const APP_NOMBRE  = 'Pipeline Reclamos';
const TZ          = 'America/Argentina/Cordoba';
const PAGES_URL   = 'https://majaxu.github.io/reclamos/';
const FAVICON_URL = PAGES_URL + 'favicon-32.png';

const NOMBRE_PLANILLA = 'Pipeline Reclamos · Base';
const NOMBRE_CARPETA  = 'Reclamos';
const NOMBRE_PLANILLA_BIPROP = 'Historial Multimedia · Base';
const CARPETA_EXPORT  = '_Exportaciones';
const BACKUP_FOLDER   = 'Pipeline Reclamos · Respaldos';
const BACKUP_KEEP     = 30;

/** Límite por archivo (regla técnica, igual que Biprop). */
const MAX_ARCHIVO_MB = 30;
const TEXTO_MAX      = 5000;

/**
 * ETAPAS Y PORCENTAJE (regla de negocio). "etapa" en la planilla es la última
 * etapa COMPLETADA. Con la etapa 5 completa y "trabajo iniciado" tildado: 80%.
 */
const ETAPAS = [
  { n: 1, nombre: 'Ingresado',     pct: 10 },
  { n: 2, nombre: 'Evaluado',      pct: 25 },
  { n: 3, nombre: 'Presupuestado', pct: 40 },
  { n: 4, nombre: 'Aprobado',      pct: 55 },
  { n: 5, nombre: 'Asignado',      pct: 70 },
  { n: 6, nombre: 'Terminado',     pct: 90 },
  { n: 7, nombre: 'Cerrado',       pct: 100 }
];
const PCT_TRABAJO_INICIADO = 80;

const CANALES        = ['WhatsApp', 'Teléfono', 'Mail', 'Presencial'];
const QUIEN_RECLAMA  = ['Inquilino', 'Propietario', 'Comercial', 'Otro'];
const QUIEN_PAGA     = ['Propietario', 'Inquilino', 'Consorcio', 'JB', 'Compartido', 'A definir'];
const MOTIVOS_DESEST = ['No corresponde', 'A cargo del inquilino', 'No aprobado', 'Duplicado', 'Otro'];
const MOTIVOS_SIN_PRESUPUESTO = ['Lo arregla el inquilino con su proveedor', 'Urgencia', 'Otro'];
const VERIFICACION   = ['Avisó el proveedor', 'Confirmó el inquilino', 'Fue alguien de JB'];
const CONFORMIDAD_QUIEN = ['Inquilino', 'Propietario', 'Comercial', 'Otro', 'JB'];
const ORIGENES       = ['Manual', 'Roque'];

const RUBROS_INICIALES = [
  'Plomería y agua', 'Gas', 'Electricidad', 'Desagües y cloacas', 'Calefacción y aire',
  'Humedad y filtraciones', 'Techos', 'Aberturas y cerrajería', 'Albañilería y pintura', 'Otros'
];

/** Secciones de adjuntos. Solo "ingreso" y "terminado" van a Biprop. */
const SECCIONES = ['ingreso', 'visita', 'presupuesto', 'aprobacion', 'terminado', 'cierre'];
const SECCIONES_BIPROP = { ingreso: 'RECLAMO', terminado: 'REPARACION' };

/**
 * CONFIGURACIÓN EDITABLE SIN TOCAR CÓDIGO: hoja "Config" de la planilla.
 * Estos son los valores por defecto con los que se crea. Los horarios y el
 * contenido de los mails NO están confirmados por Máximo (pendiente 1 del diseño).
 */
const CONFIG_DEFECTO = [
  ['dias_trabado_urgencia_4_5', '1', 'Días sin movimiento para marcar Trabado un reclamo de urgencia 4 o 5'],
  ['dias_trabado_urgencia_3',   '3', 'Ídem, urgencia 3'],
  ['dias_trabado_urgencia_1_2', '7', 'Ídem, urgencia 1 o 2'],
  ['dias_pausa',                '3', 'Días sin movimiento para alertar un reclamo En pausa'],
  ['mail_diario_activo',        'sí', 'sí / no. Mail diario con todos los reclamos abiertos'],
  ['mail_diario_para',          'mantenimiento@juarezbeltran.com.ar', 'Destinatarios del diario, separados por coma'],
  ['mail_diario_dias',          '1,2,3,4,5', 'Días en que sale (1 = lunes ... 7 = domingo)'],
  ['mail_diario_hora',          '8', 'Hora de envío, de 0 a 23, hora de Argentina'],
  ['mail_semanal_activo',       'sí', 'sí / no. Resumen semanal'],
  ['mail_semanal_para',         'gperez@juarezbeltran.com.ar, mjuarez@juarezbeltran.com.ar', 'Destinatarios del semanal, separados por coma'],
  ['mail_semanal_dia',          '1', 'Día en que sale (1 = lunes ... 7 = domingo)'],
  ['mail_semanal_hora',         '8', 'Hora de envío, de 0 a 23, hora de Argentina'],
  ['biprop_activo',             'no', 'sí / no. Enviar a Biprop los adjuntos del ingreso y de la finalización'],
  ['url_app',                   '', 'URL /exec de esta app, para los enlaces de los mails. Vacío: se detecta sola']
];

/* ================================================================== */
/* Planilla: hojas y columnas                                          */
/* ================================================================== */

const COLUMNAS = {
  Reclamos: [
    // Control
    'id_reclamo', 'estado', 'etapa', 'origen', 'cargado_por', 'fecha_carga', 'ultimo_movimiento',
    'carpeta_url', 'reclamo_origen', 'reaperturas', 'reprogramaciones',
    // 1 Ingresado
    'id_propiedad', 'direccion', 'fecha_reclamo', 'canal', 'quien_reclama', 'datos_reclamante', 'descripcion',
    // 2 Evaluado
    'rubro_id', 'urgencia', 'quien_paga', 'notas_evaluacion', 'fecha_evaluacion',
    // Visita de diagnóstico
    'visita_requiere', 'visita_quien', 'visita_programada', 'visita_realizada', 'visita_resultado',
    // 3 Presupuestado
    'sin_presupuesto', 'sin_presupuesto_motivo', 'fecha_presupuestado',
    // 4 Aprobado
    'aprob_resultado', 'id_presupuesto_elegido', 'aprob_quien', 'aprob_medio', 'aprob_fecha',
    'monto_aprobado', 'reparto', 'descuenta_alquiler', 'aprob_notas', 'pausa_desde',
    // 5 Asignado
    'proveedor_id', 'proveedor_texto', 'fecha_asignacion', 'fecha_programada', 'acceso', 'llaves_oficina',
    'asig_notas', 'trabajo_iniciado', 'fecha_inicio', 'fecha_estimada_fin',
    // 6 Terminado
    'fecha_fin', 'trabajo_realizado', 'verificacion', 'term_notas',
    // 7 Cerrado
    'costo_final', 'conformidad', 'conformidad_quien', 'fecha_cierre', 'calificacion', 'cierre_notas',
    'cierre_sin_conformidad_motivo',
    // Desestimado
    'desest_motivo', 'desest_detalle', 'desest_fecha', 'desest_por',
    // Biprop
    'biprop_evento_ingreso', 'biprop_url_ingreso', 'biprop_evento_fin', 'biprop_url_fin'
  ],
  Presupuestos: ['id_presupuesto', 'id_reclamo', 'proveedor_id', 'fecha_pedido', 'fecha_recepcion', 'monto',
                 'detalle', 'plazo', 'estado', 'cargado_por', 'fecha_carga'],
  Proveedores: ['id_proveedor', 'nombre', 'contacto', 'telefono', 'mail', 'rubros', 'notas', 'estado',
                'fecha_alta', 'cargado_por', 'baja_motivo', 'baja_fecha'],
  Rubros: ['id_rubro', 'nombre', 'activo'],
  Adjuntos: ['id_adjunto', 'id_reclamo', 'seccion', 'id_presupuesto', 'nombre', 'nombre_original', 'mime',
             'tamano', 'drive_id', 'subido_por', 'fecha', 'en_biprop'],
  Notas: ['id_nota', 'id_reclamo', 'fecha', 'usuario', 'texto'],
  Historial: ['fecha', 'usuario', 'id_reclamo', 'accion', 'detalle', 'campo', 'valor_anterior', 'valor_nuevo',
              'motivo', 'proveedor_id'],
  Config: ['clave', 'valor', 'descripcion']
};

/** Tipo de cada columna. Lo que no figura acá es texto. */
const COLS_MOMENTO = ['fecha_carga', 'ultimo_movimiento', 'desest_fecha', 'fecha_alta', 'baja_fecha', 'fecha'];
const COLS_NUMERO  = ['etapa', 'reaperturas', 'reprogramaciones', 'id_propiedad', 'urgencia', 'monto',
                      'monto_aprobado', 'costo_final', 'calificacion', 'tamano'];
const COLS_BOOL    = ['visita_requiere', 'sin_presupuesto', 'descuenta_alquiler', 'llaves_oficina',
                      'trabajo_iniciado', 'activo'];
/** En estas columnas vacío y 0 son cosas distintas (un costo final de 0 es válido). */
const COLS_NUMERO_VACIO = ['urgencia', 'monto', 'monto_aprobado', 'costo_final', 'calificacion'];

function formato_(col) {
  if (col === 'id_propiedad') return '0000';
  if (COLS_MOMENTO.indexOf(col) !== -1) return 'dd/mm/yyyy hh:mm:ss';
  if (COLS_NUMERO.indexOf(col) !== -1) return '0';
  return '@';
}

/* Memoria de la ejecución en curso (se pierde al terminar cada llamada). */
let LIBRO_ = null;
let HOJAS_ = {};
let CACHE_ = {};
let EN_BLOQUEO_ = false;
let CONFIG_ = null;

/* ================================================================== */
/* Servir la app                                                       */
/* ================================================================== */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_NOMBRE + ' · Juárez Beltrán')
    .setFaviconUrl(FAVICON_URL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ================================================================== */
/* Identidad y permisos                                                */
/* ================================================================== */

/** Email real de quien usa la app. Rechaza a cualquiera que no esté en USUARIOS. */
function emailActual_() {
  const e = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!e) throw new Error('No pudimos identificar tu cuenta de Google. Entrá con tu cuenta de Juárez Beltrán.');
  if (!USUARIOS[e]) throw new Error('Tu cuenta (' + e + ') no tiene acceso a Pipeline Reclamos. Pedíselo a Máximo.');
  return e;
}
function nombreDe_(email) {
  const u = USUARIOS[String(email || '').toLowerCase()];
  return u ? u.nombre : String(email || '');
}

/** Las funciones de mantenimiento solo las corre la cuenta dueña, desde el editor o por disparador. */
function soloDuenio_() {
  const e = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (e && e !== OWNER.toLowerCase()) throw new Error('Esta función solo la puede ejecutar ' + OWNER + ' desde el editor.');
}

/* ================================================================== */
/* Utilidades                                                          */
/* ================================================================== */

function prop_(clave) { return PropertiesService.getScriptProperties().getProperty(clave) || ''; }
function pad_(n, largo) { let s = String(Number(n)); while (s.length < largo) s = '0' + s; return s; }
function pad4_(n) { return pad_(n, 4); }
function hoy_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function momentoTxt_(d) { return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ss"); }

/** "2026-03-15" -> "15/03/2026" */
function fechaAr_(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : String(ymd || '');
}
function esFechaValida_(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
/** Días entre dos fechas "AAAA-MM-DD" (admite también "AAAA-MM-DDTHH:mm:ss"). */
function diasEntre_(desde, hasta) {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(desde || '')), b = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(hasta || ''));
  if (!a || !b) return 0;
  return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000);
}
function sumarDias_(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}
/** Día de la semana de una fecha: 1 = lunes ... 7 = domingo. */
function diaSemana_(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Limpia un texto que viene de la pantalla. */
function texto_(v, max) {
  let s = String(v === null || v === undefined ? '' : v).replace(/\r\n?/g, '\n').trim();
  s = s.replace(/^=+/, '').trim();   // para que Sheets no lo tome como fórmula
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}
function fecha_(v, nombre, obligatoria) {
  const s = String(v || '').trim();
  if (!s) { if (obligatoria) throw new Error('Falta ' + nombre + '.'); return ''; }
  if (!esFechaValida_(s)) throw new Error('Revisá ' + nombre + '.');
  return s;
}
function opcion_(v, lista, nombre, obligatoria) {
  const s = String(v || '').trim();
  if (!s) { if (obligatoria) throw new Error('Elegí ' + nombre + '.'); return ''; }
  if (lista.indexOf(s) === -1) throw new Error('El valor de ' + nombre + ' no es válido.');
  return s;
}
/** Importe en pesos: número entero o con decimales, sin negativos. Vacío devuelve ''. */
function monto_(v, nombre, obligatorio) {
  if (v === '' || v === null || v === undefined) {
    if (obligatorio) throw new Error('Falta ' + nombre + '.');
    return '';
  }
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  if (typeof v === 'number' ? (isNaN(v) || v < 0) : (isNaN(n) || n < 0)) throw new Error('Revisá ' + nombre + ': tiene que ser un número.');
  return typeof v === 'number' ? v : n;
}
function idPropiedad_(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  const n = Number(s);
  if (!/^\d{1,4}$/.test(s) || n < 1 || n > 9999) throw new Error('El ID de la propiedad tiene que ser un número entre 1 y 9999.');
  return n;
}
function pesos_(n) {
  if (n === '' || n === null || n === undefined) return '';
  return '$ ' + String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function htmlEsc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function vivos_(it) {
  const lista = [];
  while (it.hasNext()) { const x = it.next(); if (!x.isTrashed()) lista.push(x); }
  return lista;
}
function subcarpeta_(padre, nombre) {
  const existentes = vivos_(padre.getFoldersByName(nombre));
  return existentes.length ? existentes[0] : padre.createFolder(nombre);
}
function idDeUrl_(url) {
  const m = /folders\/([-\w]+)/.exec(String(url || '')) || /[?&]id=([-\w]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}
function extension_(nombreOriginal) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(nombreOriginal || ''));
  return m ? m[1].toLowerCase() : 'bin';
}
function esImagen_(mime) { return String(mime || '').indexOf('image/') === 0; }
function esVideo_(mime)  { return String(mime || '').indexOf('video/') === 0; }

/** Ejecuta fn con el candado del script, para que dos personas no se pisen al guardar. */
function conBloqueo_(fn) {
  if (EN_BLOQUEO_) return fn();
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); }
  catch (e) { throw new Error('Hay varias personas guardando al mismo tiempo. Esperá unos segundos y probá de nuevo.'); }
  EN_BLOQUEO_ = true;
  CACHE_ = {};   // con el candado tomado se vuelve a leer la planilla, para trabajar con datos frescos
  try { return fn(); }
  finally {
    EN_BLOQUEO_ = false;
    try { SpreadsheetApp.flush(); } catch (e) {}
    lock.releaseLock();
  }
}

/* ================================================================== */
/* Acceso a la planilla (mismo patrón que Biprop)                      */
/* ================================================================== */

function libro_() {
  if (!LIBRO_) {
    const id = prop_('SHEET_ID');
    if (!id) throw new Error('La app todavía no está instalada: falta ejecutar instalar() desde el editor.');
    try { LIBRO_ = SpreadsheetApp.openById(id); }
    catch (e) { throw new Error('No se pudo abrir la planilla de datos. Avisale a Máximo.'); }
  }
  return LIBRO_;
}

/** Devuelve la hoja; si no existe la crea con sus encabezados. */
function hoja_(nombre) {
  if (HOJAS_[nombre]) return HOJAS_[nombre];
  const cols = COLUMNAS[nombre];
  let sh = libro_().getSheetByName(nombre);
  if (!sh) sh = libro_().insertSheet(nombre);

  const ancho = sh.getLastColumn();
  const actuales = ancho ? sh.getRange(1, 1, 1, ancho).getValues()[0].map(String) : [];
  const coincide = actuales.length >= cols.length && cols.every((c, i) => actuales[i] === c);
  if (!coincide) {
    // Solo se escriben encabezados si la hoja está vacía o le faltan columnas al final.
    const esPrefijo = actuales.every((c, i) => c === '' || c === cols[i]);
    if (!esPrefijo) throw new Error('La hoja "' + nombre + '" de la planilla tiene las columnas cambiadas. Avisale a Máximo.');
    if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, cols.length).setNumberFormat('@').setValues([cols]);
    sh.setFrozenRows(1);
  }
  HOJAS_[nombre] = sh;
  return sh;
}

/** Pasa el valor de una celda a algo cómodo de usar (y que se pueda mandar a la pantalla). */
function deCelda_(col, v) {
  if (COLS_NUMERO.indexOf(col) !== -1) {
    if (v === '' || v === null) return COLS_NUMERO_VACIO.indexOf(col) !== -1 ? '' : 0;
    return Number(v) || 0;
  }
  if (COLS_MOMENTO.indexOf(col) !== -1) return (v instanceof Date) ? momentoTxt_(v) : String(v || '');
  if (COLS_BOOL.indexOf(col) !== -1) {
    const s = String(v).toLowerCase().trim();
    return s === 'sí' || s === 'si' || s === 'true' || s === '1';
  }
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v === null || v === undefined ? '' : v);
}

/** Pasa un valor a lo que se escribe en la celda. */
function aCelda_(col, v) {
  if (v === null || v === undefined) v = '';
  if (COLS_NUMERO.indexOf(col) !== -1) {
    if (v === '') return COLS_NUMERO_VACIO.indexOf(col) !== -1 ? '' : 0;
    return Number(v) || 0;
  }
  if (COLS_MOMENTO.indexOf(col) !== -1) return v;   // Date o vacío
  if (COLS_BOOL.indexOf(col) !== -1) return v ? 'sí' : 'no';
  return String(v);
}

/** Lee una hoja completa como lista de objetos. Cada uno trae _fila (número de fila en la planilla). */
function leer_(nombre) {
  if (CACHE_[nombre]) return CACHE_[nombre];
  const sh = hoja_(nombre), cols = COLUMNAS[nombre];
  const ultima = sh.getLastRow();
  let filas = [];
  if (ultima >= 2) {
    filas = sh.getRange(2, 1, ultima - 1, cols.length).getValues().map((celdas, i) => {
      const o = { _fila: i + 2 };
      cols.forEach((c, j) => { o[c] = deCelda_(c, celdas[j]); });
      return o;
    });
  }
  CACHE_[nombre] = filas;
  return filas;
}

function agregar_(nombre, obj) {
  const sh = hoja_(nombre), cols = COLUMNAS[nombre];
  const fila = sh.getLastRow() + 1;
  if (fila > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 200);
  const rango = sh.getRange(fila, 1, 1, cols.length);
  rango.setNumberFormats([cols.map(formato_)]);
  rango.setValues([cols.map(c => aCelda_(c, obj[c]))]);
  delete CACHE_[nombre];
  return fila;
}

function actualizar_(nombre, fila, cambios) {
  const sh = hoja_(nombre), cols = COLUMNAS[nombre];
  const rango = sh.getRange(fila, 1, 1, cols.length);
  const valores = rango.getValues()[0];
  cols.forEach((c, j) => {
    if (Object.prototype.hasOwnProperty.call(cambios, c)) valores[j] = aCelda_(c, cambios[c]);
  });
  rango.setNumberFormats([cols.map(formato_)]);
  rango.setValues([valores]);
  delete CACHE_[nombre];
}

/** Copia de un objeto de la planilla sin el dato interno _fila, lista para mandar a la pantalla. */
function limpio_(o) {
  const c = {};
  Object.keys(o).forEach(k => { if (k !== '_fila') c[k] = o[k]; });
  return c;
}

/** Siguiente identificador correlativo (R-0001, P-0001...). Nunca se reutiliza. */
function siguienteId_(hoja, col, prefijo, largo) {
  const props = PropertiesService.getScriptProperties();
  const clave = 'ULTIMO_' + hoja.toUpperCase();
  let n = Number(props.getProperty(clave)) || 0;
  const re = new RegExp('^' + prefijo + '-(\\d+)$');
  leer_(hoja).forEach(x => { const m = re.exec(x[col]); if (m && Number(m[1]) > n) n = Number(m[1]); });
  n++;
  props.setProperty(clave, String(n));
  return prefijo + '-' + pad_(n, largo);
}

/* ================================================================== */
/* Configuración editable (hoja Config)                                */
/* ================================================================== */

function config_() {
  if (CONFIG_) return CONFIG_;
  const c = {};
  CONFIG_DEFECTO.forEach(x => { c[x[0]] = x[1]; });
  leer_('Config').forEach(f => { if (f.clave) c[f.clave] = String(f.valor).trim(); });
  CONFIG_ = c;
  return c;
}
function cfgNum_(clave, defecto) {
  const n = Number(config_()[clave]);
  return isNaN(n) || config_()[clave] === '' ? defecto : n;
}
function cfgSi_(clave) {
  const s = String(config_()[clave] || '').toLowerCase().trim();
  return s === 'sí' || s === 'si' || s === 'true' || s === '1';
}
function cfgLista_(clave) {
  return String(config_()[clave] || '').split(',').map(s => s.trim()).filter(s => s);
}

/* ================================================================== */
/* Historial de cambios                                                */
/* ================================================================== */

/** Un renglón del historial del reclamo. extra: { campo, anterior, nuevo, motivo, proveedor_id }. */
function log_(email, idReclamo, accion, detalle, extra) {
  extra = extra || {};
  agregar_('Historial', {
    fecha: new Date(), usuario: email, id_reclamo: idReclamo, accion: accion,
    detalle: texto_(detalle, 500), campo: extra.campo || '',
    valor_anterior: texto_(extra.anterior, 500), valor_nuevo: texto_(extra.nuevo, 500),
    motivo: texto_(extra.motivo, 500), proveedor_id: extra.proveedor_id || ''
  });
}

/** Campos cuya corrección posterior queda asentada con el valor anterior y el nuevo. */
const CAMPOS_AUDITADOS = {
  id_propiedad: 'Propiedad', fecha_reclamo: 'Fecha del reclamo', canal: 'Canal', quien_reclama: 'Quién reclama',
  datos_reclamante: 'Datos de quien reclama', descripcion: 'Descripción',
  rubro_id: 'Rubro', urgencia: 'Urgencia', quien_paga: 'Quién paga',
  proveedor_id: 'Proveedor', proveedor_texto: 'Proveedor', fecha_programada: 'Fecha programada de inicio',
  fecha_estimada_fin: 'Fecha estimada de finalización', monto_aprobado: 'Monto aprobado',
  costo_final: 'Costo final', fecha_fin: 'Fecha de finalización', trabajo_realizado: 'Trabajo realizado'
};

/**
 * Guarda cambios en un reclamo: escribe la fila, marca el movimiento y deja en
 * el historial un renglón con la acción y uno por cada campo auditado que se
 * corrigió (tenía valor y cambió). Devuelve el reclamo releído.
 */
function aplicar_(r, cambios, email, accion, detalle, extra) {
  const corregidos = [];
  Object.keys(cambios).forEach(c => {
    if (!CAMPOS_AUDITADOS[c] || (extra && extra.sinAuditoria)) return;
    const antes = r[c], despues = cambios[c];
    if (antes !== '' && antes !== 0 && String(antes) !== String(despues)) {
      corregidos.push({ campo: c, anterior: antes, nuevo: despues });
    }
  });
  cambios.ultimo_movimiento = new Date();
  actualizar_('Reclamos', r._fila, cambios);
  if (accion) log_(email, r.id_reclamo, accion, detalle, extra);
  corregidos.forEach(x => {
    log_(email, r.id_reclamo, 'corrección', CAMPOS_AUDITADOS[x.campo] + ': ' + mostrar_(x.campo, x.anterior) + ' → ' + mostrar_(x.campo, x.nuevo),
      { campo: x.campo, anterior: x.anterior, nuevo: x.nuevo, motivo: extra && extra.motivo });
  });
  return reclamo_(r.id_reclamo);
}

/** Valor legible de un campo para el historial. */
function mostrar_(campo, v) {
  if (campo === 'rubro_id') return nombreRubro_(v);
  if (campo === 'proveedor_id') return nombreProveedor_(v) || '(sin proveedor)';
  if (campo === 'id_propiedad') return pad4_(v);
  if (/^fecha/.test(campo)) return fechaAr_(v);
  if (campo === 'monto_aprobado' || campo === 'costo_final') return pesos_(v);
  return String(v);
}

/** Marca movimiento en un reclamo sin cambiar otra cosa (nota, adjunto, presupuesto). */
function tocar_(r) {
  actualizar_('Reclamos', r._fila, { ultimo_movimiento: new Date() });
}

/* ================================================================== */
/* Consultas básicas                                                   */
/* ================================================================== */

function reclamo_(id) {
  const r = leer_('Reclamos').filter(x => x.id_reclamo === String(id))[0];
  if (!r) throw new Error('No encontramos el reclamo ' + id + '.');
  return r;
}
function rubros_() { return leer_('Rubros'); }
function nombreRubro_(id) {
  const r = rubros_().filter(x => x.id_rubro === String(id))[0];
  return r ? r.nombre : '';
}
function proveedor_(id) { return leer_('Proveedores').filter(p => p.id_proveedor === String(id))[0] || null; }
function nombreProveedor_(id) { const p = proveedor_(id); return p ? p.nombre : ''; }
/** Nombre del proveedor asignado a un reclamo (del catálogo o texto libre). */
function proveedorDe_(r) { return r.proveedor_id ? nombreProveedor_(r.proveedor_id) : (r.proveedor_texto || ''); }

function etapa_(n) { return ETAPAS.filter(e => e.n === Number(n))[0] || ETAPAS[0]; }
function porcentaje_(r) {
  if (r.etapa === 5 && r.trabajo_iniciado) return PCT_TRABAJO_INICIADO;
  return etapa_(r.etapa).pct;
}
function nombreEtapa_(r) {
  if (r.etapa === 5 && r.trabajo_iniciado) return 'Trabajo iniciado';
  return etapa_(r.etapa).nombre;
}
function exigirAbierto_(r) {
  if (r.estado === 'cerrado') throw new Error('Este reclamo está cerrado. Para cambiarlo hay que reabrirlo.');
  if (r.estado === 'desestimado') throw new Error('Este reclamo está desestimado.');
}

/* ================================================================== */
/* Alertas y avisos (sección 7 del diseño)                             */
/* ================================================================== */

/** Días sin movimiento que marcan Trabado, según la urgencia. */
function umbralTrabado_(urgencia) {
  if (urgencia >= 4) return cfgNum_('dias_trabado_urgencia_4_5', 1);
  if (urgencia === 3) return cfgNum_('dias_trabado_urgencia_3', 3);
  return cfgNum_('dias_trabado_urgencia_1_2', 7);
}

/** Cantidad de fotos y videos del ingreso por reclamo, para el aviso "sin fotos". */
function fotosIngreso_() {
  const m = {};
  leer_('Adjuntos').forEach(a => {
    if (a.seccion === 'ingreso' && (esImagen_(a.mime) || esVideo_(a.mime))) m[a.id_reclamo] = (m[a.id_reclamo] || 0) + 1;
  });
  return m;
}

/**
 * Arma la fila del tablero para un reclamo: datos visibles, porcentaje, días,
 * alertas (suben el reclamo en el orden por defecto) y avisos informativos.
 */
function vista_(r, hoy, fotos) {
  const abierto = r.estado === 'abierto' || r.estado === 'en_pausa';
  const fin = r.estado === 'cerrado' ? (r.fecha_cierre || hoy) : r.estado === 'desestimado' ? String(r.desest_fecha).slice(0, 10) : hoy;
  const sinMov = abierto ? Math.max(0, diasEntre_(r.ultimo_movimiento, hoy)) : 0;
  const alertas = [], avisos = [];

  if (abierto) {
    const esperandoVisita = r.visita_requiere && !r.visita_realizada && r.visita_programada && r.visita_programada >= hoy;
    const programado = r.etapa === 5 && !r.trabajo_iniciado && r.fecha_programada && r.fecha_programada >= hoy;

    if (r.estado === 'en_pausa') {
      // EN PAUSA SIN RESOLVER: cada dias_pausa días, sin importar la urgencia.
      if (sinMov >= cfgNum_('dias_pausa', 3)) alertas.push('En pausa sin resolver: ' + sinMov + (sinMov === 1 ? ' día' : ' días'));
      avisos.push('En pausa');
    } else if (r.urgencia !== '' && r.etapa < 7 && !esperandoVisita && !programado && sinMov >= umbralTrabado_(r.urgencia)) {
      // TRABADO: corre desde que se guarda la urgencia y también en Terminado sin cerrar.
      alertas.push('Trabado: ' + sinMov + (sinMov === 1 ? ' día' : ' días') + ' sin movimiento');
    }
    if (r.estado === 'abierto' && r.etapa === 5) {
      if (!r.trabajo_iniciado && r.fecha_programada && r.fecha_programada < hoy) alertas.push('Inicio vencido');
      if (r.fecha_estimada_fin && r.fecha_estimada_fin < hoy) alertas.push('Obra demorada');
    }

    if (!fotos[r.id_reclamo]) avisos.push('Sin fotos');
    if (esperandoVisita) avisos.push('Esperando visita ' + fechaAr_(r.visita_programada).slice(0, 5));
    if (programado) avisos.push('Programado ' + fechaAr_(r.fecha_programada).slice(0, 5));
    if (r.estado === 'abierto' && r.etapa === 6) avisos.push('Falta conformidad');
  }

  return {
    id_reclamo: r.id_reclamo, estado: r.estado, etapa: r.etapa, etapa_nombre: nombreEtapa_(r), pct: porcentaje_(r),
    id_propiedad: r.id_propiedad, direccion: r.direccion, descripcion: r.descripcion,
    rubro_id: r.rubro_id, rubro: nombreRubro_(r.rubro_id), urgencia: r.urgencia,
    proveedor_id: r.proveedor_id, proveedor: proveedorDe_(r),
    fecha_reclamo: r.fecha_reclamo, dias_abierto: Math.max(0, diasEntre_(r.fecha_reclamo, fin)), dias_sin_mov: sinMov,
    alertas: alertas, avisos: avisos,
    fecha_cierre: r.fecha_cierre, costo_final: r.costo_final, desest_motivo: r.desest_motivo,
    desest_fecha: String(r.desest_fecha).slice(0, 10), origen: r.origen
  };
}

/** Orden por defecto del tablero: con alerta primero, después urgencia de mayor a menor, después más viejo. */
function ordenTablero_(a, b) {
  const x = (b.alertas.length ? 1 : 0) - (a.alertas.length ? 1 : 0);
  if (x) return x;
  const u = (Number(b.urgencia) || 0) - (Number(a.urgencia) || 0);
  if (u) return u;
  return b.dias_abierto - a.dias_abierto;
}

function abiertos_() {
  const hoy = hoy_(), fotos = fotosIngreso_();
  return leer_('Reclamos').filter(r => r.estado === 'abierto' || r.estado === 'en_pausa')
    .map(r => vista_(r, hoy, fotos)).sort(ordenTablero_);
}

/* ================================================================== */
/* API · arranque                                                      */
/* ================================================================== */

/** Datos iniciales: quién soy, listas, rubros, proveedores, propiedades y reclamos abiertos. */
function getInicio() {
  const email = emailActual_();
  return {
    email: email, nombre: nombreDe_(email), rol: USUARIOS[email].rol,
    usuarios: Object.keys(USUARIOS).map(e => ({ email: e, nombre: USUARIOS[e].nombre })),
    config: {
      app: APP_NOMBRE, etapas: ETAPAS, pctIniciado: PCT_TRABAJO_INICIADO, canales: CANALES,
      quienReclama: QUIEN_RECLAMA, quienPaga: QUIEN_PAGA, motivosDesest: MOTIVOS_DESEST,
      motivosSinPresupuesto: MOTIVOS_SIN_PRESUPUESTO, verificacion: VERIFICACION,
      conformidadQuien: CONFORMIDAD_QUIEN, maxMb: MAX_ARCHIVO_MB, biprop: bipropActivo_()
    },
    rubros: rubros_().map(limpio_),
    proveedores: proveedoresResumen_(),
    propiedades: padron_(),
    reclamos: abiertos_(),
    hoy: hoy_()
  };
}

/** Solo lo que cambia seguido, para refrescar el tablero. */
function getTablero() {
  emailActual_();
  return { reclamos: abiertos_(), proveedores: proveedoresResumen_(), rubros: rubros_().map(limpio_), propiedades: padron_(), hoy: hoy_() };
}

/* ================================================================== */
/* API · ficha del reclamo                                             */
/* ================================================================== */

function getReclamo(id) {
  emailActual_();
  return ficha_(String(id));
}

function ficha_(id) {
  const r = reclamo_(id), hoy = hoy_();
  const adjuntos = leer_('Adjuntos').filter(a => a.id_reclamo === id).map(a => {
    const c = limpio_(a);
    c.url = 'https://drive.google.com/file/d/' + a.drive_id + '/view';
    return c;
  });
  const dato = limpio_(r);
  dato.vista = vista_(r, hoy, fotosIngreso_());
  const todos = leer_('Reclamos');
  return {
    reclamo: dato,
    presupuestos: leer_('Presupuestos').filter(p => p.id_reclamo === id).map(p => {
      const c = limpio_(p);
      c.proveedor = nombreProveedor_(p.proveedor_id);
      c.dias_esperando = p.estado === 'pedido' ? Math.max(0, diasEntre_(p.fecha_pedido, hoy)) : 0;
      return c;
    }),
    adjuntos: adjuntos,
    notas: leer_('Notas').filter(n => n.id_reclamo === id).map(n => {
      const c = limpio_(n); c.nombre = nombreDe_(n.usuario); return c;
    }).reverse(),
    historial: leer_('Historial').filter(h => h.id_reclamo === id).map(h => {
      const c = limpio_(h); c.nombre = nombreDe_(h.usuario); return c;
    }).reverse(),
    derivados: todos.filter(x => x.reclamo_origen === id).map(x => ({ id_reclamo: x.id_reclamo, descripcion: x.descripcion, estado: x.estado })),
    otrosAbiertos: todos.filter(x => x.id_propiedad === r.id_propiedad && x.id_reclamo !== id &&
      (x.estado === 'abierto' || x.estado === 'en_pausa'))
      .map(x => ({ id_reclamo: x.id_reclamo, descripcion: x.descripcion, etapa_nombre: nombreEtapa_(x) })),
    hoy: hoy
  };
}

/* ================================================================== */
/* API · etapa 1 · Ingresado                                           */
/* ================================================================== */

function validarIngreso_(datos) {
  datos = datos || {};
  const d = {};
  d.id_propiedad = idPropiedad_(datos.id_propiedad);
  d.fecha_reclamo = fecha_(datos.fecha_reclamo, 'la fecha del reclamo', true);
  if (d.fecha_reclamo > hoy_()) throw new Error('La fecha del reclamo no puede ser futura.');
  d.canal = opcion_(datos.canal, CANALES, 'el canal', true);
  d.quien_reclama = opcion_(datos.quien_reclama, QUIEN_RECLAMA, 'quién reclama', true);
  d.datos_reclamante = texto_(datos.datos_reclamante, 500);
  if (d.quien_reclama !== 'Inquilino' && !d.datos_reclamante) throw new Error('Completá los datos de quien reclama.');
  if (d.quien_reclama === 'Inquilino') d.datos_reclamante = '';
  d.descripcion = texto_(datos.descripcion, TEXTO_MAX);
  if (!d.descripcion) throw new Error('Escribí la descripción del problema.');
  return d;
}

/**
 * Busca la propiedad en el padrón. Si no está, hace falta la dirección: la
 * propiedad se crea en Biprop con ese ID y esa dirección (decisión del 11/11/2026).
 */
function resolverPropiedad_(id, direccionNueva, email) {
  const p = padron_().filter(x => x.id === id)[0];
  if (p && p.enBiprop) return { direccion: p.direccion, aviso: '' };
  const direccion = texto_(direccionNueva, 200).replace(/\s+/g, ' ') || (p ? p.direccion : '');
  if (!direccion) throw new Error('La propiedad ' + pad4_(id) + ' no está en Biprop. Escribí la dirección para darla de alta.');
  let aviso = '';
  if (bipropActivo_()) {
    try { bipropLlamar_('asegurarPropiedad', { id: id, direccion: direccion, cargado_por: email }); }
    catch (e) { aviso = 'La propiedad no se pudo dar de alta en Biprop todavía (' + (e.message || e) + '). Se va a reintentar al enviar los adjuntos.'; }
  }
  return { direccion: direccion, aviso: aviso };
}

/** Crea el reclamo (etapa 1). Los adjuntos se suben después, con subirArchivo. */
function crearReclamo(datos) {
  const email = emailActual_();
  const d = validarIngreso_(datos);
  const origen = opcion_((datos || {}).origen, ORIGENES, 'el origen', false) || 'Manual';
  const derivadoDe = String((datos || {}).reclamo_origen || '');

  return conBloqueo_(() => {
    if (derivadoDe) reclamo_(derivadoDe);
    const prop = resolverPropiedad_(d.id_propiedad, (datos || {}).direccion_nueva, email);
    const id = siguienteId_('Reclamos', 'id_reclamo', 'R', 4);
    const carpeta = raiz_().createFolder(id + '_' + pad4_(d.id_propiedad));
    const ahora = new Date();
    const fila = {
      id_reclamo: id, estado: 'abierto', etapa: 1, origen: origen, cargado_por: email, fecha_carga: ahora,
      ultimo_movimiento: ahora, carpeta_url: carpeta.getUrl(), reclamo_origen: derivadoDe,
      reaperturas: 0, reprogramaciones: 0,
      id_propiedad: d.id_propiedad, direccion: prop.direccion, fecha_reclamo: d.fecha_reclamo, canal: d.canal,
      quien_reclama: d.quien_reclama, datos_reclamante: d.datos_reclamante, descripcion: d.descripcion
    };
    agregar_('Reclamos', fila);
    log_(email, id, 'ingresó el reclamo', pad4_(d.id_propiedad) + ' · ' + prop.direccion + (derivadoDe ? ' · derivado de ' + derivadoDe : ''));
    if (derivadoDe) log_(email, derivadoDe, 'reclamo derivado', 'Se creó ' + id);
    return { id_reclamo: id, aviso: prop.aviso };
  });
}

/** Corrige los datos del ingreso. */
function guardarIngreso(id, datos) {
  const email = emailActual_();
  const d = validarIngreso_(datos);
  return conBloqueo_(() => {
    const r = reclamo_(id);
    exigirAbierto_(r);
    let aviso = '';
    if (d.id_propiedad !== r.id_propiedad) {
      if (r.biprop_evento_ingreso || r.biprop_evento_fin) throw new Error('Este reclamo ya tiene eventos en Biprop: no se puede cambiar de propiedad.');
      const prop = resolverPropiedad_(d.id_propiedad, (datos || {}).direccion_nueva, email);
      d.direccion = prop.direccion; aviso = prop.aviso;
    }
    aplicar_(r, d, email, 'editó el ingreso', '');
    return { ficha: ficha_(r.id_reclamo), aviso: aviso };
  });
}

/* ================================================================== */
/* API · etapa 2 · Evaluado (y visita de diagnóstico)                  */
/* ================================================================== */

function guardarEvaluacion(id, datos) {
  const email = emailActual_();
  datos = datos || {};
  return conBloqueo_(() => {
    const r = reclamo_(id);
    exigirAbierto_(r);

    // ¿Corresponde? Con No pasa a Desestimado y pide motivo.
    if (datos.corresponde === false) {
      desestimar_(r, datos.motivo || 'No corresponde', datos.detalle, email);
      return { ficha: ficha_(r.id_reclamo) };
    }

    const d = {};
    d.rubro_id = String(datos.rubro_id || '');
    const rubro = rubros_().filter(x => x.id_rubro === d.rubro_id)[0];
    if (!rubro || (!rubro.activo && r.rubro_id !== d.rubro_id)) throw new Error('Elegí el rubro.');
    d.urgencia = Number(datos.urgencia);
    if ([1, 2, 3, 4, 5].indexOf(d.urgencia) === -1) throw new Error('Elegí la urgencia, de 1 a 5.');
    d.quien_paga = opcion_(datos.quien_paga, QUIEN_PAGA, 'quién paga', true);
    d.notas_evaluacion = texto_(datos.notas_evaluacion, TEXTO_MAX);

    // Bloque opcional de visita de diagnóstico.
    d.visita_requiere = !!datos.visita_requiere;
    if (d.visita_requiere) {
      d.visita_quien = texto_(datos.visita_quien, 200);
      d.visita_programada = fecha_(datos.visita_programada, 'la fecha programada de la visita', false);
      d.visita_realizada = fecha_(datos.visita_realizada, 'la fecha en que se hizo la visita', false);
      d.visita_resultado = texto_(datos.visita_resultado, TEXTO_MAX);
    } else {
      d.visita_quien = ''; d.visita_programada = ''; d.visita_realizada = ''; d.visita_resultado = '';
    }

    const primera = r.etapa < 2;
    if (primera) { d.etapa = 2; d.fecha_evaluacion = hoy_(); }
    aplicar_(r, d, email, primera ? 'evaluó' : 'editó la evaluación',
      rubro.nombre + ' · urgencia ' + d.urgencia + ' · paga ' + d.quien_paga.toLowerCase());
    // Si ya había presupuestos cargados, puede completarse la etapa 3 en el mismo paso.
    avanzarPresupuestado_(reclamo_(r.id_reclamo), email);
    return { ficha: ficha_(r.id_reclamo) };
  });
}

/* ================================================================== */
/* API · etapa 3 · Presupuestado                                       */
/* ================================================================== */

/** La etapa 3 se completa con al menos un presupuesto recibido, o marcado "sin presupuesto". */
function avanzarPresupuestado_(r, email) {
  if (r.etapa !== 2) return;
  const recibidos = leer_('Presupuestos').filter(p => p.id_reclamo === r.id_reclamo && p.estado === 'recibido').length;
  if (!recibidos && !r.sin_presupuesto) return;
  aplicar_(r, { etapa: 3, fecha_presupuestado: hoy_() }, email, 'pasó a Presupuestado',
    r.sin_presupuesto ? 'Sin presupuesto: ' + r.sin_presupuesto_motivo : recibidos + (recibidos === 1 ? ' presupuesto recibido' : ' presupuestos recibidos'));
}

/** Alta o edición de un presupuesto. Devuelve la ficha. */
function guardarPresupuesto(idReclamo, datos) {
  const email = emailActual_();
  datos = datos || {};
  return conBloqueo_(() => {
    const r = reclamo_(idReclamo);
    exigirAbierto_(r);
    if (r.etapa < 2) throw new Error('Primero hay que evaluar el reclamo.');

    const d = {};
    d.proveedor_id = String(datos.proveedor_id || '');
    if (!proveedor_(d.proveedor_id)) throw new Error('Elegí el proveedor.');
    d.fecha_pedido = fecha_(datos.fecha_pedido, 'la fecha de pedido', true);
    d.fecha_recepcion = fecha_(datos.fecha_recepcion, 'la fecha de recepción', false);
    d.monto = monto_(datos.monto, 'el monto', false);
    // Recibido = tiene fecha de recepción y monto. Si se carga uno, hace falta el otro.
    if (d.fecha_recepcion && d.monto === '') throw new Error('Falta el monto del presupuesto recibido.');
    if (d.monto !== '' && !d.fecha_recepcion) d.fecha_recepcion = hoy_();
    d.detalle = texto_(datos.detalle, TEXTO_MAX);
    d.plazo = texto_(datos.plazo, 200);
    const recibido = d.fecha_recepcion !== '';

    let idPres = String(datos.id_presupuesto || '');
    if (idPres) {
      const p = leer_('Presupuestos').filter(x => x.id_presupuesto === idPres && x.id_reclamo === r.id_reclamo)[0];
      if (!p) throw new Error('No encontramos ese presupuesto.');
      // Un presupuesto descartado al aprobar otro sigue descartado aunque se edite.
      d.estado = p.estado === 'descartado' ? 'descartado' : (recibido ? 'recibido' : 'pedido');
      actualizar_('Presupuestos', p._fila, d);
      log_(email, r.id_reclamo, 'editó un presupuesto', nombreProveedor_(d.proveedor_id) + (recibido ? ' · ' + pesos_(d.monto) : ' · pedido'));
    } else {
      idPres = siguienteId_('Presupuestos', 'id_presupuesto', 'P', 4);
      d.id_presupuesto = idPres; d.id_reclamo = r.id_reclamo;
      d.estado = recibido ? 'recibido' : 'pedido';
      d.cargado_por = email; d.fecha_carga = new Date();
      agregar_('Presupuestos', d);
      log_(email, r.id_reclamo, recibido ? 'cargó un presupuesto' : 'pidió un presupuesto',
        nombreProveedor_(d.proveedor_id) + (recibido ? ' · ' + pesos_(d.monto) : ''));
    }
    tocar_(r);
    avanzarPresupuestado_(reclamo_(r.id_reclamo), email);
    return { ficha: ficha_(r.id_reclamo), id_presupuesto: idPres };
  });
}

/** Tilde "sin presupuesto", con motivo obligatorio. Completa la etapa 3. */
function guardarSinPresupuesto(idReclamo, activo, motivo, detalle) {
  const email = emailActual_();
  return conBloqueo_(() => {
    const r = reclamo_(idReclamo);
    exigirAbierto_(r);
    if (r.etapa < 2) throw new Error('Primero hay que evaluar el reclamo.');
    if (activo) {
      const m = opcion_(motivo, MOTIVOS_SIN_PRESUPUESTO, 'el motivo', true);
      const det = texto_(detalle, 300);
      if (m === 'Otro' && !det) throw new Error('Contá el motivo.');
      aplicar_(r, { sin_presupuesto: true, sin_presupuesto_motivo: m + (det ? ': ' + det : '') }, email,
        'marcó sin presupuesto', m + (det ? ': ' + det : ''));
      avanzarPresupuestado_(reclamo_(r.id_reclamo), email);
    } else {
      if (r.etapa >= 4) throw new Error('El reclamo ya está aprobado sin presupuesto. No se puede destildar.');
      const cambios = { sin_presupuesto: false, sin_presupuesto_motivo: '' };
      const recibidos = leer_('Presupuestos').filter(p => p.id_reclamo === r.id_reclamo && p.estado === 'recibido').length;
      if (r.etapa === 3 && !recibidos) { cambios.etapa = 2; cambios.fecha_presupuestado = ''; }
      aplicar_(r, cambios, email, 'destildó sin presupuesto', '');
    }
    return { ficha: ficha_(r.id_reclamo) };
  });
}

/* ================================================================== */
/* API · etapa 4 · Aprobado                                            */
/* ================================================================== */

/**
 * APROBACIÓN (regla de negocio): ninguna aprobación se da por sentada ni
 * depende de un monto; siempre la registra una persona. Rechazado deja el
 * reclamo En pausa hasta que se resuelva.
 */
function guardarAprobacion(id, datos) {
  const email = emailActual_();
  datos = datos || {};
  return conBloqueo_(() => {
    const r = reclamo_(id);
    exigirAbierto_(r);
    if (r.etapa < 3) throw new Error('Para aprobar hace falta al menos un presupuesto recibido, o marcar "sin presupuesto".');
    if (r.quien_paga === 'A definir') throw new Error('Antes de aprobar hay que definir quién paga (está en "A definir").');

    const resultado = opcion_(datos.resultado, ['Aprobado', 'Rechazado'], 'el resultado', true);
    if (resultado === 'Rechazado' && r.etapa >= 4) throw new Error('Este reclamo ya está aprobado.');
    const pres = leer_('Presupuestos').filter(p => p.id_reclamo === r.id_reclamo);

    const d = { aprob_resultado: resultado };
    d.aprob_quien = texto_(datos.aprob_quien, 200);
    if (!d.aprob_quien) throw new Error(resultado === 'Aprobado' ? 'Escribí quién aprobó.' : 'Escribí quién rechazó.');
    d.aprob_medio = opcion_(datos.aprob_medio, CANALES, 'el medio', true);
    d.aprob_fecha = fecha_(datos.aprob_fecha, 'la fecha', true);
    d.descuenta_alquiler = !!datos.descuenta_alquiler;
    d.aprob_notas = texto_(datos.aprob_notas, TEXTO_MAX);
    d.reparto = r.quien_paga === 'Compartido' ? texto_(datos.reparto, 500) : '';

    d.id_presupuesto_elegido = String(datos.id_presupuesto_elegido || '');
    let elegido = null;
    if (d.id_presupuesto_elegido) {
      elegido = pres.filter(p => p.id_presupuesto === d.id_presupuesto_elegido && p.fecha_recepcion !== '')[0];
      if (!elegido) throw new Error('El presupuesto elegido tiene que ser uno de los recibidos.');
    }

    if (resultado === 'Aprobado') {
      if (!r.sin_presupuesto && !elegido) throw new Error('Elegí el presupuesto que se aprobó.');
      // Con presupuesto: monto obligatorio. Sin presupuesto: monto tope, opcional.
      d.monto_aprobado = monto_(datos.monto_aprobado, 'el monto aprobado', !!elegido);
      if (r.quien_paga === 'Compartido' && !d.reparto) throw new Error('Anotá cómo se reparte el pago.');
      d.estado = 'abierto'; d.pausa_desde = '';
      if (r.etapa < 4) d.etapa = 4;
      // Los presupuestos no elegidos pasan a Descartado y siguen visibles.
      pres.forEach(p => {
        const estado = (elegido && p.id_presupuesto === elegido.id_presupuesto) ? 'recibido' : 'descartado';
        if (p.estado !== estado) actualizar_('Presupuestos', p._fila, { estado: estado });
      });
      aplicar_(r, d, email, r.etapa < 4 ? 'aprobado' : 'editó la aprobación',
        (elegido ? nombreProveedor_(elegido.proveedor_id) + ' · ' : 'Sin presupuesto · ') +
        (d.monto_aprobado !== '' ? pesos_(d.monto_aprobado) + ' · ' : '') + 'aprobó ' + d.aprob_quien + ' por ' + d.aprob_medio.toLowerCase());
    } else {
      d.monto_aprobado = '';
      d.estado = 'en_pausa';
      d.pausa_desde = hoy_();
      aplicar_(r, d, email, 'aprobación rechazada', 'Rechazó ' + d.aprob_quien + ' por ' + d.aprob_medio.toLowerCase() + '. El reclamo queda en pausa.');
    }
    return { ficha: ficha_(r.id_reclamo) };
  });
}

/* ================================================================== */
/* API · etapa 5 · Asignado (y trabajo iniciado)                       */
/* ================================================================== */

/** ¿Es un reclamo sin presupuesto porque lo arregla el inquilino con su proveedor? */
function arregloDelInquilino_(r) {
  return !!r.sin_presupuesto && String(r.sin_presupuesto_motivo).indexOf(MOTIVOS_SIN_PRESUPUESTO[0]) === 0;
}

function guardarAsignacion(id, datos) {
  const email = emailActual_();
  datos = datos || {};
  return conBloqueo_(() => {
    const r = reclamo_(id);
    exigirAbierto_(r);
    if (r.estado === 'en_pausa') throw new Error('El reclamo está en pausa: primero hay que resolver la aprobación.');
    if (r.etapa < 4) throw new Error('Primero hay que registrar la aprobación.');

    // ARREGLO DEL INQUILINO CON SU PROVEEDOR (regla de negocio, corrección del 11/11/2026): la
    // responsabilidad recae sobre el inquilino, así que en esta etapa nada es obligatorio salvo
    // el tilde "trabajo iniciado". Sin proveedor cargado queda "Proveedor del inquilino".
    const delInquilino = arregloDelInquilino_(r);
    const d = {};
    d.proveedor_id = String(datos.proveedor_id || '');
    d.proveedor_texto = d.proveedor_id ? '' : texto_(datos.proveedor_texto, 200);
    if (d.proveedor_id && !proveedor_(d.proveedor_id)) throw new Error('Elegí el proveedor.');
    if (!d.proveedor_id && !d.proveedor_texto) {
      if (!delInquilino) throw new Error('Elegí el proveedor, o escribí el nombre si es el proveedor del inquilino.');
      d.proveedor_texto = 'Proveedor del inquilino';
    }
    if (delInquilino && !datos.trabajo_iniciado) throw new Error('Tildá "Trabajo iniciado": en un arreglo del inquilino con su proveedor es lo único obligatorio de esta etapa.');
    d.fecha_asignacion = fecha_(datos.fecha_asignacion, 'la fecha de asignación', !delInquilino) || r.fecha_asignacion || hoy_();
    d.fecha_programada = fecha_(datos.fecha_programada, 'la fecha programada de inicio', !delInquilino);
    d.acceso = texto_(datos.acceso, 1000);
    d.llaves_oficina = !!datos.llaves_oficina;
    d.asig_notas = texto_(datos.asig_notas, TEXTO_MAX);
    d.fecha_estimada_fin = fecha_(datos.fecha_estimada_fin, 'la fecha estimada de finalización', false);
    d.trabajo_iniciado = !!datos.trabajo_iniciado;
    d.fecha_inicio = d.trabajo_iniciado ? (fecha_(datos.fecha_inicio, 'la fecha de inicio', false) || r.fecha_inicio || hoy_()) : '';

    const yaAsignado = r.etapa >= 5;
    const provAntes = r.proveedor_id || r.proveedor_texto, provAhora = d.proveedor_id || d.proveedor_texto;
    const cambioProv = yaAsignado && provAntes !== provAhora;
    const motivo = texto_(datos.motivo_cambio, 500);
    // CAMBIO DE PROVEEDOR: queda a criterio de Rodrigo, con motivo en el historial.
    if (cambioProv && !motivo) throw new Error('Para cambiar de proveedor escribí el motivo.');
    // REPROGRAMACIÓN: queda en el historial y se cuenta.
    const reprogramo = yaAsignado && r.fecha_programada && r.fecha_programada !== d.fecha_programada;
    if (reprogramo) d.reprogramaciones = r.reprogramaciones + 1;
    if (!yaAsignado) d.etapa = 5;

    const nombre = d.proveedor_id ? nombreProveedor_(d.proveedor_id) : d.proveedor_texto;
    let accion, detalle;
    if (!yaAsignado) { accion = 'asignado'; detalle = nombre + (d.fecha_programada ? ' · inicio programado ' + fechaAr_(d.fecha_programada) : ''); }
    else if (cambioProv) { accion = 'cambió de proveedor'; detalle = proveedorDe_(r) + ' → ' + nombre; }
    else if (d.trabajo_iniciado && !r.trabajo_iniciado) { accion = 'trabajo iniciado'; detalle = fechaAr_(d.fecha_inicio); }
    else if (reprogramo) { accion = 'reprogramó el inicio'; detalle = fechaAr_(r.fecha_programada) + ' → ' + (fechaAr_(d.fecha_programada) || 'sin fecha'); }
    else { accion = 'editó la asignación'; detalle = ''; }
    aplicar_(r, d, email, accion, detalle, cambioProv ? { motivo: motivo, proveedor_id: r.proveedor_id } : null);
    if (!yaAsignado && d.trabajo_iniciado) log_(email, r.id_reclamo, 'trabajo iniciado', fechaAr_(d.fecha_inicio));
    // DEMORA: el trabajo empezó después de la fecha programada. Queda asociada al proveedor.
    if (d.trabajo_iniciado && !r.trabajo_iniciado && d.fecha_programada && d.fecha_inicio > d.fecha_programada) {
      log_(email, r.id_reclamo, 'demora', 'Inicio demorado: programado ' + fechaAr_(d.fecha_programada) + ', empezó ' + fechaAr_(d.fecha_inicio),
        { proveedor_id: d.proveedor_id });
    }
    return { ficha: ficha_(r.id_reclamo) };
  });
}

/* ================================================================== */
/* API · etapa 6 · Terminado                                           */
/* ================================================================== */

function guardarTerminado(id, datos) {
  const email = emailActual_();
  datos = datos || {};
  return conBloqueo_(() => {
    const r = reclamo_(id);
    exigirAbierto_(r);
    if (r.estado === 'en_pausa') throw new Error('El reclamo está en pausa.');
    if (r.etapa < 5) throw new Error('Primero hay que asignar el proveedor.');
    const d = {};
    d.fecha_fin = fecha_(datos.fecha_fin, 'la fecha de finalización', true);
    d.trabajo_realizado = texto_(datos.trabajo_realizado, TEXTO_MAX);
    if (!d.trabajo_realizado) throw new Error('Describí el trabajo realizado.');
    d.verificacion = opcion_(datos.verificacion, VERIFICACION, 'cómo se verificó', true);
    d.term_notas = texto_(datos.term_notas, TEXTO_MAX);
    const primera = r.etapa < 6;
    if (primera) d.etapa = 6;
    aplicar_(r, d, email, primera ? 'terminado' : 'editó la finalización',
      fechaAr_(d.fecha_fin) + ' · ' + d.verificacion.toLowerCase());
    // DEMORA: terminó después de la fecha estimada de finalización. Queda asociada al proveedor.
    if (primera && r.fecha_estimada_fin && d.fecha_fin > r.fecha_estimada_fin) {
      log_(email, r.id_reclamo, 'demora', 'Obra demorada: estimada ' + fechaAr_(r.fecha_estimada_fin) + ', terminó ' + fechaAr_(d.fecha_fin),
        { proveedor_id: r.proveedor_id });
    }
    return { ficha: ficha_(r.id_reclamo) };
  });
}

/* ================================================================== */
/* API · etapa 7 · Cerrado                                             */
/* ================================================================== */

/**
 * CIERRE (regla de negocio). No existe "sin respuesta": sin conformidad el
 * reclamo se queda en 90%. Con conformidad en No, no cierra: se elige entre
 * reabrir hacia la etapa 5 o cerrar igual con motivo obligatorio.
 */
function guardarCierre(id, datos) {
  const email = emailActual_();
  datos = datos || {};
  return conBloqueo_(() => {
    const r = reclamo_(id);
    exigirAbierto_(r);
    if (r.etapa !== 6) throw new Error('Para cerrar, el reclamo tiene que estar Terminado.');

    const conforme = datos.conformidad !== false;
    if (!conforme && datos.accion === 'reabrir') {
      reabrir_(r, texto_(datos.motivo, 500), email, 'Sin conformidad');
      return { ficha: ficha_(r.id_reclamo) };
    }

    const d = {};
    d.costo_final = monto_(datos.costo_final, 'el costo final', true);   // admite 0
    d.conformidad = conforme ? 'Sí' : 'No';
    d.conformidad_quien = opcion_(datos.conformidad_quien, CONFORMIDAD_QUIEN, 'quién dio la conformidad', true);
    d.fecha_cierre = fecha_(datos.fecha_cierre, 'la fecha de cierre', true);
    d.cierre_notas = texto_(datos.cierre_notas, TEXTO_MAX);
    // La calificación no aplica cuando el proveedor es del inquilino (texto libre).
    d.calificacion = '';
    if (r.proveedor_id && datos.calificacion !== '' && datos.calificacion !== null && datos.calificacion !== undefined) {
      const c = Number(datos.calificacion);
      if ([1, 2, 3, 4, 5].indexOf(c) === -1) throw new Error('La calificación va de 1 a 5.');
      d.calificacion = c;
    }
    d.cierre_sin_conformidad_motivo = '';
    if (!conforme) {
      if (datos.accion !== 'cerrar_igual') throw new Error('Sin conformidad el reclamo no cierra: elegí entre reabrirlo o cerrarlo igual.');
      d.cierre_sin_conformidad_motivo = texto_(datos.motivo, 500);
      if (!d.cierre_sin_conformidad_motivo) throw new Error('Para cerrar sin conformidad escribí el motivo.');
    }
    d.etapa = 7; d.estado = 'cerrado';
    aplicar_(r, d, email, conforme ? 'cerrado' : 'cerrado sin conformidad',
      'Costo final ' + pesos_(d.costo_final) + (conforme ? ' · conformidad de ' + d.conformidad_quien.toLowerCase() : ''),
      conforme ? null : { motivo: d.cierre_sin_conformidad_motivo });
    return { ficha: ficha_(r.id_reclamo) };
  });
}

/* ================================================================== */
/* API · estados fuera de la línea principal                           */
/* ================================================================== */

function desestimar_(r, motivo, detalle, email) {
  const m = opcion_(motivo, MOTIVOS_DESEST, 'el motivo', true);
  const det = texto_(detalle, 500);
  if (m === 'Otro' && !det) throw new Error('Contá el motivo.');
  aplicar_(r, { estado: 'desestimado', desest_motivo: m, desest_detalle: det, desest_fecha: new Date(), desest_por: email, pausa_desde: '' },
    email, 'desestimado', m + (det ? ': ' + det : ''), { motivo: m });
}

/** Salida lateral con motivo obligatorio. */
function desestimar(id, motivo, detalle) {
  const email = emailActual_();
  return conBloqueo_(() => {
    const r = reclamo_(id);
    exigirAbierto_(r);
    desestimar_(r, motivo, detalle, email);
    return { ficha: ficha_(r.id_reclamo) };
  });
}

/**
 * REABRIR (regla de negocio): un reclamo Terminado o Cerrado puede reabrirse
 * con motivo y vuelve a la etapa 5. Se cuenta, y queda asociado al proveedor.
 */
function reabrir_(r, motivo, email, prefijo) {
  if (!motivo) throw new Error('Para reabrir escribí el motivo.');
  if (r.estado === 'desestimado') throw new Error('Un reclamo desestimado no se reabre.');
  if (r.etapa < 6) throw new Error('Solo se reabren reclamos Terminados o Cerrados.');
  const previo = 'Trabajo anterior (' + fechaAr_(r.fecha_fin) + '): ' + r.trabajo_realizado;
  aplicar_(r, {
    estado: 'abierto', etapa: 5, reaperturas: r.reaperturas + 1,
    trabajo_iniciado: false, fecha_inicio: '', fecha_estimada_fin: '', fecha_programada: '',
    fecha_fin: '', trabajo_realizado: '', verificacion: '', term_notas: '',
    costo_final: '', conformidad: '', conformidad_quien: '', fecha_cierre: '', calificacion: '', cierre_notas: '',
    cierre_sin_conformidad_motivo: ''
  }, email, 'reabierto', (prefijo ? prefijo + '. ' : '') + previo, { motivo: motivo, proveedor_id: r.proveedor_id, sinAuditoria: true });
}

function reabrir(id, motivo) {
  const email = emailActual_();
  return conBloqueo_(() => {
    const r = reclamo_(id);
    reabrir_(r, texto_(motivo, 500), email, '');
    return { ficha: ficha_(r.id_reclamo) };
  });
}

/** Nota en el panel lateral. Escriben los tres usuarios. */
function agregarNota(id, texto) {
  const email = emailActual_();
  const t = texto_(texto, TEXTO_MAX);
  if (!t) throw new Error('Escribí la nota.');
  return conBloqueo_(() => {
    const r = reclamo_(id);
    agregar_('Notas', { id_nota: siguienteId_('Notas', 'id_nota', 'N', 5), id_reclamo: r.id_reclamo, fecha: new Date(), usuario: email, texto: t });
    tocar_(r);
    return { ficha: ficha_(r.id_reclamo) };
  });
}

/* ================================================================== */
/* API · proveedores y rubros (sección 9 del diseño)                   */
/* ================================================================== */

/**
 * Estadísticas calculadas por proveedor: trabajos realizados y en curso,
 * calificación promedio, reaperturas, demoras (empezó o terminó tarde), días promedio para
 * presupuestar y monto total. Los desestimados no cuentan.
 */
function estadisticas_() {
  const hoy = hoy_(), e = {};
  const de = id => e[id] || (e[id] = { realizados: 0, en_curso: 0, calificaciones: [], reaperturas: 0, demoras: 0,
    dias_presupuesto: [], monto_total: 0, reclamos: [] });

  leer_('Reclamos').forEach(r => {
    if (!r.proveedor_id || r.estado === 'desestimado') return;
    const s = de(r.proveedor_id);
    s.reclamos.push({ id_reclamo: r.id_reclamo, direccion: r.direccion, id_propiedad: r.id_propiedad,
      estado: r.estado, etapa_nombre: nombreEtapa_(r), fecha_reclamo: r.fecha_reclamo });
    if (r.etapa >= 6) s.realizados++; else if (r.etapa === 5) s.en_curso++;
    if (r.calificacion !== '') s.calificaciones.push(r.calificacion);
    if (r.estado === 'cerrado' && r.costo_final !== '') s.monto_total += r.costo_final;
    // DEMORA en curso: hoy está vencido el inicio o la finalización. Las ya ocurridas salen del historial.
    if (r.etapa === 5 && r.estado === 'abierto' && ((!r.trabajo_iniciado && r.fecha_programada && r.fecha_programada < hoy) ||
        (r.fecha_estimada_fin && r.fecha_estimada_fin < hoy))) s.demoras++;
  });
  leer_('Historial').forEach(h => {
    if (!h.proveedor_id) return;
    if (h.accion === 'reabierto') de(h.proveedor_id).reaperturas++;
    if (h.accion === 'demora') de(h.proveedor_id).demoras++;
  });
  leer_('Presupuestos').forEach(p => {
    if (p.fecha_recepcion && p.fecha_pedido) de(p.proveedor_id).dias_presupuesto.push(Math.max(0, diasEntre_(p.fecha_pedido, p.fecha_recepcion)));
  });
  const prom = l => l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length * 10) / 10 : '';
  Object.keys(e).forEach(id => {
    e[id].calificacion = prom(e[id].calificaciones);
    e[id].dias_presupuestar = prom(e[id].dias_presupuesto);
    delete e[id].calificaciones; delete e[id].dias_presupuesto;
  });
  return e;
}

/** Lista corta para los desplegables: activos y de baja, con su calificación promedio. */
function proveedoresResumen_() {
  const e = estadisticas_();
  return leer_('Proveedores').map(p => ({
    id_proveedor: p.id_proveedor, nombre: p.nombre, telefono: p.telefono, estado: p.estado,
    rubros: p.rubros ? p.rubros.split(',') : [], calificacion: e[p.id_proveedor] ? e[p.id_proveedor].calificacion : ''
  })).sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/** Pantalla Proveedores: fichas completas con estadísticas, y rubros. */
function getProveedores() {
  emailActual_();
  const e = estadisticas_();
  const vacio = { realizados: 0, en_curso: 0, calificacion: '', reaperturas: 0, demoras: 0, dias_presupuestar: '', monto_total: 0, reclamos: [] };
  return {
    proveedores: leer_('Proveedores').map(p => {
      const c = limpio_(p);
      c.rubros = p.rubros ? p.rubros.split(',') : [];
      c.cargado_por_nombre = nombreDe_(p.cargado_por);
      c.stats = e[p.id_proveedor] || vacio;
      return c;
    }).sort((a, b) => a.nombre.localeCompare(b.nombre)),
    rubros: rubros_().map(r => {
      const c = limpio_(r);
      c.usado = leer_('Reclamos').some(x => x.rubro_id === r.id_rubro) || leer_('Proveedores').some(p => (',' + p.rubros + ',').indexOf(',' + r.id_rubro + ',') !== -1);
      return c;
    })
  };
}

function soloDigitos_(s) { return String(s || '').replace(/\D/g, ''); }

/**
 * Alta o edición de proveedor. Al dar de alta avisa si ya existe uno con el
 * mismo nombre o teléfono: devuelve { duplicados } y no guarda, salvo que venga
 * confirmado = true.
 */
function guardarProveedor(datos, confirmado) {
  const email = emailActual_();
  datos = datos || {};
  const d = {};
  d.nombre = texto_(datos.nombre, 200).replace(/\s+/g, ' ');
  if (!d.nombre) throw new Error('Escribí el nombre o la razón social.');
  d.contacto = texto_(datos.contacto, 200);
  d.telefono = texto_(datos.telefono, 100);
  if (!d.telefono) throw new Error('Escribí el teléfono.');
  d.mail = texto_(datos.mail, 200);
  d.notas = texto_(datos.notas, TEXTO_MAX);
  const ids = (datos.rubros || []).map(String);

  return conBloqueo_(() => {
    const validos = rubros_().map(r => r.id_rubro);
    const rubros = ids.filter((x, i) => validos.indexOf(x) !== -1 && ids.indexOf(x) === i);
    if (!rubros.length) throw new Error('Elegí al menos un rubro.');
    d.rubros = rubros.join(',');

    const id = String(datos.id_proveedor || '');
    const otros = leer_('Proveedores').filter(p => p.id_proveedor !== id);
    const tel = soloDigitos_(d.telefono);
    const duplicados = otros.filter(p => p.nombre.toLowerCase() === d.nombre.toLowerCase() ||
      (tel.length >= 6 && soloDigitos_(p.telefono) === tel));
    if (duplicados.length && !confirmado) {
      return { duplicados: duplicados.map(p => ({ id_proveedor: p.id_proveedor, nombre: p.nombre, telefono: p.telefono, estado: p.estado })) };
    }

    let guardado = id;
    if (id) {
      const p = proveedor_(id);
      if (!p) throw new Error('No encontramos ese proveedor.');
      actualizar_('Proveedores', p._fila, d);
    } else {
      guardado = siguienteId_('Proveedores', 'id_proveedor', 'PR', 3);
      d.id_proveedor = guardado; d.estado = 'activo'; d.fecha_alta = new Date(); d.cargado_por = email;
      d.baja_motivo = ''; d.baja_fecha = '';
      agregar_('Proveedores', d);
    }
    return { ok: true, id_proveedor: guardado, proveedores: proveedoresResumen_() };
  });
}

/** La baja no borra nada: el proveedor deja de aparecer en los desplegables y conserva su historial. */
function bajaProveedor(id, motivo) {
  emailActual_();
  const m = texto_(motivo, 500);
  if (!m) throw new Error('Escribí el motivo de la baja.');
  return conBloqueo_(() => {
    const p = proveedor_(id);
    if (!p) throw new Error('No encontramos ese proveedor.');
    actualizar_('Proveedores', p._fila, { estado: 'baja', baja_motivo: m, baja_fecha: new Date() });
    return { ok: true };
  });
}

function reactivarProveedor(id) {
  emailActual_();
  return conBloqueo_(() => {
    const p = proveedor_(id);
    if (!p) throw new Error('No encontramos ese proveedor.');
    actualizar_('Proveedores', p._fila, { estado: 'activo', baja_motivo: '', baja_fecha: '' });
    return { ok: true };
  });
}

/** Rubros: se agregan, renombran y desactivan. Un rubro usado no se borra (acá no se borra ninguno). */
function guardarRubro(datos) {
  emailActual_();
  datos = datos || {};
  const nombre = texto_(datos.nombre, 80).replace(/\s+/g, ' ');
  if (!nombre) throw new Error('Escribí el nombre del rubro.');
  return conBloqueo_(() => {
    const id = String(datos.id_rubro || '');
    if (rubros_().some(r => r.id_rubro !== id && r.nombre.toLowerCase() === nombre.toLowerCase())) {
      throw new Error('Ya hay un rubro con ese nombre.');
    }
    if (id) {
      const r = rubros_().filter(x => x.id_rubro === id)[0];
      if (!r) throw new Error('No encontramos ese rubro.');
      actualizar_('Rubros', r._fila, { nombre: nombre, activo: datos.activo !== false });
    } else {
      agregar_('Rubros', { id_rubro: siguienteId_('Rubros', 'id_rubro', 'RU', 2), nombre: nombre, activo: true });
    }
    return { ok: true, rubros: rubros_().map(limpio_) };
  });
}

/* ================================================================== */
/* Drive · adjuntos (una carpeta por reclamo)                          */
/* ================================================================== */

function raiz_() {
  const id = prop_('ROOT_FOLDER_ID');
  if (!id) throw new Error('La app todavía no está instalada: falta ejecutar instalar() desde el editor.');
  try { return DriveApp.getFolderById(id); }
  catch (e) { throw new Error('No se pudo abrir la carpeta Reclamos en Drive. Avisale a Máximo.'); }
}

/**
 * Sube UN archivo a la carpeta del reclamo. La pantalla los manda de a uno.
 * El archivo se guarda tal cual; solo cambia el nombre a R-0001_seccion_NNN.ext.
 * Acepta fotos, videos, PDF, Word y otros formatos comunes, hasta MAX_ARCHIVO_MB.
 */
function subirArchivo(idReclamo, seccion, idPresupuesto, base64, nombreOriginal, mime) {
  const email = emailActual_();
  if (SECCIONES.indexOf(seccion) === -1) throw new Error('Sección de adjuntos desconocida.');
  if (!base64) throw new Error('El archivo llegó vacío. Probá subirlo de nuevo.');
  nombreOriginal = String(nombreOriginal || 'archivo').replace(/[\\\/]/g, '_').slice(0, 200);
  mime = String(mime || '') || 'application/octet-stream';
  const bytes = Utilities.base64Decode(base64);
  if (bytes.length > MAX_ARCHIVO_MB * 1024 * 1024) {
    throw new Error('Este archivo es demasiado grande (máximo ' + MAX_ARCHIVO_MB + ' MB).');
  }

  return conBloqueo_(() => {
    const r = reclamo_(idReclamo);
    idPresupuesto = String(idPresupuesto || '');
    if (seccion === 'presupuesto' && !leer_('Presupuestos').some(p => p.id_presupuesto === idPresupuesto && p.id_reclamo === r.id_reclamo)) {
      throw new Error('No encontramos el presupuesto de ese adjunto.');
    }
    const n = leer_('Adjuntos').filter(a => a.id_reclamo === r.id_reclamo && a.seccion === seccion).length + 1;
    const nombre = r.id_reclamo + '_' + seccion + '_' + pad_(n, 3) + '.' + extension_(nombreOriginal);
    const archivo = DriveApp.getFolderById(idDeUrl_(r.carpeta_url)).createFile(Utilities.newBlob(bytes, mime, nombre));
    archivo.setDescription('Nombre original: ' + nombreOriginal + ' · subido por ' + email);
    const adj = {
      id_adjunto: siguienteId_('Adjuntos', 'id_adjunto', 'A', 6), id_reclamo: r.id_reclamo, seccion: seccion,
      id_presupuesto: seccion === 'presupuesto' ? idPresupuesto : '', nombre: nombre, nombre_original: nombreOriginal,
      mime: mime, tamano: bytes.length, drive_id: archivo.getId(), subido_por: email, fecha: new Date(),
      en_biprop: SECCIONES_BIPROP[seccion] ? 'pendiente' : 'no va'
    };
    agregar_('Adjuntos', adj);
    tocar_(r);
    return { id_adjunto: adj.id_adjunto, nombre: nombre };
  });
}

/* ================================================================== */
/* Integración con Biprop (sección 8 del diseño)                       */
/* ================================================================== */

function bipropActivo_() { return cfgSi_('biprop_activo') && !!prop_('BIPROP_URL') && !!prop_('BIPROP_TOKEN'); }

/**
 * PADRÓN DE PROPIEDADES: es el de Biprop (hoja "Propiedades" de su planilla),
 * solo lectura. Se suman las propiedades que figuran en reclamos y todavía no
 * están en Biprop (se dan de alta ahí al enviar el primer adjunto).
 */
function padron_() {
  if (CACHE_._padron) return CACHE_._padron;
  const lista = [], visto = {};
  const id = prop_('BIPROP_SHEET_ID');
  if (id) {
    try {
      const sh = SpreadsheetApp.openById(id).getSheetByName('Propiedades');
      const datos = sh.getDataRange().getValues();
      const cab = datos[0].map(String);
      const cId = cab.indexOf('id'), cDir = cab.indexOf('direccion'), cEst = cab.indexOf('estado');
      for (let i = 1; i < datos.length; i++) {
        const n = Number(datos[i][cId]);
        if (!n || String(datos[i][cEst]) !== 'activa' || visto[n]) continue;
        visto[n] = true;
        lista.push({ id: n, direccion: String(datos[i][cDir]), enBiprop: true });
      }
    } catch (e) { /* si Biprop no se puede leer, se sigue con las propiedades de los reclamos */ }
  }
  leer_('Reclamos').forEach(r => {
    if (!r.id_propiedad || visto[r.id_propiedad]) return;
    visto[r.id_propiedad] = true;
    lista.push({ id: r.id_propiedad, direccion: r.direccion, enBiprop: false });
  });
  lista.sort((a, b) => a.id - b.id);
  CACHE_._padron = lista;
  return lista;
}

/** Llama a la puerta de servicio de Biprop. Devuelve el JSON de respuesta o lanza un error legible. */
function bipropLlamar_(accion, datos) {
  const url = prop_('BIPROP_URL'), token = prop_('BIPROP_TOKEN');
  if (!url || !token) throw new Error('Biprop no está configurado en esta app.');
  let r;
  try {
    r = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(Object.assign({ token: token, accion: accion }, datos || {})),
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true, followRedirects: true
    });
  } catch (e) { throw new Error('No se pudo conectar con Biprop: ' + (e.message || e)); }
  let j = null;
  try { j = JSON.parse(r.getContentText() || ''); } catch (e) { j = null; }
  if (!j) throw new Error('Biprop respondió algo inesperado (HTTP ' + r.getResponseCode() + ').');
  if (!j.ok) throw new Error(j.error || 'Biprop devolvió un error.');
  return j;
}

/** Texto del evento de Biprop: descripción o trabajo realizado, número de reclamo, autor y proveedor. */
function eventoBiprop_(r, seccion, email) {
  const corta = t => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > 60 ? s.slice(0, 57).trim() + '...' : s; };
  if (seccion === 'ingreso') {
    return {
      tipo: 'RECLAMO', fecha_evento: r.fecha_reclamo, descripcion: r.id_reclamo + ' · ' + corta(r.descripcion),
      origen: r.quien_reclama === 'Inquilino' ? 'inquilino' : r.quien_reclama === 'Propietario' ? 'propietario' : 'JB',
      notas: r.descripcion + '\n\nReclamo ' + r.id_reclamo + ' · cargado por ' + nombreDe_(r.cargado_por) + ' en Pipeline Reclamos.',
      reclamo_vinculado: ''
    };
  }
  return {
    tipo: 'REPARACION', fecha_evento: r.fecha_fin || hoy_(), descripcion: r.id_reclamo + ' · ' + corta(r.trabajo_realizado || 'Reparación'),
    origen: 'proveedor',
    notas: (r.trabajo_realizado || '') + '\n\nReclamo ' + r.id_reclamo + ' · proveedor: ' + (proveedorDe_(r) || 'sin proveedor') +
      ' · cargado por ' + nombreDe_(email) + ' en Pipeline Reclamos.',
    reclamo_vinculado: r.biprop_evento_ingreso || ''
  };
}

/**
 * Envía a Biprop los adjuntos pendientes del ingreso y de la finalización de
 * un reclamo. Son dos eventos separados en la bitácora de la propiedad. Los
 * adjuntos que se suben más tarde se agregan al mismo evento, o lo crean si no
 * existía. Nunca lanza: devuelve { enviados, aviso }.
 */
function sincronizarBiprop_(idReclamo, email) {
  if (!bipropActivo_()) return { enviados: 0, aviso: '' };
  let enviados = 0;
  try {
    ['ingreso', 'terminado'].forEach(seccion => {
      let r = reclamo_(idReclamo);
      const pendientes = leer_('Adjuntos').filter(a => a.id_reclamo === r.id_reclamo && a.seccion === seccion && a.en_biprop === 'pendiente');
      if (!pendientes.length) return;
      // El evento de finalización se crea recién con la etapa 6 completa (lleva el trabajo realizado y el proveedor).
      if (seccion === 'terminado' && r.etapa < 6) return;
      const colEvento = seccion === 'ingreso' ? 'biprop_evento_ingreso' : 'biprop_evento_fin';
      const colUrl = seccion === 'ingreso' ? 'biprop_url_ingreso' : 'biprop_url_fin';
      let idEvento = r[colEvento];
      if (!idEvento) {
        const ev = eventoBiprop_(r, seccion, email);
        const res = bipropLlamar_('crearEventoReclamo', Object.assign(ev, {
          id_propiedad: r.id_propiedad, direccion: r.direccion, cargado_por: email
        }));
        idEvento = res.id_evento;
        const c = {}; c[colEvento] = idEvento; c[colUrl] = res.carpeta_url || '';
        actualizar_('Reclamos', r._fila, c);
        log_(email, r.id_reclamo, 'evento en Biprop', (seccion === 'ingreso' ? 'Ingreso' : 'Finalización') + ' · ' + idEvento);
      }
      pendientes.forEach(a => {
        bipropLlamar_('copiarArchivo', { id_evento: idEvento, file_id: a.drive_id, nombre_original: a.nombre_original, subido_por: a.subido_por });
        const fila = leer_('Adjuntos').filter(x => x.id_adjunto === a.id_adjunto)[0]._fila;
        actualizar_('Adjuntos', fila, { en_biprop: 'sí' });
        enviados++;
      });
    });
    return { enviados: enviados, aviso: '' };
  } catch (e) {
    return { enviados: enviados, aviso: 'No se pudo enviar todo a Biprop (' + (e.message || e) + '). Queda pendiente y se reintenta solo.' };
  }
}

/** La pantalla la llama después de subir adjuntos del ingreso o de la finalización. */
function sincronizarBiprop(idReclamo) {
  const email = emailActual_();
  const res = conBloqueo_(() => sincronizarBiprop_(String(idReclamo), email));
  res.ficha = ficha_(String(idReclamo));
  return res;
}

/** Reintenta todo lo pendiente. Corre sola una vez por hora (tic) y se puede ejecutar desde el editor. */
function enviarPendientesBiprop() {
  soloDuenio_();
  if (!bipropActivo_()) return 'Biprop está apagado en la hoja Config (biprop_activo).';
  const ids = {};
  leer_('Adjuntos').forEach(a => { if (a.en_biprop === 'pendiente') ids[a.id_reclamo] = true; });
  let enviados = 0; const avisos = [];
  Object.keys(ids).forEach(id => {
    const res = conBloqueo_(() => sincronizarBiprop_(id, OWNER));
    enviados += res.enviados;
    if (res.aviso) avisos.push(id + ': ' + res.aviso);
  });
  const msg = 'Adjuntos enviados a Biprop: ' + enviados + (avisos.length ? '\n' + avisos.join('\n') : '');
  Logger.log(msg);
  return msg;
}

/* ================================================================== */
/* API · historial (cerrados y desestimados) y exportación             */
/* ================================================================== */

function getHistorial() {
  emailActual_();
  const hoy = hoy_(), fotos = fotosIngreso_();
  return {
    reclamos: leer_('Reclamos').filter(r => r.estado === 'cerrado' || r.estado === 'desestimado')
      .map(r => vista_(r, hoy, fotos))
      .sort((a, b) => (b.fecha_cierre || b.desest_fecha) < (a.fecha_cierre || a.desest_fecha) ? -1 : 1)
  };
}

/** Exporta a una planilla nueva los reclamos indicados (lo filtrado en pantalla). Devuelve el link. */
function exportarHistorial(ids) {
  const email = emailActual_();
  const elegidos = {};
  (ids || []).forEach(id => { elegidos[String(id)] = true; });
  const filas = leer_('Reclamos').filter(r => elegidos[r.id_reclamo]);
  if (!filas.length) throw new Error('No hay reclamos para exportar con esos filtros.');

  const cab = ['N°', 'Estado', 'Propiedad', 'Dirección', 'Fecha del reclamo', 'Canal', 'Quién reclama', 'Descripción',
    'Rubro', 'Urgencia', 'Quién paga', 'Proveedor', 'Monto aprobado', 'Fecha de finalización', 'Trabajo realizado',
    'Costo final', 'Conformidad', 'Fecha de cierre', 'Calificación', 'Reaperturas', 'Motivo de desestimación', 'Días abierto'];
  const datos = filas.map(r => {
    const fin = r.estado === 'cerrado' ? r.fecha_cierre : String(r.desest_fecha).slice(0, 10);
    return [r.id_reclamo, r.estado === 'cerrado' ? 'Cerrado' : 'Desestimado', pad4_(r.id_propiedad), r.direccion,
      fechaAr_(r.fecha_reclamo), r.canal, r.quien_reclama, r.descripcion, nombreRubro_(r.rubro_id), r.urgencia,
      r.quien_paga, proveedorDe_(r), r.monto_aprobado, fechaAr_(r.fecha_fin), r.trabajo_realizado, r.costo_final,
      r.conformidad, fechaAr_(r.fecha_cierre), r.calificacion, r.reaperturas,
      r.desest_motivo + (r.desest_detalle ? ': ' + r.desest_detalle : ''), Math.max(0, diasEntre_(r.fecha_reclamo, fin))];
  });
  const nombre = 'Reclamos · exportación ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH-mm');
  const ss = SpreadsheetApp.create(nombre);
  const sh = ss.getSheets()[0];
  sh.getRange(1, 1, 1, cab.length).setValues([cab]).setFontWeight('bold');
  const rango = sh.getRange(2, 1, datos.length, cab.length);
  rango.setNumberFormat('@');
  rango.setValues(datos.map(f => f.map(v => String(v === null || v === undefined ? '' : v))));
  sh.setFrozenRows(1);
  const archivo = DriveApp.getFileById(ss.getId());
  try { archivo.moveTo(subcarpeta_(raiz_(), CARPETA_EXPORT)); } catch (e) {}
  try { archivo.addViewer(email); } catch (e) {}
  return { url: ss.getUrl(), nombre: nombre, cantidad: datos.length };
}

/* ================================================================== */
/* API · supervisión (sección 10 del diseño; se revisa con el uso)     */
/* ================================================================== */

function getSupervision() {
  emailActual_();
  const todos = leer_('Reclamos');
  const validos = todos.filter(r => r.estado !== 'desestimado');   // los desestimados no cuentan en las métricas
  const abiertos = validos.filter(r => r.estado !== 'cerrado');
  const prom = l => l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length * 10) / 10 : '';

  // Reclamos abiertos por etapa.
  const porEtapa = ETAPAS.filter(e => e.n < 7).map(e => ({ etapa: e.nombre, cantidad: abiertos.filter(r => r.etapa === e.n).length }));

  // Tiempo promedio por etapa: días entre que se completó una etapa y la siguiente.
  const hitos = r => [String(r.fecha_carga).slice(0, 10), r.fecha_evaluacion, r.fecha_presupuestado, r.aprob_resultado === 'Aprobado' ? r.aprob_fecha : '',
    r.fecha_asignacion, r.fecha_fin, r.fecha_cierre];
  const tramos = ['Ingresado → Evaluado', 'Evaluado → Presupuestado', 'Presupuestado → Aprobado', 'Aprobado → Asignado',
    'Asignado → Terminado', 'Terminado → Cerrado'];
  const dur = tramos.map(() => []);
  validos.forEach(r => {
    const h = hitos(r);
    for (let i = 0; i < 6; i++) if (h[i] && h[i + 1] && r.etapa >= i + 2) dur[i].push(Math.max(0, diasEntre_(h[i], h[i + 1])));
  });
  const porTramo = tramos.map((t, i) => ({ tramo: t, dias: prom(dur[i]), casos: dur[i].length }));

  // De punta a punta (fecha del reclamo a cierre), por rubro y por urgencia. Solo cerrados.
  const cerrados = validos.filter(r => r.estado === 'cerrado' && r.fecha_cierre);
  const total = r => Math.max(0, diasEntre_(r.fecha_reclamo, r.fecha_cierre));
  const agrupar = (lista, clave, etiqueta) => {
    const g = {};
    lista.forEach(r => { const k = clave(r); (g[k] = g[k] || []).push(r); });
    return Object.keys(g).map(k => ({ nombre: etiqueta(k), dias: prom(g[k].map(total)), casos: g[k].length,
      costo: g[k].reduce((a, r) => a + (Number(r.costo_final) || 0), 0) }));
  };
  const porRubro = agrupar(cerrados, r => r.rubro_id, k => nombreRubro_(k) || 'Sin rubro').sort((a, b) => b.casos - a.casos);
  const porUrgencia = agrupar(cerrados, r => String(r.urgencia), k => k ? 'Urgencia ' + k : 'Sin urgencia')
    .sort((a, b) => a.nombre < b.nombre ? 1 : -1);

  // Ingresados, cerrados y costo por mes (últimos 12 meses).
  const meses = [], hoy = hoy_();
  let y = +hoy.slice(0, 4), m = +hoy.slice(5, 7);
  for (let i = 0; i < 12; i++) { meses.unshift(y + '-' + pad_(m, 2)); m--; if (!m) { m = 12; y--; } }
  const porMes = meses.map(mes => ({
    mes: mes.slice(5) + '/' + mes.slice(0, 4),
    ingresados: validos.filter(r => r.fecha_reclamo.slice(0, 7) === mes).length,
    cerrados: cerrados.filter(r => r.fecha_cierre.slice(0, 7) === mes).length,
    costo: cerrados.filter(r => r.fecha_cierre.slice(0, 7) === mes).reduce((a, r) => a + (Number(r.costo_final) || 0), 0)
  }));

  // Ranking de proveedores.
  const e = estadisticas_();
  const ranking = leer_('Proveedores').map(p => {
    const s = e[p.id_proveedor] || {};
    return { nombre: p.nombre, estado: p.estado, realizados: s.realizados || 0, en_curso: s.en_curso || 0,
      calificacion: s.calificacion === undefined ? '' : s.calificacion, reaperturas: s.reaperturas || 0,
      demoras: s.demoras || 0, monto_total: s.monto_total || 0 };
  }).filter(p => p.realizados || p.en_curso)
    .sort((a, b) => (Number(b.calificacion) || 0) - (Number(a.calificacion) || 0) || b.realizados - a.realizados);

  // Propiedades con más reclamos.
  const pp = {};
  validos.forEach(r => {
    const k = r.id_propiedad;
    pp[k] = pp[k] || { id: k, direccion: r.direccion, total: 0, abiertos: 0 };
    pp[k].total++; if (r.estado !== 'cerrado') pp[k].abiertos++;
  });
  const propiedades = Object.keys(pp).map(k => pp[k]).sort((a, b) => b.total - a.total).slice(0, 15);

  return {
    resumen: { abiertos: abiertos.length, cerrados: cerrados.length, desestimados: todos.length - validos.length,
      punta_a_punta: prom(cerrados.map(total)) },
    porEtapa: porEtapa, porTramo: porTramo, porRubro: porRubro, porUrgencia: porUrgencia, porMes: porMes,
    ranking: ranking, propiedades: propiedades
  };
}

/* ================================================================== */
/* Mails (sección 11 del diseño)                                       */
/* ================================================================== */

function urlApp_() {
  const u = config_().url_app;
  if (u) return u;
  try { return ScriptApp.getService().getUrl() || PAGES_URL; } catch (e) { return PAGES_URL; }
}
function linkFicha_(id) { const u = urlApp_(); return u + (u.indexOf('?') === -1 ? '?' : '&') + 'r=' + encodeURIComponent(id); }

const MAIL_TD = 'padding:7px 10px;border-bottom:1px solid #e3e7ed;font:13px Arial,sans-serif;color:#1b2330;vertical-align:top';
const MAIL_TH = 'padding:7px 10px;border-bottom:2px solid #c5cbd4;font:bold 12px Arial,sans-serif;color:#4a5361;text-align:left';

function tablaMail_(cab, filas) {
  return '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:900px">' +
    '<tr>' + cab.map(c => '<th style="' + MAIL_TH + '">' + c + '</th>').join('') + '</tr>' +
    filas.map(f => '<tr>' + f.map(c => '<td style="' + MAIL_TD + '">' + c + '</td>').join('') + '</tr>').join('') + '</table>';
}
function marcoMail_(titulo, cuerpo) {
  return '<div style="font:14px Arial,sans-serif;color:#1b2330;max-width:920px">' +
    '<h2 style="font:bold 18px Arial,sans-serif;color:#10295a;margin:0 0 12px">' + titulo + '</h2>' + cuerpo +
    '<p style="font:12px Arial,sans-serif;color:#6d7888;margin-top:18px">Pipeline Reclamos · Juárez Beltrán · mail automático</p></div>';
}
function filaMail_(v) {
  const marcas = v.alertas.map(a => '<b style="color:#8a1c1c">' + htmlEsc_(a) + '</b>').concat(v.avisos.map(htmlEsc_)).join(' · ');
  return ['<a href="' + linkFicha_(v.id_reclamo) + '" style="color:#1f5fbf;font-weight:bold">' + v.id_reclamo + '</a>',
    pad4_(v.id_propiedad) + ' · ' + htmlEsc_(v.direccion), htmlEsc_(v.etapa_nombre) + ' · ' + v.pct + '%',
    v.urgencia === '' ? '—' : String(v.urgencia), String(v.dias_sin_mov), marcas || '—'];
}

/**
 * DIARIO A RODRIGO: un único mail con todos los reclamos abiertos, en el mismo
 * orden que el tablero. Si no hay reclamos abiertos, no se envía.
 */
function enviarDiario() {
  soloDuenio_();
  const para = cfgLista_('mail_diario_para');
  const lista = abiertos_();
  if (!lista.length || !para.length) return 'Sin envío: ' + (lista.length ? 'no hay destinatarios' : 'no hay reclamos abiertos');
  const conAlerta = lista.filter(v => v.alertas.length).length;
  const html = marcoMail_('Reclamos abiertos · ' + fechaAr_(hoy_()),
    '<p>' + lista.length + (lista.length === 1 ? ' reclamo abierto' : ' reclamos abiertos') +
    (conAlerta ? ', <b style="color:#8a1c1c">' + conAlerta + ' con alerta</b>' : '') + '. <a href="' + urlApp_() + '">Abrir el tablero</a></p>' +
    tablaMail_(['N°', 'Propiedad', 'Etapa', 'Urg.', 'Días sin mov.', 'Alertas y avisos'], lista.map(filaMail_)));
  MailApp.sendEmail({ to: para.join(','), subject: 'Reclamos abiertos: ' + lista.length + (conAlerta ? ' (' + conAlerta + ' con alerta)' : ''),
    htmlBody: html, name: APP_NOMBRE });
  return 'Diario enviado a ' + para.join(', ');
}

/** SEMANAL A GERARDO Y A MÁXIMO: sobre la semana anterior (lunes a domingo). */
function enviarSemanal() {
  soloDuenio_();
  const para = cfgLista_('mail_semanal_para');
  if (!para.length) return 'Sin envío: no hay destinatarios';
  const hoy = hoy_();
  const lunes = sumarDias_(hoy, -(diaSemana_(hoy) - 1) - 7), domingo = sumarDias_(lunes, 6);
  const en = f => f && f.slice(0, 10) >= lunes && f.slice(0, 10) <= domingo;
  const todos = leer_('Reclamos');
  const ingresados = todos.filter(r => en(String(r.fecha_carga))).length;
  const cerrados = todos.filter(r => r.estado === 'cerrado' && en(r.fecha_cierre));
  const costo = cerrados.reduce((a, r) => a + (Number(r.costo_final) || 0), 0);
  const lista = abiertos_();
  const conAlerta = lista.filter(v => v.alertas.length);
  const enPausa = lista.filter(v => v.estado === 'en_pausa');
  const sinCerrar = lista.filter(v => v.estado === 'abierto' && v.etapa === 6);
  const corta = l => tablaMail_(['N°', 'Propiedad', 'Etapa', 'Días sin mov.'], l.map(v => { const f = filaMail_(v); return [f[0], f[1], f[2], f[4]]; }));
  const u = urlApp_();

  const html = marcoMail_('Resumen semanal · ' + fechaAr_(lunes) + ' al ' + fechaAr_(domingo),
    '<p>Ingresados en la semana: <b>' + ingresados + '</b><br>Cerrados en la semana: <b>' + cerrados.length + '</b><br>' +
    'Costo final total de los cerrados: <b>' + (pesos_(costo) || '$ 0') + '</b><br>Abiertos al momento del envío: <b>' + lista.length + '</b></p>' +
    '<h3 style="font:bold 14px Arial,sans-serif;margin:18px 0 6px">Con alerta (' + conAlerta.length + ')</h3>' + (conAlerta.length ? corta(conAlerta) : '<p>Ninguno.</p>') +
    '<h3 style="font:bold 14px Arial,sans-serif;margin:18px 0 6px">En pausa (' + enPausa.length + ')</h3>' + (enPausa.length ? corta(enPausa) : '<p>Ninguno.</p>') +
    '<h3 style="font:bold 14px Arial,sans-serif;margin:18px 0 6px">Terminados sin cerrar (' + sinCerrar.length + ')</h3>' + (sinCerrar.length ? corta(sinCerrar) : '<p>Ninguno.</p>') +
    '<p style="margin-top:18px"><a href="' + u + '">Tablero</a> · <a href="' + u + (u.indexOf('?') === -1 ? '?' : '&') + 'v=supervision">Supervisión</a></p>');
  MailApp.sendEmail({ to: para.join(','), subject: 'Reclamos · resumen semanal ' + fechaAr_(lunes) + ' al ' + fechaAr_(domingo),
    htmlBody: html, name: APP_NOMBRE });
  return 'Semanal enviado a ' + para.join(', ');
}

/**
 * Disparador de cada hora. Los horarios se leen de la hoja Config, así se
 * cambian sin tocar código. Cada mail sale una sola vez por día.
 */
function tic() {
  soloDuenio_();
  const ahora = new Date();
  const hoy = Utilities.formatDate(ahora, TZ, 'yyyy-MM-dd'), hora = Number(Utilities.formatDate(ahora, TZ, 'H'));
  const dia = diaSemana_(hoy), props = PropertiesService.getScriptProperties();

  if (cfgSi_('mail_diario_activo') && cfgLista_('mail_diario_dias').map(Number).indexOf(dia) !== -1 &&
      hora >= cfgNum_('mail_diario_hora', 8) && props.getProperty('ULTIMO_DIARIO') !== hoy) {
    props.setProperty('ULTIMO_DIARIO', hoy);
    try { enviarDiario(); } catch (e) { Logger.log('Diario: ' + e); }
  }
  if (cfgSi_('mail_semanal_activo') && dia === cfgNum_('mail_semanal_dia', 1) &&
      hora >= cfgNum_('mail_semanal_hora', 8) && props.getProperty('ULTIMO_SEMANAL') !== hoy) {
    props.setProperty('ULTIMO_SEMANAL', hoy);
    try { enviarSemanal(); } catch (e) { Logger.log('Semanal: ' + e); }
  }
  try { if (bipropActivo_()) enviarPendientesBiprop(); } catch (e) { Logger.log('Biprop: ' + e); }
}

/* ================================================================== */
/* Instalación, verificación y respaldo                                */
/* ================================================================== */

/**
 * Ejecutar UNA vez desde el editor, como mantenimiento@. Crea la planilla y la
 * carpeta (si todavía no existen), arma las hojas, carga los rubros iniciales
 * y la configuración por defecto, y programa los disparadores. Se puede volver
 * a correr sin problema: no duplica nada.
 */
function instalar() {
  soloDuenio_();
  const props = PropertiesService.getScriptProperties();
  const r = [];

  if (!props.getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create(NOMBRE_PLANILLA);
    props.setProperty('SHEET_ID', ss.getId());
    r.push('Planilla creada: ' + ss.getUrl());
  }
  const libro = libro_();
  libro.setSpreadsheetTimeZone(TZ);
  Object.keys(COLUMNAS).forEach(n => hoja_(n));
  const sobrante = libro.getSheetByName('Hoja 1') || libro.getSheetByName('Sheet1');
  if (sobrante && sobrante.getLastRow() === 0 && libro.getSheets().length > 1) libro.deleteSheet(sobrante);

  if (!props.getProperty('ROOT_FOLDER_ID')) {
    const padres = DriveApp.getFileById(props.getProperty('SHEET_ID')).getParents();
    const padre = padres.hasNext() ? padres.next() : DriveApp.getRootFolder();
    const carpeta = subcarpeta_(padre, NOMBRE_CARPETA);
    props.setProperty('ROOT_FOLDER_ID', carpeta.getId());
    r.push('Carpeta creada: ' + carpeta.getUrl());
  }
  // La carpeta NO se comparte con todo el dominio (tiene presupuestos y facturas): solo lectura para los usuarios.
  const raiz = raiz_();
  Object.keys(USUARIOS).forEach(e => { if (e !== OWNER) { try { raiz.addViewer(e); } catch (err) {} } });

  if (!leer_('Rubros').length) {
    RUBROS_INICIALES.forEach((n, i) => agregar_('Rubros', { id_rubro: 'RU-' + pad_(i + 1, 2), nombre: n, activo: true }));
    r.push('Rubros iniciales cargados: ' + RUBROS_INICIALES.length);
  }
  const claves = leer_('Config').map(c => c.clave);
  CONFIG_DEFECTO.forEach(c => {
    if (claves.indexOf(c[0]) === -1) agregar_('Config', { clave: c[0], valor: c[1], descripcion: c[2] });
  });

  // Biprop corre en esta misma cuenta: si su planilla está en este Drive, se toma de ahí el padrón de propiedades.
  if (!props.getProperty('BIPROP_SHEET_ID')) {
    const halladas = vivos_(DriveApp.getFilesByName(NOMBRE_PLANILLA_BIPROP));
    if (halladas.length === 1) {
      props.setProperty('BIPROP_SHEET_ID', halladas[0].getId());
      r.push('Planilla de Biprop encontrada: se usa como padrón de propiedades.');
    }
  }

  ScriptApp.getProjectTriggers().forEach(t => {
    if (['tic', 'dailyBackup'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tic').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(3).create();
  r.push('Disparadores programados: tic (cada hora) y dailyBackup (~03:00).');

  r.push(verificarInstalacion());
  const salida = r.join('\n');
  Logger.log(salida);
  return salida;
}

/** Revisa que la configuración esté bien. El resultado se ve en "Registro de ejecución". */
function verificarInstalacion() {
  soloDuenio_();
  const r = [];
  const ok = t => r.push('OK   · ' + t), mal = t => r.push('MAL  · ' + t), ojo = t => r.push('OJO  · ' + t);
  ok('Cuenta que ejecuta: ' + Session.getEffectiveUser().getEmail());
  try {
    const ss = libro_();
    Object.keys(COLUMNAS).forEach(n => hoja_(n));
    ok('Planilla "' + ss.getName() + '": ' + Object.keys(COLUMNAS).join(', ') + '.');
  } catch (e) { mal('Planilla: ' + (e.message || e)); }
  try { ok('Carpeta "' + raiz_().getName() + '" encontrada.'); } catch (e) { mal('Carpeta: ' + (e.message || e)); }

  if (!prop_('BIPROP_SHEET_ID')) ojo('Falta BIPROP_SHEET_ID: sin eso no se ve el padrón de propiedades de Biprop.');
  else {
    try {
      SpreadsheetApp.openById(prop_('BIPROP_SHEET_ID')).getSheetByName('Propiedades').getLastRow();
      ok('Padrón de Biprop: ' + padron_().filter(p => p.enBiprop).length + ' propiedades.');
    } catch (e) { mal('Padrón de Biprop (BIPROP_SHEET_ID): ' + (e.message || e)); }
  }
  if (!prop_('BIPROP_URL') || !prop_('BIPROP_TOKEN')) ojo('Faltan BIPROP_URL o BIPROP_TOKEN: no se puede escribir en Biprop.');
  else {
    try { bipropLlamar_('ping', {}); ok('Biprop responde por la puerta de servicio.'); }
    catch (e) { mal('Biprop: ' + (e.message || e)); }
  }
  if (!cfgSi_('biprop_activo')) ojo('La integración con Biprop está apagada (biprop_activo = no en la hoja Config).');
  try { ok('Mails que se pueden enviar hoy: ' + MailApp.getRemainingDailyQuota() + '.'); } catch (e) { mal('Permiso de mail: ' + (e.message || e)); }
  ok('Disparadores: ' + (ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()).join(', ') || 'ninguno'));
  const salida = r.join('\n');
  Logger.log(salida);
  return salida;
}

/** Respaldo diario: copia de la planilla. Conserva los últimos BACKUP_KEEP. */
function dailyBackup() {
  soloDuenio_();
  const id = prop_('SHEET_ID');
  const padres = DriveApp.getFileById(id).getParents();
  const carpeta = subcarpeta_(padres.hasNext() ? padres.next() : DriveApp.getRootFolder(), BACKUP_FOLDER);
  const sello = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd_HH-mm');
  DriveApp.getFileById(id).makeCopy(NOMBRE_PLANILLA + ' ' + sello, carpeta);
  const archivos = vivos_(carpeta.getFiles());
  archivos.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  archivos.slice(BACKUP_KEEP).forEach(f => f.setTrashed(true));
  return 'Respaldo generado: ' + sello;
}
