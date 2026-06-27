require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ─── Cache-control ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const url = req.url.split('?')[0];
  const noStore = [
    '/', '/index.html', '/flutter_bootstrap.js',
    '/flutter_service_worker.js', '/main.dart.js',
    '/manifest.json', '/version.json',
  ];
  if (noStore.includes(url)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else if (url.startsWith('/assets/') || url.startsWith('/canvaskit/')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT                    = process.env.PORT || 3000;
const WHATSAPP_VERIFY_TOKEN   = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_ACCESS_TOKEN   = process.env.WHATSAPP_ACCESS_TOKEN;
const SUPABASE_URL            = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Tiempo de inactividad antes de expirar sesión: 30 minutos
const SESSION_TTL_MS = 30 * 60 * 1000;
// Limpieza de sesiones expiradas cada 10 minutos
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const ADVISOR_PHONE_DISPLAY = '55 2936 8434';
const ADVISOR_PHONE_WHATSAPP = '525529368434';

function advisorContactBlock() {
  return (
    `Si quieres hablar con un asesor: *${ADVISOR_PHONE_DISPLAY}*\n` +
    `Chat directo: https://wa.me/${ADVISOR_PHONE_WHATSAPP}`
  );
}

// ─── Utilidades generales ─────────────────────────────────────────────────────
function maskToken(token = '') {
  if (!token) return 'missing';
  if (token.length <= 10) return `${token.slice(0, 2)}***`;
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

/**
 * Normaliza texto: quita acentos, trim, lowercase.
 * Nunca lanza excepción — siempre devuelve string.
 */
function normalizeText(text = '') {
  try {
    return String(text)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  } catch (_) {
    return '';
  }
}

function logSession(userId, session, label) {
  console.log(`[SESSION][${label}]`, {
    userId,
    state: session.state,
    operacion: session.operacion,
    tipo: session.tipo,
    resultsCount: session.results?.length ?? 0,
    selectedPropertyId: session.selectedProperty?.id ?? null,
    customerName: session.customerName,
    preferredSchedule: session.preferredSchedule,
    lastActivityAt: new Date(session.lastActivityAt).toISOString(),
  });
}

// ─── Estados ──────────────────────────────────────────────────────────────────
const STATES = {
  IDLE:                        'IDLE',
  ESPERA_CONFIRMACION_RECONTACTO: 'ESPERA_CONFIRMACION_RECONTACTO', // ya existe en BD
  ESPERA_OPERACION:            'ESPERA_OPERACION', // renta o venta
  ESPERA_TIPO:                 'ESPERA_TIPO',      // departamento o habitacion (solo renta)
  ESPERA_SELECCION:            'ESPERA_SELECCION', // elige propiedad de la lista
  ESPERA_CONFIRMACION_PROPIEDAD: 'ESPERA_CONFIRMACION_PROPIEDAD', // confirma si le gustó o quiere ver otra
  ESPERA_NOMBRE:               'ESPERA_NOMBRE',
  ESPERA_HORARIO:              'ESPERA_HORARIO',
  COMPLETADO:                  'COMPLETADO',
};

// Estados que representan un flujo activo en progreso
const STATES_IN_PROGRESS = new Set([
  STATES.ESPERA_TIPO,
  STATES.ESPERA_SELECCION,
  STATES.ESPERA_CONFIRMACION_PROPIEDAD,
  STATES.ESPERA_NOMBRE,
  STATES.ESPERA_HORARIO,
]);

// ─── Sesiones ─────────────────────────────────────────────────────────────────
const sessions = new Map();

function createNewSession() {
  return {
    state: STATES.IDLE,
    lastActivityAt: Date.now(),
    operacion: null,
    tipo: null,
    results: [],
    selectedProperty: null,
    customerName: null,
    preferredSchedule: null,
  currentResultIndex: null,
  };
}

function getSession(userId) {
  let session = sessions.get(userId);
  if (!session) {
    session = createNewSession();
    sessions.set(userId, session);
  }
  session.lastActivityAt = Date.now();
  return session;
}

function resetSession(session) {
  Object.assign(session, createNewSession());
}

/** Limpia sesiones que llevan más de SESSION_TTL_MS sin actividad */
function cleanExpiredSessions() {
  const now = Date.now();
  let removed = 0;
  for (const [userId, session] of sessions.entries()) {
    if (now - session.lastActivityAt > SESSION_TTL_MS) {
      sessions.delete(userId);
      removed++;
    }
  }
  if (removed > 0) console.log(`[SESSION][CLEANUP] eliminadas ${removed} sesiones expiradas`);
}
setInterval(cleanExpiredSessions, SESSION_CLEANUP_INTERVAL_MS);

// ─── Mensajes del bot ─────────────────────────────────────────────────────────
function introMessage() {
  return (
    'Bienvenido a *Urbano*. 👋\n\n' +
    '¿Qué estás buscando?\n\n' +
    '1️⃣  Renta\n' +
    '2️⃣  Venta\n\n' +
    '_Responde con el número de tu elección. En cualquier momento puedes escribir *salir*._'
  );
}

function tipoMessage() {
  return (
    '¿Qué tipo de inmueble necesitas?\n\n' +
    '1️⃣  Departamento\n' +
    '2️⃣  Habitación\n\n' +
    '_Responde con el número de tu elección. También puedes escribir *salir*._'
  );
}

function ventaMessage() {
  return (
    'Para asuntos de *venta*, comunícate directamente con nuestro equipo:\n\n' +
    '📞 *55 3999 3015*\n\n' +
    '_Con gusto te atenderemos._ Para iniciar una nueva búsqueda escribe *hola*.'
  );
}

function flujoEnProgresoMessage() {
  return (
    'Ya tienes una búsqueda en curso.\n\n' +
    'Si deseas cancelarla y comenzar de nuevo, escribe *salir* y luego *hola*.'
  );
}

function errorGenericoMessage() {
  return (
    'Ocurrió un error inesperado. Por favor intenta de nuevo en un momento.\n\n' +
    'Si el problema persiste escribe *salir* para reiniciar o contáctanos al *55 3999 3015*. 📞'
  );
}

// ─── Búsqueda de propiedades ──────────────────────────────────────────────────
function buildPublicPropertyUrl(propertyId) {
  return `https://renta-smart-system.web.app/propiedad/${propertyId}`;
}

async function fetchActiveProperties(tipo) {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('properties')
    .select('id,tipo,subtipo,titulo,zona,precio_renta,link_publico,activo')
    .eq('activo', true)
    .order('precio_renta', { ascending: true });

  if (error) throw error;

  return (data || [])
    .map((p) => ({
      id: p.id,
      tipo: String(p.tipo || ''),
      subtipo: String(p.subtipo || ''),
      titulo: String(p.titulo || ''),
      zona: String(p.zona || ''),
      precio: Number(p.precio_renta ?? 0),
      linkPublico: p.link_publico || buildPublicPropertyUrl(p.id),
    }))
    .filter((p) => {
      const t  = normalizeText(p.tipo);
      const st = normalizeText(p.subtipo);
      const tt = normalizeText(p.titulo);
      if (tipo === 'departamento')
        return t.includes('departamento') || st.includes('departamento') || tt.includes('departamento');
      if (tipo === 'habitacion')
        return t.includes('habitacion') || st.includes('habitacion') || tt.includes('habitacion') || tt.includes('cuarto');
      return true;
    });
}

function formatPropertyList(results) {
  if (!results.length) return '_No encontré propiedades disponibles en este momento._ 😕';
  return results
    .map((p, i) => {
      const precio  = p.precio ? `$${p.precio.toLocaleString('es-MX')}/mes` : 'Precio a consultar';
      const zona = p.zona || 'Zona no especificada';
      const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
      const num = emojis[i] || `${i + 1}.`;
      return `${num}  🏠 *${zona}* — 💰 *${precio}*`;
    })
    .join('\n');
}

// ─── Parsers ──────────────────────────────────────────────────────────────────
function parseOperacion(text) {
  const t = normalizeText(text);
  if (t === '1' || t.includes('renta') || t.includes('rentar') || t.includes('alquil')) return 'renta';
  if (t === '2' || t.includes('venta') || t.includes('compra') || t.includes('vender')) return 'venta';
  return null;
}

function parseTipoRenta(text) {
  const t = normalizeText(text);
  if (t === '1' || t.includes('departamento') || t.includes('depa')) return 'departamento';
  if (t === '2' || t.includes('habitacion') || t.includes('cuarto') || t.includes('pieza')) return 'habitacion';
  return null;
}

function parseSelection(text, max) {
  const value = Number(normalizeText(text));
  if (!Number.isInteger(value) || value < 1 || value > max) return null;
  return value;
}

function looksLikeSchedule(text) {
  return /(hoy|ma[nñ]ana|tarde|noche|despu[eé]s|\bam\b|\bpm\b|lun|mar|mi[eé]|jue|vie|s[aá]b|dom|\bhora\b|horario)/i
    .test(String(text).trim());
}

function looksLikeName(text) {
  const clean = String(text).trim();
  if (clean.length < 2) return false;
  if (/\d/.test(clean)) return false;
  // Rechaza palabras clave del flujo
  if (/^(hola|buenas|hey|salir|renta|venta|departamento|habitacion|depa|cuarto|si|no|ok)$/i.test(clean)) return false;
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return true;
  return /^[A-Za-z\u00C0-\u024F]{2,}$/.test(clean);
}

function canExitFlow(text) {
  return /^(salir|cancelar|terminar|detener|stop|menu|men[uú])$/i.test(String(text).trim());
}

/**
 * Detecta mensajes automáticos o de sistema de WhatsApp que no son input real del usuario:
 * - Mensajes vacíos o solo espacios
 * - Notificaciones de lectura / entrega (generalmente vacías)
 * - Mensajes extremadamente cortos sin sentido (1 carácter no numérico)
 */
function isSystemOrNoise(text) {
  const clean = String(text || '').trim();
  if (!clean) return true;
  // Un solo carácter que no sea dígito válido del menú → probablemente ruido
  if (clean.length === 1 && !/^[1-9]$/.test(clean)) return true;
  return false;
}

function exitMessage(session) {
  resetSession(session);
  session.state = STATES.COMPLETADO;
  return (
    '✅ Entendido. Cerré esta búsqueda. Cuando quieras volver a empezar escribe *hola*. 👋\n\n' +
    advisorContactBlock()
  );
}

// ─── Guardar prospecto ────────────────────────────────────────────────────────
// ─── Chequeo de prospecto existente ─────────────────────────────────────────
async function checkExistingProspect(phone) {
  if (!supabase) return false;
  const { data, error } = await supabase
    .from('prospectos')
    .select('id')
    .eq('telefono', phone)
    .limit(1);
  if (error) {
    console.warn('[PROSPECT][CHECK] error al verificar duplicado:', error.message);
    return false; // ante duda, dejar pasar
  }
  return (data && data.length > 0);
}

async function saveProspect({ phone, customerName, preferredSchedule, property, session }) {
  if (!supabase) throw new Error('Supabase no está configurado en .env');

  const payload = {
    nombre:            customerName,
    telefono:          phone,
    horario_preferido: preferredSchedule,
    origen:            'whatsapp_bot',
    estado:            'nuevo',
    tipo_interes:      session.tipo,
    es_recontacto:     session.esRecontacto ?? false,
    presupuesto_key:   null,
    presupuesto_label: null,
    propiedad_id:      (property && /^[0-9]+$/.test(String(property.id)))
                         ? Number(property.id) : null,
    propiedad_titulo:  property?.titulo ?? null,
    propiedad_uuid:    (property && !/^[0-9]+$/.test(String(property.id)))
                         ? String(property.id) : null,
  };

  const insertWithFallback = async (data) => {
    const result = await supabase
      .from('prospectos')
      .insert(data)
      .select('id, nombre, telefono, estado, created_at');
    return result;
  };

  let attempt = await insertWithFallback(payload);

  if (attempt.error) {
    const msg = String(attempt.error.message || '').toLowerCase();
    if (
      msg.includes('propiedad_uuid') || msg.includes('property_uuid') ||
      msg.includes('propiedad_id')   || msg.includes('unknown column')
    ) {
      const fallback = { ...payload };
      delete fallback.propiedad_uuid;
      delete fallback.propiedad_id;
      attempt = await insertWithFallback(fallback);
    }
  }

  if (attempt.error) {
    console.error('[PROSPECT][SAVE] error', attempt.error);
    throw attempt.error;
  }
  console.log('[PROSPECT][SAVE] success', attempt.data);
}

// ─── Motor principal del bot ──────────────────────────────────────────────────
async function processMessage(from, rawText) {
  const session = getSession(from);
  const clean   = String(rawText || '').trim();

  logSession(from, session, 'before');

  // ── Guardia 1: mensajes de sistema / ruido → ignorar silenciosamente
  if (isSystemOrNoise(clean)) {
    console.log(`[BOT] mensaje de sistema/ruido ignorado para ${from}: "${clean}"`);
    return null; // null = no responder
  }

  // ── Guardia 2: salir siempre disponible
  if (canExitFlow(clean)) return exitMessage(session);

  // ── Guardia 3: sesión completada
  if (session.state === STATES.COMPLETADO) {
    if (/^(hola|buenas|hey|nueva busqueda|nueva b[uú]squeda|inicio|menu|men[uú])$/i.test(clean)) {
      resetSession(session);
      session.state = STATES.ESPERA_OPERACION;
      logSession(from, session, 'restart_after_completed');
      return introMessage();
    }
    return 'Escribe *hola* para iniciar una nueva búsqueda.';
  }

  // ── Guardia 4: saludo cuando hay flujo activo → NO reiniciar
  if (/^(hola|buenas|hey)$/i.test(clean)) {
    if (STATES_IN_PROGRESS.has(session.state)) {
      return flujoEnProgresoMessage();
    }
    // ─ Chequeo de recontacto ─
    let yaExiste = false;
    try { yaExiste = await checkExistingProspect(from); } catch (e) { /* si falla, dejar pasar */ }
    if (yaExiste) {
      resetSession(session);
      session.state = STATES.ESPERA_CONFIRMACION_RECONTACTO;
      logSession(from, session, 'recontacto_detectado');
      return (
        'Encontramos un registro previo con tu número en nuestro sistema.\n' +
        'Un asesor ya debería haberse puesto en contacto contigo. 📞\n\n' +
        advisorContactBlock() + '\n\n' +
        '¿Deseas registrar una nueva solicitud?\n\n' +
        '1️⃣  Sí, continuar\n' +
        '2️⃣  No, gracias\n\n' +
        '_Responde con el número de tu elección. También puedes escribir *salir*._'
      );
    }
    resetSession(session);
    session.state = STATES.ESPERA_OPERACION;
    logSession(from, session, 'after_hola');
    return introMessage();
  }

  // ── Estado ESPERA_CONFIRMACION_RECONTACTO
  if (session.state === STATES.ESPERA_CONFIRMACION_RECONTACTO) {
    const t = normalizeText(clean);
    if (t === '1' || t.includes('si') || t.includes('sí') || t.includes('continuar')) {
      session.esRecontacto = true;
      session.state = STATES.ESPERA_OPERACION;
      logSession(from, session, 'recontacto_confirmado');
      return introMessage();
    }
    if (t === '2' || t.includes('no') || t.includes('gracias')) {
      resetSession(session);
      session.state = STATES.COMPLETADO;
      logSession(from, session, 'recontacto_rechazado');
      return (
        'De acuerdo. Si en otro momento necesitas ayuda, escribe *hola* y con gusto te atendemos. 👋'
      );
    }
    return (
      'Por favor responde con el número de una opción válida.\n\n' +
      '1️⃣  Sí, continuar\n' +
      '2️⃣  No, gracias\n\n' +
      'También puedes escribir *salir*.'
    );
  }

  // ── Estado IDLE → arrancar
  if (session.state === STATES.IDLE) {
    session.state = STATES.ESPERA_OPERACION;
    logSession(from, session, 'from_idle');
    return introMessage();
  }

  // ── Paso 1: Renta o Venta ──────────────────────────────────────────────────
  if (session.state === STATES.ESPERA_OPERACION) {
    const op = parseOperacion(clean);
    if (!op) {
      return 'Responde con *1* para Renta o *2* para Venta.\nTambién puedes escribir *salir*.';
    }
    session.operacion = op;

    if (op === 'venta') {
      resetSession(session);
      session.state = STATES.COMPLETADO;
      logSession(from, session, 'venta_redirect');
      return ventaMessage();
    }

    session.state = STATES.ESPERA_TIPO;
    logSession(from, session, 'after_operacion_renta');
    return tipoMessage();
  }

  // ── Paso 2: Departamento o Habitación ─────────────────────────────────────
  if (session.state === STATES.ESPERA_TIPO) {
    const tipo = parseTipoRenta(clean);
    if (!tipo) {
      return 'Responde con *1* para Departamento o *2* para Habitación.\nTambién puedes escribir *salir*.';
    }
    session.tipo = tipo;

    let propiedades = [];
    try {
      propiedades = await fetchActiveProperties(tipo);
    } catch (e) {
      console.error('[FETCH_PROPS] error', e);
      return errorGenericoMessage();
    }

    session.results = propiedades;
    session.state   = STATES.ESPERA_SELECCION;
    logSession(from, session, 'after_tipo');

    if (!propiedades.length) {
      session.state = STATES.COMPLETADO;
      return (
        `Por el momento no contamos con *${tipo === 'departamento' ? 'departamentos' : 'habitaciones'}* disponibles.\n\n` +
        'Para más información contáctanos al *55 3999 3015*. 📞\nEscribe *hola* para iniciar otra búsqueda.'
      );
    }

    const emoji = tipo === 'departamento' ? '🏢' : '🛏';
    return (
      `${emoji} Estas son las opciones de *${tipo === 'departamento' ? 'departamento' : 'habitación'}* disponibles:\n\n` +
      `${formatPropertyList(propiedades)}\n\n` +
      `_Responde con el *número* de la opción que fue de tu agrado. También puedes escribir *salir*._`
    );
  }

  // ── Paso 3: Elección de propiedad ─────────────────────────────────────────
  if (session.state === STATES.ESPERA_SELECCION) {
    const selection = parseSelection(clean, session.results.length);
    if (!selection) {
      return `Por favor responde con un número del *1* al *${session.results.length}*.\nTambién puedes escribir *salir*.`;
    }
    session.currentResultIndex = selection - 1;
    session.selectedProperty = session.results[session.currentResultIndex];
    session.state = STATES.ESPERA_CONFIRMACION_PROPIEDAD;
    logSession(from, session, 'after_selection_preview');
    const prop = session.selectedProperty;
    return [
      `Ver detalles de la propiedad:\n${prop.linkPublico}`,
      `*${prop.colonia || prop.titulo}* — opción ${selection} de ${session.results.length}.\n\n¿Esta opción fue de tu agrado?\n\n1️⃣  Sí, me interesa\n2️⃣  Ver otra opción\n\n_Responde con el número de tu elección. También puedes escribir *salir*._`,
    ];
  }

  // ── Paso 3.1: Confirmación de propiedad / navegación ─────────────────────
  if (session.state === STATES.ESPERA_CONFIRMACION_PROPIEDAD) {
    const t = normalizeText(clean);
    if (t === '1' || t.includes('si') || t.includes('sí') || t.includes('me interesa') || t.includes('me gusto') || t.includes('me gustó')) {
      session.state = STATES.ESPERA_NOMBRE;
      logSession(from, session, 'property_confirmed');
      return (
        `Perfecto. *${session.selectedProperty?.colonia || session.selectedProperty?.titulo || 'Esta propiedad'}* fue seleccionada. ✅\n\n¿Cuál es tu nombre completo?\n_Lo necesitamos para registrar tu solicitud._\n\nTambién puedes escribir *salir*.`
      );
    }

    if (t === '2' || t.includes('ver otra') || t.includes('otra opcion') || t.includes('otra opción') || t.includes('siguiente')) {
      const total = session.results.length;
      const currentIndex = Number.isInteger(session.currentResultIndex) ? session.currentResultIndex : session.results.findIndex((item) => item?.id === session.selectedProperty?.id);
      const nextIndex = currentIndex + 1;

      if (nextIndex >= total) {
        session.state = STATES.ESPERA_SELECCION;
        session.currentResultIndex = null;
        session.selectedProperty = null;
        logSession(from, session, 'property_browse_restart');
        const emoji = session.tipo === 'departamento' ? '🏢' : '🛏';
        return (
          `Ya te mostré todas las opciones disponibles de *${session.tipo === 'departamento' ? 'departamento' : 'habitación'}*.\n\n` +
          `${emoji} Estas son nuevamente las opciones disponibles:\n\n` +
          `${formatPropertyList(session.results)}\n\n` +
          `_Responde con el *número* de la opción que deseas revisar otra vez. También puedes escribir *salir*._`
        );
      }

      session.currentResultIndex = nextIndex;
      session.selectedProperty = session.results[nextIndex];
      const prop = session.selectedProperty;
      logSession(from, session, 'property_browse_next');
      return [
        `Ver detalles de la propiedad:\n${prop.linkPublico}`,
        `*${prop.colonia || prop.titulo}* — opción ${nextIndex + 1} de ${total}.\n\n¿Esta opción fue de tu agrado?\n\n1️⃣  Sí, me interesa\n2️⃣  Ver otra opción\n\n_Responde con el número de tu elección. También puedes escribir *salir*._`,
      ];
    }

    return (
      'Por favor responde con una opción válida:\n\n' +
      '1️⃣  Sí, me interesa\n' +
      '2️⃣  Ver otra opción\n\n' +
      'También puedes escribir *salir*.'
    );
  }

  // ── Paso 4: Nombre ────────────────────────────────────────────────────────
  if (session.state === STATES.ESPERA_NOMBRE) {
    if (looksLikeSchedule(clean) && !looksLikeName(clean)) {
      return (
        'Antes de continuar necesito tu nombre completo.\n\n' +
        'Por ejemplo: _Ana Martínez_\n\nTambién puedes escribir *salir*.'
      );
    }
    if (!looksLikeName(clean)) {
      return (
        'Por favor indica tu nombre completo.\n' +
        'Puede ser nombre y apellido o solo tu primer nombre.\n\nTambién puedes escribir *salir*.'
      );
    }
    // Capitalizar nombre
    session.customerName = clean
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
    session.state = STATES.ESPERA_HORARIO;
    logSession(from, session, 'after_name');
    return (
      `Gracias, *${session.customerName}*. \n\n` +
      '¿Cuál es tu horario disponible para ser contactado?\n\n' +
      '1️⃣  Lun a Vie 9:00 a 15:30\n' +
      '2️⃣  Lun a Vie 15:00 a 20:00\n' +
      '3️⃣  Sábados\n' +
      '4️⃣  Domingos\n\n' +
      'También puedes escribir *salir*.'
    );
  }

  // ── Paso 5: Horario ───────────────────────────────────────────────────────
  if (session.state === STATES.ESPERA_HORARIO) {
    const horarioOpciones = {
      '1': 'Lun a Vie 9:00 a 15:30',
      '2': 'Lun a Vie 15:00 a 20:00',
      '3': 'Sábados',
      '4': 'Domingos',
    };
    const selected = horarioOpciones[clean];
    if (!selected) {
      return (
        'Por favor indica una opción válida:\n\n' +
        '1️⃣  Lun a Vie 9:00 a 15:30\n' +
        '2️⃣  Lun a Vie 15:00 a 20:00\n' +
        '3️⃣  Sábados\n' +
        '4️⃣  Domingos\n\n' +
        'También puedes escribir *salir*.'
      );
    }
    session.preferredSchedule = selected;

    try {
      await saveProspect({
        phone: from,
        customerName: session.customerName,
        preferredSchedule: session.preferredSchedule,
        property: session.selectedProperty,
        session,
      });
    } catch (e) {
      console.error('[PROSPECT][SAVE] error inesperado', e);
      // No bloquear al usuario — igual confirmamos y logueamos el fallo
    }

    const prop = session.selectedProperty;
    const resumen = (
      `✅ *${session.customerName}*, tu solicitud ha sido registrada.\n\n` +
      `🏠 *Propiedad:* ${prop?.colonia || prop?.titulo || 'la que elegiste'}\n` +
      `📅 *Horario:* ${selected}\n\n` +
      `Un asesor se pondrá en contacto contigo a la brevedad. 📞\n\n` +
      advisorContactBlock() + '\n\n' +
      'Escribe *hola* si deseas realizar otra búsqueda.'
    );

    resetSession(session);
    session.state = STATES.COMPLETADO;
    logSession(from, session, 'after_save_completed');
    return resumen;
  }

  // Fallback — estado desconocido
  console.warn(`[BOT] estado desconocido "${session.state}" para ${from}, reseteando sesión`);
  resetSession(session);
  session.state = STATES.ESPERA_OPERACION;
  return introMessage();
}

// ─── Endpoints HTTP ───────────────────────────────────────────────────────────
app.get('/', (_, res) => res.send('Servidor WhatsApp activo'));

app.get('/webhook', (req, res) => {
  console.log('[WEBHOOK][GET] query:', req.query);
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('[WEBHOOK][GET] verification ok');
    return res.status(200).send(challenge);
  }
  console.log('[WEBHOOK][GET] verification failed');
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  // Responder 200 inmediatamente a Meta (evita reintentos por timeout)
  res.sendStatus(200);

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;

    // Ignorar notificaciones de estado (delivered, read, sent)
    if (changes?.statuses?.length) {
      console.log('[WEBHOOK][POST] status update ignorado');
      return;
    }

    const message = changes?.messages?.[0];
    if (!message) {
      console.log('[WEBHOOK][POST] evento sin mensaje ignorado');
      return;
    }

    // Solo procesar mensajes de texto
    if (message.type !== 'text') {
      console.log(`[WEBHOOK][POST] tipo "${message.type}" ignorado`);
      return;
    }

    const from         = String(message.from || '');
    const incomingText = String(message.text?.body || '');
    console.log('[WEBHOOK][POST] incoming:', { from, incomingText });

    const reply = await processMessage(from, incomingText);

    // null = mensaje de ruido, no responder
    if (reply == null) {
      console.log('[WEBHOOK][POST] reply suprimido (ruido/sistema)');
      return;
    }

    // Soporta respuesta simple (string) o múltiple (array de strings)
    const messages = Array.isArray(reply) ? reply : [reply];
    for (const msg of messages) {
      await sendWhatsAppMessage(from, msg);
    }
    console.log(`[WEBHOOK][POST] ${messages.length} mensaje(s) enviado(s)`);
  } catch (error) {
    console.error('[WEBHOOK][POST] error no capturado:', error.response?.data || error.message);
  }
});

// ─── WhatsApp sender ──────────────────────────────────────────────────────────
async function sendWhatsAppMessage(to, body) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    throw new Error('Faltan variables de WhatsApp en .env');
  }
  const url = `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  console.log('[WHATSAPP][SEND]', { to, tokenPreview: maskToken(WHATSAPP_ACCESS_TOKEN) });
  await axios.post(
    url,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } },
  );
}

// ─── Arranque ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[BOOT] Servidor escuchando en puerto ${PORT}`);
    console.log('[BOOT] WhatsApp config', {
      verifyTokenLoaded:   Boolean(WHATSAPP_VERIFY_TOKEN),
      phoneNumberId:       WHATSAPP_PHONE_NUMBER_ID || 'missing',
      accessTokenPreview:  maskToken(WHATSAPP_ACCESS_TOKEN),
      supabaseConfigured:  Boolean(supabase),
    });
  });
}

module.exports = {
  app,
  STATES,
  STATES_IN_PROGRESS,
  normalizeText,
  createNewSession,
  getSession,
  resetSession,
  parseTipoRenta,
  parseOperacion,
  fetchActiveProperties,
  formatPropertyList,
  processMessage,
  parseSelection,
  saveProspect,
};
