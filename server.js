// server.js
require('dotenv').config(); 
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// === CONFIGURACIÓN SEGURA CON VARIABLES DE ENTORNO ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !MP_ACCESS_TOKEN) {
  console.error('❌ Faltan variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_KEY, MP_ACCESS_TOKEN');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// === ENDPOINT: Procesar pago (modelo Escrow) ===
app.post('/api/process-payment', async (req, res) => {
  const { transaction_amount, talentId } = req.body;
  const platformCommission = Math.round(transaction_amount * 0.05);

  const paymentData = {
    transaction_amount: transaction_amount,
    token: req.body.token,
    description: `Servicio en Talento Local - Talent ID: ${talentId}`,
    payment_method_id: req.body.payment_method_id,
    installments: req.body.installments || 1,
    payer: { email: req.body.payer?.email || 'test_user@test.com' },
    application_fee: platformCommission // Comisión retenida
  };

  try {
    const response = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      paymentData,
      { headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    // Registrar en Supabase (backend seguro con Service Role Key)
    await supabase.from('payments').insert([{
      talent_id: talentId,
      amount: transaction_amount,
      commission: platformCommission,
      status: response.data.status,
      mp_payment_id: response.data.id
    }]);

    res.json({
      status: response.data.status,
      id: response.data.id
    });
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
      // Actualizar estado en Supabase
      await supabase
        .from('payments')
        .update({ status: 'approved', updated_at: new Date().toISOString() })
        .eq('mp_payment_id', data.id);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).send('Error');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend corriendo en puerto ${PORT}`);
});