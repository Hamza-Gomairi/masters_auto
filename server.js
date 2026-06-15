import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const templatePath = path.join(__dirname, 'template_formulaire_jury.html');
const templateArPath = path.join(__dirname, 'template_formulaire_jury_ar.html');
const logoPath = path.join(__dirname, 'public', 'static', 'fsjest-removebg-preview.png');
const adminDbPath = path.join(__dirname, 'data', 'attestations.json');
const adminUiPath = process.env.ADMIN_UI_PATH || '/admin-7f3c1b9e';
const apowebUrl = process.env.APOWEB_URL || 'https://api-apoweb-num-ta.uae.ac.ma/api_fsjes_ta_cne.php';
const apowebEtb = process.env.APOWEB_ETB || 'FDT';
const apowebInsecureTls = process.env.APOWEB_INSECURE_TLS === '1';

if (apowebInsecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

let logoDataUrlPromise;

const masters = [
  "Master en Économie de Développement Durable et d'Innovation",
  'Management des ressources humaines et de la qualité',
  'LOGISTIQUE PORTUAIRE ET TRANSPORT INTERNATIONAL-LPTI-',
  'FINANCE FISCALITÉ ET COMPTABILITÉ',
  "Intelligence Artificielle pour l'Economie Numérique et la Gestion",
  'DROIT PUBLIC DES AFFAIRES ET DE COMMERCE INTERNATIONAL',
  'Droit international public',
  'DROIT DES AFFAIRES ET E.BUSINESS',
  'القانون والعلوم الإدارية والمالية للتنمية',
  'حقوق الإنسان والتقاضي الدولي',
  'قانون المنازعات',
  'المهن القانونية والقضائيةوالتحولات الاقتصادية والرقمية',
  'الدراسات العقارية والتوثيق الرقمي',
  'النظام الجمركي ومنازعات الاستثمار',
  'القانون المدني والأعمال والمعاملات الائتمانية',
  'السياسةالجنائية ورصد وتحليل الظاهرة الإجرامية',
  'المنازعات المدنيةوالتجارية',
  'القانون المقارن للأعمال',
  'المساطر القانونية والوسائل البديلة لتسوية المنازعات',
  'قانون الاستثمار وآليات تدبير المنازعات',
  'قوانين التجارة والاعمال والتحول الرقمي',
  'المنازعات العقدية والتكنولوجيات الحديثة',
  'القانون الجنائي للأعمال والعدالة الرقمية'
];

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/admin.html', (req, res) => {
  return res.status(404).send('Not found');
});

app.get(adminUiPath, (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/masters', (req, res) => {
  res.json({ masters });
});

app.get('/api/admin/attestation-status', async (req, res) => {
  try {
    const cne = normalizeCne(req.query.cne || req.query.apogee || '');
    if (!cne) return res.status(400).json({ message: 'Le CNE est obligatoire.' });

    const record = await getAdminRecord(cne);
    if (!record) {
      return res.json({
        cne, status: 'not_found', created: false, createdAt: null,
        lastAttemptAt: null, validatedSemesters: null, reason: 'Aucune génération détectée.'
      });
    }
    return res.json({ cne, ...record });
  } catch (error) {
    console.error('Erreur /api/admin/attestation-status:', error);
    return res.status(500).json({ message: 'Erreur interne.' });
  }
});

app.post('/api/validate-and-generate', async (req, res) => {
  try {
    const formData = normalizeFormData(req.body);
    const validationErrors = validateFormData(formData);

    if (validationErrors.length > 0) {
      if (formData.cne) {
        await upsertAdminRecord(formData.cne, {
          status: 'invalid', created: false, validatedSemesters: null, reason: validationErrors.join(' ')
        }).catch(() => {});
      }
      return res.status(422).json({ errors: validationErrors });
    }

    const eligibility = await checkCneEligibilityViaApoweb(formData.cne);
    const missingSemesters = eligibility.missingSemesters || [];

    if (eligibility.error) {
      await upsertAdminRecord(formData.cne, {
        status: 'error',
        created: false,
        validatedSemesters: eligibility.validatedSemesters,
        reason: eligibility.reason || 'Erreur API de vérification.'
      }).catch(() => {});

      return res.status(503).json({
        message: "Service de vérification indisponible. Réessayez plus tard.",
        reason: eligibility.reason || 'Erreur API de vérification.'
      });
    }

    if (eligibility.validatedSemesters < 3) {
      await upsertAdminRecord(formData.cne, {
        status: 'ineligible',
        created: false,
        validatedSemesters: eligibility.validatedSemesters,
        reason: missingSemesters.length > 0 ? `Semestres non validés: ${missingSemesters.join(', ')}` : (eligibility.reason || 'Moins de 3 semestres')
      }).catch(() => {});
      return res.status(400).json({ message: "Tu n'as pas validé les 3 semestres" });
    }

    await upsertAdminRecord(formData.cne, {
      status: 'pending',
      created: false,
      validatedSemesters: eligibility.validatedSemesters,
      reason: 'Génération en cours.'
    }).catch(() => {});

    const html = await renderTemplate(formData);
    const pdf = await generatePdf(html);
    const fileName = `proposition-jury-${safeFileName(formData.cne)}.pdf`;

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${fileName}"`,
      'Content-Length': pdf.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    await upsertAdminRecord(formData.cne, {
      status: 'created', created: true, validatedSemesters: eligibility.validatedSemesters, reason: 'PDF généré avec succès.'
    }).catch((e) => console.error("Erreur écriture log DB ignorée:", e.message));

    return res.end(pdf);

  } catch (error) {
    console.error('Erreur critique /api/validate-and-generate:', error);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Erreur lors de la génération du PDF.' });
    }
  }
});

