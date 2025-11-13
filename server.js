// server.js
// Backend de Talento Local
// Optimizado para despliegue en Render
// Incluye integración de mejora automática por IA

const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
// ✅ Puerto dinámico para Render
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// === CREDENCIALES DESDE VARIABLES DE ENTORNO ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !MP_ACCESS_TOKEN) {
  console.error('❌ Faltan variables de entorno críticas: SUPABASE_URL, SUPABASE_SERVICE_KEY, MP_ACCESS_TOKEN');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// === TRANSPORTADOR DE EMAIL ===
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

const transporter = EMAIL_USER && EMAIL_PASS ? nodemailer.createTransporter({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
}) : null;

// === ENDPOINT: Procesar pago (modelo Escrow) ===
app.post('/api/process-payment', async (req, res) => {
  const { transaction_amount, talentId } = req.body;
  const platformCommission = Math.round(transaction_amount * 0.05); // 5%

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
        monto_total: transaction_amount,
        comision_plataforma: platformCommission,
        estado_pago: response.data.status,
        mp_payment_id: response.data.id,
        fecha_creacion: new Date().toISOString()
      }]);

    if (error) throw error;

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

      // Actualizar estado en Supabase
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
    console.error('❌ Error en webhook:', error);
    res.status(500).send('Error');
  }
});

// === FUNCIÓN: Enviar email de confirmación ===
async function enviarEmailConfirmacion(paymentId) {
  // En una implementación real, aquí harías un JOIN con Supabase
  // para obtener los emails de cliente y talento.

  // Simulamos la obtención de datos
  const {  reserva, error: fetchError } = await supabase
    .from('reservas')
    .select(`
      cliente_id, talent_id,
      clientes (email, nombre_completo),
      talentos (nombre_negocio, usuario_id, usuarios(email, nombre_completo))
    `)
    .eq('mp_payment_id', paymentId)
    .single();

  if (fetchError) {
    console.error('Error al obtener datos de reserva:', fetchError);
    return;
  }

  const clienteEmail = reserva.clientes.email;
  const clienteNombre = reserva.clientes.nombre_completo;
  const talentoEmail = reserva.talentos.usuarios.email;
  const talentoNombre = reserva.talentos.nombre_negocio || reserva.talentos.usuarios.nombre_completo;

  const html = `
    <h2>🎉 Pago Aprobado</h2>
    <p>Hola ${clienteNombre},</p>
    <p>El pago por su reserva con <strong>${talentoNombre}</strong> ha sido <strong>aprobado exitosamente</strong>.</p>
    <p>Fecha del servicio: ${new Date(reserva.fecha_hora).toLocaleString()}</p>
    <p>¡Gracias por usar Talento Local!</p>
  `;

  if (transporter) {
    try {
      await transporter.sendMail({
        from: EMAIL_USER,
        to: [clienteEmail, talentoEmail],
        subject: 'Pago Aprobado - Talento Local',
        html
      });
      console.log(`📧 Email enviado para el pago ${paymentId}`);
    } catch (error) {
      console.error('❌ Error al enviar email:', error);
    }
  }
}

// === ENDPOINT: Sistema de Calificación y Reseñas ===
app.post('/api/submit-review', async (req, res) => {
  const { talento_id, cliente_id, rating, comentario, reserva_id } = req.body;

  if (!talento_id || !cliente_id || !rating || !reserva_id || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Datos inválidos para la reseña.' });
  }

  try {
    const { data, error } = await supabase
      .from('reseñas')
      .insert([{ talento_id, cliente_id, rating, comentario, reserva_id, created_at: new Date().toISOString() }]);

    if (error) throw error;

    // Actualizar rating promedio del talento
    const {  reseñas, error: fetchError } = await supabase
      .from('reseñas')
      .select('rating')
      .eq('talento_id', talento_id);

    if (fetchError) throw fetchError;

    const avgRating = reseñas.reduce((acc, r) => acc + r.rating, 0) / reseñas.length;
    const { error: updateError } = await supabase
      .from('talentos')
      .update({ rating_promedio: avgRating, total_reseñas: reseñas.length })
      .eq('id', talento_id);

    if (updateError) throw updateError;

    res.status(200).json({ message: 'Reseña guardada exitosamente.' });
  } catch (error) {
    console.error('Error al guardar reseña:', error.message);
    res.status(500).json({ error: 'Error al guardar la reseña.', details: error.message });
  }
});

