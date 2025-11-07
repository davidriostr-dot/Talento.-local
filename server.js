// server.js
// Backend de Talento Local
// Optimizado para despliegue en Render

// =============== CARGA DE DEPENDENCIAS ===============
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// =============== MIDDLEWARES ===============
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============== VARIABLES DE ENTORNO ===============
// Asegura que todas las credenciales estén presentes
const REQUIRED_ENV_VARS = [
  'MP_ACCESS_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'EMAIL_USER',
  'EMAIL_PASS'
];

for (const envVar of REQUIRED_ENV_VARS) {
  if (!process.env[envVar]) {
    console.error(`❌ ERROR: '${envVar}' no está definida en las variables de entorno.`);
    process.exit(1);
  }
}

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

// =============== INICIALIZACIÓN DE CLIENTES ===============
const mp = new MercadoPago({ accessToken: MP_ACCESS_TOKEN });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// =============== TRANSPORTADOR DE EMAIL ===============
const transporter = nodemailer.createTransporter({
  service: 'gmail', // Cambia si usas otro proveedor
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
});

// =============== RUTA PRINCIPAL ===============
app.get('/', (req, res) => {
  res.status(200).send('<h1>Talento Local API</h1><p>Servidor corriendo correctamente.</p>');
});

// =============== PROCESAR PAGO (modelo Escrow) ===============
app.post('/api/process-payment', async (req, res) => {
  const { transaction_amount, talentId, clienteId, fecha_servicio, hora_servicio } = req.body;

  // Calcula comisión (5%)
  const platformCommission = Math.round(transaction_amount * 0.05);

  const paymentData = {
    transaction_amount: transaction_amount,
    token: req.body.token,
    description: `Servicio en Talento Local - Talent ID: ${talentId}`,
    payment_method_id: req.body.payment_method_id,
    installments: req.body.installments || 1,
    payer: { email: req.body.payer?.email || 'test_user@test.com' },
    application_fee: platformCommission // ← Retención de la comisión
  };

  try {
    const response = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      paymentData,
      { headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    // Guarda en Supabase
    const { data, error } = await supabase
      .from('reservas')
      .insert([{
        talent_id: talentId,
        cliente_id: clienteId,
        monto_total: transaction_amount,
        comision_plataforma: platformCommission,
        estado_pago: response.data.status,
        mp_payment_id: response.data.id,
        fecha_servicio: fecha_servicio,
        hora_servicio: hora_servicio,
        fecha_creacion: new Date().toISOString()
      }]);

    if (error) throw error;

    res.status(200).json({
      status: response.data.status,
      id: response.data.id
    });

  } catch (error) {
    console.error('Error en pago:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al procesar el pago', details: error.message });
  }
});

// =============== WEBHOOK DE MERCADOPAGO ===============
app.post('/api/webhooks/mercadopago', async (req, res) => {
  const { type, data } = req.body;

  if (type !== 'payment') {
    return res.status(200).send('Evento no procesado');
  }

  try {
    // Obtiene el estado del pago
    const paymentResponse = await axios.get(
      `https://api.mercadopago.com/v1/payments/${data.id}`,
      { headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    const payment = paymentResponse.data;

    if (payment.status === 'approved') {
      console.log(`✅ Pago aprobado: ${payment.id}`);

      // Actualiza el estado en Supabase
      const { error } = await supabase
        .from('reservas')
        .update({ estado_pago: 'approved', fecha_aprobacion: new Date().toISOString() })
        .eq('mp_payment_id', data.id);

      if (error) throw error;

      // Enviar email de confirmación
      await enviarEmailConfirmacion(data.id);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error en webhook:', error.message);
    res.status(500).send('Error');
  }
});

// =============== FUNCIÓN: Enviar Email de Confirmación ===============
async function enviarEmailConfirmacion(paymentId) {
  // En una implementación real, aquí harías un JOIN con Supabase
  // para obtener los emails de cliente y talento.

  // Simulamos la obtención de datos
  const reserva = await obtenerReservaPorMpId(paymentId);

  if (!reserva) {
    console.error('❌ No se encontró reserva para el pago:', paymentId);
    return;
  }

  const clienteEmail = 'cliente@ejemplo.com'; // Obtener de Supabase
  const talentoEmail = 'talento@ejemplo.com'; // Obtener de Supabase

  const mailOptions = {
    from: EMAIL_USER,
    to: [clienteEmail, talentoEmail], // Puedes enviar a ambos o individualmente
    subject: 'Confirmación de Servicio - Talento Local',
    text: `Hola,\n\nTu servicio ha sido confirmado con éxito.\nFecha: ${reserva.fecha_servicio}\nHora: ${reserva.hora_servicio}\n\n¡Gracias por usar Talento Local!`
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`📧 Email enviado para el pago ${paymentId}`);
  } catch (error) {
    console.error('❌ Error al enviar email:', error.message);
  }
}

// =============== FUNCIÓN AUXILIAR: Obtener reserva ===============
async function obtenerReservaPorMpId(mpPaymentId) {
  const { data, error } = await supabase
    .from('reservas')
    .select('cliente_id, talent_id, fecha_servicio, hora_servicio')
    .eq('mp_payment_id', mpPaymentId)
    .single();

  if (error) {
    console.error('Error al buscar reserva:', error.message);
    return null;
  }

  return data;
}

// =============== ENDPOINT: Enviar Reseña ===============
app.post('/api/submit-review', async (req, res) => {
  const { talento_id, cliente_id, rating, comentario, reserva_id } = req.body;

  if (!talento_id || !cliente_id || !rating || !reserva_id || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Datos inválidos para la reseña.' });
  }

  try {
    const { data, error } = await supabase
      .from('reseñas')
      .insert([{ talento_id, cliente_id, rating, comentario, reserva_id, fecha: new Date().toISOString() }]);

    if (error) throw error;

    res.status(200).json({ message: 'Reseña guardada exitosamente.' });
  } catch (error) {
    console.error('Error al guardar reseña:', error.message);
    res.status(500).json({ error: 'Error al guardar la reseña.' });
  }
});

// =============== SERVIDOR ===============
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`🌍 Disponible en: http://localhost:${PORT}`);
  console.log(`🔐 Modo: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
