/**
 * LUCA — Conciliador de Compras · módulo backend
 * Repositorio destino: klimm-mx/klimm-backend
 *
 * MONTAJE en server.js (Express):
 *   const luca = require('./luca');
 *   app.use('/luca', luca);
 *
 * Variables de entorno requeridas (además de las de Odoo):
 *   GITHUB_LUCA_REPO   p. ej. klimm-mx/luca
 *   GITHUB_LUCA_TOKEN  token personal con scope public_repo
 *
 * Variables de Odoo (las mismas que ya usa el backend):
 *   ODOO_URL · ODOO_DB · ODOO_USER · ODOO_API_KEY
 *
 * PERSISTENCIA DEL ESTADO:
 * El estado entre cortes (OCs abiertas, catálogos, historial de
 * discrepancias) se guarda en el archivo estado.json del repo
 * klimm-mx/luca en GitHub. Cada guardado genera un commit — hay
 * historial completo y se puede revertir cualquier corte.
 */

const express = require('express');
const router = express.Router();
router.use(express.json({ limit: '4mb' }));

/* ==================== CONEXIÓN ODOO (JSON-RPC) ==================== */

const ODOO_URL = (process.env.ODOO_URL || '').replace(/\/$/, '');
const ODOO_DB  = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

let _uid = null;

async function rpc(service, method, args) {
  const resp = await fetch(ODOO_URL + '/jsonrpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: Date.now(),
      params: { service, method, args } })
  });
  const data = await resp.json();
  if (data.error) {
    const msg = data.error.data?.message || data.error.message;
    throw new Error('Odoo: ' + msg);
  }
  return data.result;
}

async function uid() {
  if (_uid) return _uid;
  _uid = await rpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);
  if (!_uid) throw new Error('Odoo: autenticación fallida (revisa ODOO_USER / ODOO_API_KEY)');
  return _uid;
}

async function odoo(model, method, args = [], kwargs = {}) {
  const u = await uid();
  return rpc('object', 'execute_kw', [ODOO_DB, u, ODOO_API_KEY, model, method, args, kwargs]);
}

function fallar(res, err) {
  console.error('[luca]', err.message);
  if (/session|autenticaci/i.test(err.message)) _uid = null;
  res.status(500).json({ error: err.message });
}

/* ==================== ESTADO EN GITHUB ==================== */

const GH_REPO  = process.env.GITHUB_LUCA_REPO  || '';
const GH_TOKEN = process.env.GITHUB_LUCA_TOKEN || '';
const GH_FILE  = 'estado.json';
const GH_API   = `https://api.github.com/repos/${GH_REPO}/contents/${GH_FILE}`;

async function ghGet() {
  const resp = await fetch(GH_API, {
    headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
  });
  if (!resp.ok) {
    if (resp.status === 404) return { estado: {}, sha: null };
    throw new Error(`GitHub GET ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  const estado = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8') || '{}');
  return { estado, sha: data.sha };
}

async function ghSet(estado, sha) {
  const contenido = Buffer.from(JSON.stringify(estado, null, 2)).toString('base64');
  const fecha = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
  const body = {
    message: `Luca · corte ${fecha}`,
    content: contenido,
    ...(sha ? { sha } : {})
  };
  const resp = await fetch(GH_API, {
    method: 'PUT',
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`GitHub PUT ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.content.sha;
}

// Cache en memoria del SHA para no hacer dos GETs por guardado
let _sha = null;

router.get('/api/estado', async (req, res) => {
  try {
    const { estado, sha } = await ghGet();
    _sha = sha;
    res.json({ estado });
  } catch (e) { fallar(res, e); }
});

router.post('/api/estado', async (req, res) => {
  try {
    if (!req.body || typeof req.body.estado !== 'object') {
      return res.status(400).json({ error: 'Falta el objeto estado' });
    }
    // Si no tenemos el SHA en caché, lo obtenemos antes de escribir
    if (!_sha) {
      const { sha } = await ghGet();
      _sha = sha;
    }
    _sha = await ghSet(req.body.estado, _sha);
    res.json({ ok: true });
  } catch (e) { fallar(res, e); }
});

/* ==================== CRUCE 1: COMPRAS DE ODOO ==================== */

router.get('/api/compras', async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'Faltan fechas desde/hasta' });

    const ocs = await odoo('purchase.order', 'search_read', [[
      ['state', 'in', ['purchase', 'done']],
      ['date_approve', '>=', desde + ' 00:00:00'],
      ['date_approve', '<=', hasta + ' 23:59:59']
    ]], { fields: ['name', 'partner_id', 'date_approve', 'amount_untaxed',
                   'order_line', 'invoice_ids', 'invoice_status'] });

    if (!ocs.length) return res.json({ compras: [] });

    const partnerIds = [...new Set(ocs.map(o => o.partner_id[0]))];
    const partners = await odoo('res.partner', 'read', [partnerIds], { fields: ['name', 'vat'] });
    const porPartner = Object.fromEntries(partners.map(p => [p.id, p]));

    const lineaIds = ocs.flatMap(o => o.order_line);
    const lineas = lineaIds.length ? await odoo('purchase.order.line', 'read', [lineaIds],
      { fields: ['order_id', 'product_id', 'name', 'product_qty', 'price_unit', 'qty_invoiced'] }) : [];
    const lineasPorOC = {};
    for (const l of lineas) {
      (lineasPorOC[l.order_id[0]] = lineasPorOC[l.order_id[0]] || []).push(l);
    }

    const factIds = [...new Set(ocs.flatMap(o => o.invoice_ids))];
    const facturas = factIds.length ? await odoo('account.move', 'read', [factIds],
      { fields: ['name', 'state', 'move_type', 'amount_untaxed'] }) : [];
    const porFactura = Object.fromEntries(facturas.map(f => [f.id, f]));

    const compras = ocs.map(o => ({
      id: o.id,
      nombre: o.name,
      fecha: o.date_approve,
      proveedor: o.partner_id[1],
      partnerId: o.partner_id[0],
      rfc: (porPartner[o.partner_id[0]]?.vat || '').toUpperCase(),
      subtotal: o.amount_untaxed,
      estadoFacturacion: o.invoice_status,
      facturas: o.invoice_ids.map(id => porFactura[id]).filter(Boolean)
        .map(f => ({ id: f.id, nombre: f.name, estado: f.state })),
      lineas: (lineasPorOC[o.id] || []).map(l => ({
        id: l.id,
        productoId: l.product_id ? l.product_id[0] : null,
        producto: l.product_id ? l.product_id[1] : l.name,
        descripcion: l.name,
        cantidadPedida: l.product_qty,
        cantidadFacturada: l.qty_invoiced,
        precioUnitario: l.price_unit
      }))
    }));

    res.json({ compras });
  } catch (e) { fallar(res, e); }
});

