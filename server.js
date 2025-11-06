// server.js
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// === CREDENCIALES LIVE LEÍDAS DE VARIABLES DE ENTORNO ===
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_CLIENT_ID = process.env.MP_CLIENT_ID;
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET;

if (!MP_ACCESS_TOKEN || !MP_CLIENT_ID || !MP_CLIENT_SECRET) {
  console.error('❌ Faltan variables de entorno: MP_ACCESS_TOKEN, MP_CLIENT_ID, MP_CLIENT_SECRET');
  process.exit(1);
}

// === ENDPOINT: Procesar pago (modelo Escrow) ===
app.post('/api/process-payment', async (req, res) => {
  const { transaction_amount } = req.body;
  const platformCommission = Math.round(transaction_amount * 0.05);

  const paymentData = {
    transaction_amount: transaction_amount,
    token: req.body.token,
    description: 'Servicio en Talento Local',
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

    res.json({ status: response.data.status, id: response.data.id });
  } catch (error) {
    console.error('Error en pago:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al procesar el pago' });
  }
});

// === ENDPOINT: Webhook de Mercado Pago ===
app.post('/api/webhooks/mercadopago', async (req, res) => {
  const { type, data } = req.body;
  if (type !== 'payment') return res.status(200).send('Ignored');

  try {
    const paymentResponse = await axios.get(
      `https://api.mercadopago.com/v1/payments/${data.id}`,
      { headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` } }
    );

    const payment = paymentResponse.data;
    // Aquí puedes actualizar tu base de datos
    console.log('✅ Pago aprobado:', payment.id);

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error en webhook:', error.response?.data || error.message);
    res.status(500).send('Error');
  }
});

// === ENDPOINT: Autorización OAuth (simulado) ===
app.get('/mp/authorize', (req, res) => {
  const CLIENT_ID = MP_CLIENT_ID;
  const REDIRECT_URI = encodeURIComponent('https://tu-app.com/mp/authorize');
  const STATE = 'tl_oauth_state_' + Math.random().toString(36).substring(2, 15);

  const authUrl = `https://auth.mercadopago.com.ar/authorization?client_id=${CLIENT_ID}&response_type=code&platform_id=mp&redirect_uri=${REDIRECT_URI}&state=${STATE}`;
  res.redirect(authUrl);
});

// === INSTRUCCIONES PARA EL DESARROLLADOR ===
/*
  ⚠️ IMPORTANTE: Antes de desplegar en Render, asegúrate de configurar las siguientes variables de entorno:

  | Variable de Entorno en Render | Valor LIVE que debe Asignarse                     |
  | :---------------------------- | :----------------------------------------------- |
  | MP_ACCESS_TOKEN               | APP_USR-6117234141433753-102210-cf6d8072969bb661b56348c3b0e67926-1343165906 |
  | MP_CLIENT_ID                  | 6117234141433753                                 |
  | MP_CLIENT_SECRET              | u6ZU8Vsq5DgDMZH1CP5gXnys0zvCHgWS                 |

  Estas claves son SECRETAS. Nunca las compartas ni las subas a un repositorio público.
*/

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
