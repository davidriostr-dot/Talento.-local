import { Octokit } from "@octokit/rest";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    // 🔐 Inicializar clientes
    const github = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 📦 Datos del repositorio
    const owner = process.env.REPO_OWNER;
    const repo = process.env.REPO_NAME;
    const baseBranch = process.env.BASE_BRANCH || "main";
    const branch = `${process.env.AUTO_BRANCH_PREFIX || "auto-improve"}-${Date.now()}`;

    // 🔍 1. Obtener README o código base para analizar
    const { data: readme } = await github.repos.getContent({ owner, repo, path: "README.md" });
    const content = Buffer.from(readme.content, "base64").toString("utf8");

    // 🤖 2. Analizar con IA y generar mejoras
    const prompt = `
    Analiza este proyecto y sugiere mejoras de legibilidad, seguridad y rendimiento.
    Devuelve el texto completo mejorado listo para commit:
    ---
    ${content}
    `;
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }]
    });
    const improved = aiResponse.choices[0].message.content;

    // 🪶 3. Crear rama nueva con los cambios
    const { data: mainRef } = await github.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
    const newBranch = await github.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: mainRef.object.sha
    });

    // 📄 4. Subir el archivo mejorado
    await github.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: "README.md",
      message: "AI: mejora automática de documentación",
      content: Buffer.from(improved).toString("base64"),
      branch
    });

    // 🔁 5. Crear PR
    const { data: pr } = await github.pulls.create({
      owner,
      repo,
      title: "Mejora automática del proyecto con IA 🤖",
      head: branch,
      base: baseBranch,
      body: "Este cambio fue generado automáticamente por el sistema de mejora inteligente."
    });

    // 🧠 6. Registrar en Supabase
    await supabase.from("auto_logs").insert([
      {
        action: "AI Improvement",
        branch,
        pull_request_url: pr.html_url,
        created_at: new Date()
      }
    ]);

    res.status(200).json({ success: true, pull_request: pr.html_url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
}