async function getAdminRecord(apogee) {
  try {
    const db = await readAdminDb();
    return db.records?.[String(apogee)] || null;
  } catch {
    return null;
  }
}

async function upsertAdminRecord(apogee, patch) {
  const key = String(apogee);
  const now = new Date().toISOString();

  try {
    const db = await readAdminDb();
    db.records = db.records || {};
    const existing = db.records[key] || {};

    const nextId = Number.isFinite(db.nextId) ? Number(db.nextId) : 1;
    const attestationCode = existing.attestationCode ? String(existing.attestationCode) : String(nextId);

    if (!existing.attestationCode) {
      db.nextId = nextId + 1;
    }

    db.records[key] = {
      status: patch.status || existing.status || 'unknown',
      created: Boolean(patch.created ?? existing.created ?? false),
      createdAt: existing.createdAt || (patch.created ? now : null),
      lastAttemptAt: now,
      validatedSemesters: patch.validatedSemesters ?? existing.validatedSemesters ?? null,
      reason: patch.reason || existing.reason || null,
      attestationCode
    };

    await writeAdminDb(db);
  } catch (e) {
    console.error("Impossible d'écrire l'historique dans le JSON:", e.message);
  }
}

async function readAdminDb() {
  try {
    const raw = await fs.readFile(adminDbPath, 'utf8');
    return JSON.parse(raw) || { records: {}, nextId: 1 };
  } catch {
    return { records: {}, nextId: 1 };
  }
}

async function writeAdminDb(db) {
  await fs.mkdir(path.dirname(adminDbPath), { recursive: true });
  await fs.writeFile(adminDbPath, JSON.stringify(db, null, 2), 'utf8');
}

function normalizeCne(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeFormData(body) {
  return {
    nom: String(body.nom || '').trim(),
    prenom: String(body.prenom || '').trim(),
    cne: normalizeCne(body.cne || body.apogee || ''),
    telephone: String(body.telephone || '').trim(),
    email: String(body.email || '').trim().toLowerCase(),
    master: String(body.master || '').trim(),
    professeur: String(body.professeur || '').trim(),
    theme: String(body.theme || '').trim(),
    lang: String(body.lang || '').trim().toLowerCase()
  };
}

function validateFormData(data) {
  const errors = [];
  const emailPattern = /^[a-zA-Z0-9._%+-]+@etu\.uae\.ac\.ma$/;

  if (!data.nom) errors.push('Le nom est obligatoire.');
  if (!data.prenom) errors.push('Le prénom est obligatoire.');
  if (!data.cne) errors.push('Le CNE est obligatoire.');
  if (!data.telephone) errors.push('Le numéro de téléphone est obligatoire.');

  if (data.email && data.email.length > 0) {
    if (!emailPattern.test(data.email)) errors.push("L'email est invalide.");
  }

  if (!data.master) errors.push('Le nom du Master est obligatoire.');
  if (data.master && !masters.includes(data.master)) errors.push('Le Master sélectionné est invalide.');
  if (!data.professeur) errors.push('Le nom du Professeur responsable est obligatoire.');
  if (!data.theme) errors.push('Le thème du mémoire est obligatoire.');

  return errors;
}

function extractJsonObjectFromText(text, startIndex) {
  let i = startIndex;
  while (i < text.length && text[i] !== '{') i += 1;
  if (i >= text.length) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let j = i; j < text.length; j += 1) {
    const ch = text[j];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;

    if (depth === 0) {
      return text.slice(i, j + 1);
    }
  }

  return null;
}

