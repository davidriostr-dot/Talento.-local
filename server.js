// server.js
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// === CREDENCIALES LEÍDAS DE VARIABLES DE ENTORNO ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !MP_ACCESS_TOKEN) {
  console.error('❌ Faltan variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_KEY, MP_ACCESS_TOKEN');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// === TRANSPORTADOR DE EMAIL ===
const transporter = nodemailer.createTransporter({
  service: 'gmail', // o el proveedor que uses
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS
  }
});

// === ENDPOINT: Procesar pago (modelo Escrow) ===
app.post('/api/process-payment', async (req, res) => {
  const { transaction_amount, talentId, clienteId, fecha_servicio, hora_servicio } = req.body;
  const platformCommission = Math.round(transaction_amount * 0.05);

  const paymentData = {
    transaction_amount: transaction_amount,
    token: req.body.token,
    description: `Servicio en Talento Local - Talent ID: ${talentId}`,
    payment_method_id: req.body.payment_method_id,
    installments: req.body.installments || 1,
    payer: { email: req.body.payer?.email || 'test_user@test.com' },
    application_fee: platformCommission
  };

  try {
    const response = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      paymentData,
      { headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    // Registrar en Supabase
    const { data: reservationData, error: reservationError } = await supabase
      .from('reservas')
      .insert([{
        talent_id: talentId,
        cliente_id: clienteId,
        amount: transaction_amount,
        commission: platformCommission,
        status: response.data.status,
        mp_payment_id: response.data.id,
        fecha_servicio: fecha_servicio,
        hora_servicio: hora_servicio
      }]);

    if (reservationError) throw reservationError;

    res.json({ status: response.data.status, id: response.data.id });
  } catch (error) {
    console.error('Error en pago:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al procesar el pago' });
  }
});

// === ENDPOINT: Webhook de Mercado Pago ===
app.post('/api/webhooks/mercadopago', async (req, res) => {
  const { type, data } = req.body;
  if (type !== 'payment') return res.status(200).send('OK');

  try {
    const paymentResponse = await axios.get(
      `https://api.mercadopago.com/v1/payments/${data.id}`,
      { headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    const payment = paymentResponse.data;
    if (payment.status === 'approved') {
      console.log('✅ Pago aprobado:', payment.id);

      // Actualizar estado en Supabase
      const { error } = await supabase
        .from('reservas')
        .update({ status: 'approved' })
        .eq('mp_payment_id', data.id);

      if (error) throw error;

      // Obtener datos de la reserva para enviar email
      const { data: reserva, error: fetchError } = await supabase
        .from('reservas')
        .select('cliente_id, talent_id, fecha_servicio, hora_servicio')
        .eq('mp_payment_id', data.id)
        .single();

      if (fetchError) throw fetchError;

      // Simular envío de email
      await enviarEmailConfirmacion(reserva);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).send('Error');
  }
});

// === FUNCION: Enviar Email de Confirmación ===
async function enviarEmailConfirmacion(reserva) {
  // Simular obtención de emails de clientes y talentos
  // En producción, harías un join con la tabla de usuarios
  const clienteEmail = 'cliente@ejemplo.com';
  const talentoEmail = 'talento@ejemplo.com';

  const mailOptions = {
    from: EMAIL_USER,
    to: [clienteEmail, talentoEmail],
    subject: 'Confirmación de Reserva - Talento Local',
    text: `Hola,\n\nTu reserva ha sido confirmada.\nFecha: ${reserva.fecha_servicio}\nHora: ${reserva.hora_servicio}\n\n¡Gracias por usar Talento Local!`
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('📧 Email de confirmación enviado.');
  } catch (error) {
    console.error('❌ Error al enviar email:', error);
  }
}

// === ENDPOINT: Enviar Reseña ===
app.post('/api/submit-review', async (req, res) => {
  const { talento_id, cliente_id, rating, comentario, reserva_id } = req.body;

  if (!talento_id || !cliente_id || !rating || !reserva_id) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  try {
    const { data, error } = await supabase
      .from('reviews')
      .insert([{ talento_id, cliente_id, rating, comentario, reserva_id }]);

    if (error) throw error;

    res.status(200).json({ message: 'Reseña enviada exitosamente.' });
  } catch (error) {
    console.error('Error en reseña:', error);
    res.status(500).json({ error: 'Error al enviar la reseña.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