/* ==================== PREPARAR FACTURA EN ODOO ==================== */

router.post('/api/preparar-factura', async (req, res) => {
  try {
    const { ocId, lineas, cfdis, resumen } = req.body || {};
    if (!ocId || !Array.isArray(lineas) || !lineas.length) {
      return res.status(400).json({ error: 'Faltan ocId o lineas' });
    }

    let [oc] = await odoo('purchase.order', 'read', [[ocId]], { fields: ['name', 'invoice_ids'] });
    let facturaId = null;

    if (oc.invoice_ids.length) {
      const facts = await odoo('account.move', 'read', [oc.invoice_ids],
        { fields: ['state', 'move_type'] });
      const borrador = facts.find(f => f.move_type === 'in_invoice' && f.state === 'draft');
      if (borrador) facturaId = borrador.id;
      const publicada = facts.find(f => f.move_type === 'in_invoice' && f.state === 'posted');
      if (!borrador && publicada) {
        return res.status(409).json({
          error: `La factura de ${oc.name} ya está confirmada en Odoo. ` +
                 'Revísala directamente; Luca no modifica facturas confirmadas.'
        });
      }
    }

    if (!facturaId) {
      await odoo('purchase.order', 'action_create_invoice', [[ocId]]);
      [oc] = await odoo('purchase.order', 'read', [[ocId]], { fields: ['invoice_ids'] });
      const facts = await odoo('account.move', 'read', [oc.invoice_ids],
        { fields: ['state', 'move_type'] });
      const borrador = facts.find(f => f.move_type === 'in_invoice' && f.state === 'draft');
      if (!borrador) throw new Error('No se pudo crear la factura en borrador para la OC ' + ocId);
      facturaId = borrador.id;
    }

    const moveLines = await odoo('account.move.line', 'search_read', [[
      ['move_id', '=', facturaId],
      ['purchase_line_id', 'in', lineas.map(l => l.purchaseLineId)]
    ]], { fields: ['purchase_line_id'] });
    const movePorCompra = Object.fromEntries(moveLines.map(m => [m.purchase_line_id[0], m.id]));

    const sinLinea = [];
    for (const l of lineas) {
      const moveLineId = movePorCompra[l.purchaseLineId];
      if (!moveLineId) { sinLinea.push(l.purchaseLineId); continue; }
      await odoo('account.move.line', 'write', [[moveLineId], {
        quantity: l.cantidad,
        price_unit: l.precioUnitario
      }]);
    }

    const cuerpo =
      '<b>Luca · Conciliador de Compras</b><br/>' +
      'Cantidades y precios ajustados a los valores reales del CFDI (sin IVA).<br/>' +
      (cfdis?.length ? 'Folios fiscales (UUID): ' + cfdis.join(', ') + '<br/>' : '') +
      (resumen ? resumen + '<br/>' : '') +
      '<i>Pendiente: confirmación humana final en Odoo.</i>';
    await odoo('account.move', 'message_post', [[facturaId]], { body: cuerpo });

    const [fact] = await odoo('account.move', 'read', [[facturaId]], { fields: ['name'] });
    res.json({ ok: true, facturaId, facturaNombre: fact.name, lineasSinCorrespondencia: sinLinea });
  } catch (e) { fallar(res, e); }
});

/* ==================== CRUCE 2: DIARIOS Y PAGOS (CLARA) ==================== */

router.get('/api/diarios', async (req, res) => {
  try {
    const diarios = await odoo('account.journal', 'search_read',
      [[['type', 'in', ['bank', 'credit', 'cash']]]],
      { fields: ['name', 'type'] });
    res.json({ diarios });
  } catch (e) { fallar(res, e); }
});

router.get('/api/pagos', async (req, res) => {
  try {
    const { diario, desde, hasta } = req.query;
    if (!diario || !desde || !hasta) {
      return res.status(400).json({ error: 'Faltan diario, desde o hasta' });
    }
    const pagos = await odoo('account.payment', 'search_read', [[
      ['journal_id', '=', parseInt(diario, 10)],
      ['payment_type', '=', 'outbound'],
      ['date', '>=', desde],
      ['date', '<=', hasta],
      ['state', '!=', 'cancel']
    ]], { fields: ['name', 'partner_id', 'amount', 'date', 'ref', 'state'] });

    res.json({
      pagos: pagos.map(p => ({
        id: p.id,
        nombre: p.name,
        proveedor: p.partner_id ? p.partner_id[1] : '(sin proveedor)',
        monto: p.amount,
        fecha: p.date,
        referencia: p.ref || '',
        estado: p.state
      }))
    });
  } catch (e) { fallar(res, e); }
});

module.exports = router;