async function checkCneEligibilityViaApoweb(cne) {
  const normalizedCne = normalizeCne(cne);
  const requiredSemesters = ['SE07', 'SE08', 'SE09'];
  const url = new URL(apowebUrl);
  url.searchParams.set('apogee', normalizedCne);
  url.searchParams.set('etb', apowebEtb);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch(url, {
      signal: controller.signal
    });

    if (!resp.ok) {
      return {
        cne: normalizedCne,
        validatedSemesters: 0,
        missingSemesters: requiredSemesters,
        source: 'api',
        error: true,
        reason: `HTTP ${resp.status} depuis l'API Apoweb.`
      };
    }

    const rawText = await resp.text();
    const markerIndex = rawText.toLowerCase().indexOf('relev');
    if (markerIndex < 0) {
      return {
        cne: normalizedCne,
        validatedSemesters: 0,
        missingSemesters: requiredSemesters,
        source: 'api',
        error: true,
        reason: 'Réponse API inattendue (Relevé de notes introuvable).'
      };
    }

    const jsonText = extractJsonObjectFromText(rawText, markerIndex);
    if (!jsonText) {
      return {
        cne: normalizedCne,
        validatedSemesters: 0,
        missingSemesters: requiredSemesters,
        source: 'api',
        error: true,
        reason: 'JSON notes introuvable.'
      };
    }

    const data = JSON.parse(jsonText);
    const notes = data?.notes ? Object.values(data.notes) : [];

    if (notes.length === 0) {
      return {
        cne: normalizedCne,
        validatedSemesters: 0,
        missingSemesters: requiredSemesters,
        source: 'api',
        error: true,
        reason: 'Notes introuvables dans la réponse API.'
      };
    }

    const semesterStatus = Object.fromEntries(requiredSemesters.map((s) => [s, { found: false, valid: false }]));
    for (const item of notes) {
      const code = String(item?.cod_nel || '').trim().toUpperCase();
      if (!semesterStatus[code] || semesterStatus[code].found) continue;

      const codTre = String(item?.cod_tre || '').trim().toUpperCase();
      const libTre = String(item?.lib_tre || '').toLowerCase();
      const libTreArb = String(item?.lib_tre_arb || '').toLowerCase();

      const valid = codTre === 'V' || codTre === 'VAR' || libTre.includes('valide') || libTreArb.includes('valide');
      semesterStatus[code] = { found: true, valid };
    }

    const missingSemesters = requiredSemesters.filter((s) => !semesterStatus[s].valid);
    const validatedSemesters = requiredSemesters.length - missingSemesters.length;

    return { cne: normalizedCne, validatedSemesters, missingSemesters, source: 'api' };
  } catch (e) {
    return {
      cne: normalizedCne,
      validatedSemesters: 0,
      missingSemesters: requiredSemesters,
      source: 'api',
      error: true,
      reason: `Erreur API: ${e?.message || 'inconnue'}`
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function renderTemplate(data) {
  const lang = String(data.lang || '').toLowerCase();
  const selectedTemplatePath = lang === 'ar' ? templateArPath : templatePath;
  const template = await fs.readFile(selectedTemplatePath, 'utf8');
  const fullName = `${data.nom} ${data.prenom}`.trim();
  const today = new Intl.DateTimeFormat('fr-FR').format(new Date());
  const logoDataUrl = await loadLogoDataUrl();

  let attestationCode = "1";
  try {
    const db = await readAdminDb();
    attestationCode = db.records?.[data.cne]?.attestationCode || String(db.nextId || 1);
  } catch {}

  return template
    .replaceAll('[DYNAMIC_LOGO_SRC]', logoDataUrl)
    .replaceAll('[DYNAMIC_ATTESTATION_CODE]', escapeHtml(attestationCode))
    .replaceAll('[DYNAMIC_DATE]', escapeHtml(today))
    .replaceAll('[DYNAMIC_MASTER_NAME]', escapeHtml(data.master))
    .replaceAll('[DYNAMIC_NOM_PRENOM]', escapeHtml(fullName))
    .replaceAll('[DYNAMIC_CNE]', escapeHtml(data.cne))
    .replaceAll('[DYNAMIC_TELEPHONE]', escapeHtml(data.telephone))
    .replaceAll('[DYNAMIC_EMAIL]', escapeHtml(data.email))
    .replaceAll('[DYNAMIC_PROF_RESPONSABLE]', escapeHtml(data.professeur))
    .replaceAll('[DYNAMIC_THEME]', escapeHtml(data.theme));
}

async function loadLogoDataUrl() {
  if (!logoDataUrlPromise) {
    logoDataUrlPromise = fs
      .readFile(logoPath)
      .then((buffer) => `data:image/png;base64,${buffer.toString('base64')}`)
      .catch(() => '');
  }
  return logoDataUrlPromise;
}

async function generatePdf(html) {
  let browser;
  try {
    const isLinux = process.platform === 'linux';

    const launchOptions = {
      headless: 'new',
      args: [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        ...(isLinux ? ['--no-sandbox', '--disable-setuid-sandbox', '--no-zygote', '--single-process'] : [])
      ]
    };

    const envExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN;
    if (envExecutablePath) {
      launchOptions.executablePath = envExecutablePath;
    }

    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' }
    });

    await page.close();
    return pdfBuffer;
  } finally {
    if (browser) await browser.close();
  }
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9-_]/g, '-');
}

app.listen(port, () => {
  console.log(`🚀 Serveur de production prêt sur le port ${port}`);
});
