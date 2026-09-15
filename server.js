const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFI_CLIENT_TOKEN = process.env.DEFI_CLIENT_TOKEN;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '35mb' }));

function errText(status, data) {
  return data?.error?.message || data?.message || `HTTP ${status}`;
}

function requireClientToken(req, res, next) {
  if (!DEFI_CLIENT_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: 'Le serveur central n\'a pas encore son DEFI_CLIENT_TOKEN.'
    });
  }

  const supplied = String(req.get('x-defi-token') || '');
  if (!supplied || supplied !== DEFI_CLIENT_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: 'Accès au serveur IA non autorisé.'
    });
  }

  next();
}

async function openai(body) {
  if (!OPENAI_API_KEY) {
    throw new Error("Le serveur IA n'a pas sa clé OpenAI (OPENAI_API_KEY).");
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}

  if (!response.ok) {
    throw new Error(`OpenAI (${response.status}) : ${errText(response.status, data)}`);
  }

  return data;
}

function outputText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join('\n').trim();
}

function parseJson(text) {
  text = String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/i, '');

  try { return JSON.parse(text); } catch {}

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }

  throw new Error('Réponse IA non exploitable.');
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Défi Informatique IA Central', message: 'Serveur Vercel opérationnel' });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Défi Informatique IA Central',
    configured: Boolean(OPENAI_API_KEY && DEFI_CLIENT_TOKEN),
    openaiConfigured: Boolean(OPENAI_API_KEY),
    clientTokenConfigured: Boolean(DEFI_CLIENT_TOKEN)
  });
});

app.post('/api/test-ai', requireClientToken, async (req, res) => {
  try {
    const model = String(req.body?.model || DEFAULT_MODEL);
    const data = await openai({
      model,
      input: 'Réponds uniquement par OK.',
      max_output_tokens: 20
    });
    res.json({ ok: true, message: outputText(data) || 'OK' });
  } catch (error) {
    console.error('TEST IA ERREUR:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/grade-answers', requireClientToken, async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.json({ ok: true, results: [] });

    const prompt = `Tu es un correcteur scolaire très rigoureux mais juste. Pour chaque réponse écrite d'élève, décide si elle est CORRECTE ou INCORRECTE en te basant sur la question et la réponse attendue fournie. Une réponse peut être formulée très différemment et rester correcte : accepte les synonymes, reformulations, explications équivalentes, exemples pertinents et petites fautes d'orthographe qui ne changent pas le sens. N'exige JAMAIS que l'élève recopie mot pour mot la réponse attendue. Si la réponse contient l'idée essentielle correcte, considère-la correcte. Si elle est partiellement correcte mais qu'une partie essentielle manque, considère-la incorrecte. Retourne UNIQUEMENT un JSON valide sous la forme {"results":[{"index":0,"correct":true,"reason":"courte explication"}]}.

Réponses à corriger :\n${JSON.stringify(items)}`;

    const data = await openai({
      model: String(req.body?.model || DEFAULT_MODEL),
      max_output_tokens: 5000,
      input: prompt
    });

    const parsed = parseJson(outputText(data));
    if (!Array.isArray(parsed.results)) {
      throw new Error('Résultat de correction IA invalide.');
    }

    res.json({
      ok: true,
      results: parsed.results.map((item, index) => ({
        index: Number.isFinite(Number(item.index)) ? Number(item.index) : index,
        correct: Boolean(item.correct),
        reason: String(item.reason || '')
      }))
    });
  } catch (error) {
    console.error('CORRECTION IA ERREUR:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/generate-homework', requireClientToken, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'PDF manquant.' });
    }

    const model = String(req.body.model || DEFAULT_MODEL);
    const count = Math.max(1, Math.min(100, Number(req.body.count) || 20));
    const difficulty = String(req.body.difficulty || 'Moyen');
    const classe = String(req.body.classe || '');
    const subject = String(req.body.subject || '');

    const prompt = `Tu es un enseignant expert.

Analyse UNIQUEMENT le contenu du PDF fourni comme source principale. Crée un devoir pédagogique en français.
Classe: ${classe || 'non précisée'}
Matière: ${subject || 'non précisée'}
Difficulté: ${difficulty}
Nombre demandé: ${count}

Règles:
- Appuie-toi sur le PDF.
- Évite les doublons et couvre plusieurs parties du document.
- Environ 70% QCM et 30% réponses écrites.
- Chaque QCM a exactement 4 propositions et une seule bonne réponse.
- Réponse écrite: réponse attendue courte.
- Retourne UNIQUEMENT du JSON valide.

Format:
{"title":"...","classe":"...","subject":"...","questions":[{"q":"...","type":"qcm","options":["...","...","...","..."],"answer":0,"expected":""},{"q":"...","type":"written","options":[],"answer":0,"expected":"..."}]}`;

    const base64 = req.file.buffer.toString('base64');
    const data = await openai({
      model,
      max_output_tokens: 30000,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          {
            type: 'input_file',
            filename: req.file.originalname || 'manuel.pdf',
            file_data: `data:application/pdf;base64,${base64}`
          }
        ]
      }]
    });

    const parsed = parseJson(outputText(data));
    if (!Array.isArray(parsed.questions) || !parsed.questions.length) {
      throw new Error('Aucune question générée.');
    }

    const questions = parsed.questions.map((q, index) => {
      if (!q.q) throw new Error(`Question ${index + 1} sans énoncé.`);

      if (q.type === 'written') {
        return {
          q: String(q.q),
          type: 'written',
          options: [],
          answer: 0,
          expected: String(q.expected || '')
        };
      }

      const options = Array.isArray(q.options) ? q.options.map(String).slice(0, 4) : [];
      const answer = Number(q.answer);

      if (options.length !== 4 || ![0, 1, 2, 3].includes(answer)) {
        throw new Error(`Question ${index + 1}: QCM invalide.`);
      }

      return {
        q: String(q.q),
        type: 'qcm',
        options,
        answer,
        expected: ''
      };
    });

    res.json({
      ok: true,
      homework: {
        title: String(parsed.title || `Devoir ${subject || 'informatique'}`),
        classe: String(parsed.classe || classe),
        subject: String(parsed.subject || subject),
        questions
      }
    });
  } catch (error) {
    console.error('GENERATION DEVOIR ERREUR:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Défi IA central on ${HOST}:${PORT}`);
  });
}

module.exports = app;