// === NUEVO: Endpoint de mejora automática por IA ===
const { Octokit } = require('@octokit/rest');
const OpenAI = require('openai');

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const baseBranch = process.env.BASE_BRANCH || 'main';
const autoPrefix = process.env.AUTO_BRANCH_PREFIX || 'auto-improve';

app.post('/api/improve', async (req, res) => {
  if (!REPO_OWNER || !REPO_NAME || !openai.apiKey || !GITHUB_TOKEN) {
    return res.status(500).json({ error: 'Faltan credenciales para GitHub o OpenAI.' });
  }

  try {
    // 1. Obtener el contenido del README
    const {  file } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: 'README.md',
      ref: baseBranch,
    });

    const content = Buffer.from(file.content, 'base64').toString('utf8');

    // 2. Analizar con OpenAI
    const prompt = `
Eres un ingeniero de software experto y diseñador UX. 
Analiza este código o documentación y crea una versión mejorada:
- Limpia errores o malas prácticas
- Mejora la organización del texto o código
- Sugerí optimizaciones técnicas o de diseño visual
- No elimines información útil

Contenido actual:
${content}
`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
    });

    const improved = aiResponse.choices[0].message.content;

    // 3. Crear nueva rama
    const branchName = `${autoPrefix}-${Date.now()}`;
    const {  refData } = await octokit.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: \`heads/\${baseBranch}\`,
    });

    await octokit.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: \`refs/heads/\${branchName}\`,
      sha: refData.object.sha,
    });

    // 4. Subir cambios a la nueva rama
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: 'README.md',
      message: '🤖 Mejora automática generada por IA',
      content: Buffer.from(improved).toString('base64'),
      branch: branchName,
    });

    // 5. Crear Pull Request
    const pr = await octokit.pulls.create({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      title: '✨ Mejora automática (IA)',
      head: branchName,
      base: baseBranch,
      body: 'Este Pull Request fue generado automáticamente por la IA de mejora continua.',
    });

    // 6. Guardar log en Supabase
    const { error: logError } = await supabase
      .from('auto_logs')
      .insert({
        action: 'improve',
        branch: branchName,
        pr_url: pr.data.html_url,
        timestamp: new Date().toISOString(),
      });

    if (logError) throw logError;

    res.json({
      success: true,
      message: 'Pull Request creado con éxito',
      pull_request: pr.data.html_url,
    });
  } catch (err) {
    console.error('❌ Error en /api/improve:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// --- 🔁 Ejecución continua ---
let autoImproveActive = true;

async function autoImproveLoop() {
  while (autoImproveActive) {
    try {
      console.log("🧠 Iniciando ciclo automático de mejora...");

      // Simula la ejecución del endpoint interno
      const res = await fetch(\`http://localhost:\${PORT}/api/improve\`, { method: "POST" });
      const data = await res.json();

      if (data.success) {
        console.log("✅ Pull Request creado:", data.pull_request);
      } else {
        console.warn("⚠️ Falló el intento de mejora:", data.error);
      }
    } catch (err) {
      console.error("❌ Error en el ciclo:", err.message);
    }

    // Esperar 5 minutos antes del próximo ciclo
    console.log("🕒 Esperando 5 minutos para el siguiente intento...");
    await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
  }
}

// Ruta para detener el proceso manualmente
app.post("/api/stop", (req, res) => {
  autoImproveActive = false;
  console.log("🛑 Proceso automático detenido manualmente.");
  res.json({ success: true, message: "Ciclo de mejora detenido." });
});

// Inicia el ciclo automáticamente cuando arranca el servidor
if (process.env.NODE_ENV !== 'test') {
  autoImproveLoop();
}

// Ruta raíz
app.get('/', (req, res) => {
  res.send('🚀 Talento Local Backend conectado correctamente');
});

// Iniciar servidor en el puerto correcto
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto \${PORT}`);
  console.log(\`🌍 Disponible en: http://localhost:\${PORT}\`);
  console.log(\`🔐 Modo: \${process.env.NODE_ENV || 'development'}\`);
});
