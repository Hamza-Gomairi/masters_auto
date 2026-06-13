cat << 'EOF' > server.js
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
const logoPath = path.join(__dirname, 'public', 'static', 'fsjest-removebg-preview.png');
const adminDbPath = path.join(__dirname, 'data', 'attestations.json');
const adminUiPath = process.env.ADMIN_UI_PATH || '/admin-7f3c1b9e';

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
  'حقوق الإنسانوالتقاضي الدولي',
  'قانون المنازعات',
  'المهن القانونية والقضائيةوالتحولات الاقتصادية والرقمية',
  'الدراسات العقارية والتوثيق الرقمي',
  'النظام الجمركي ومنازعات الاستثمار',
  'القانون المدني والأعمال والمعاملات الائتمانية',
  'السياسةالجنائية ورصد وتحليل الظاهرة الإجرامية',
  'المنازعاتالمدنيةوالتجارية',
  'القانون المقارn للأعمال',
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
    const cne = String(req.query.cne || req.query.apogee || '').trim();
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

    const eligibility = await mockCheckApogeeEligibility(formData.cne);

    if (eligibility.validatedSemesters < 3) {
      await upsertAdminRecord(formData.cne, {
        status: 'ineligible', created: false, validatedSemesters: eligibility.validatedSemesters, reason: "Moins de 3 semestres"
      }).catch(() => {});
      return res.status(400).json({ message: "Tu n'as pas validé les 3 semestres" });
    }

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

function normalizeFormData(body) {
  return {
    nom: String(body.nom || '').trim(),
    prenom: String(body.prenom || '').trim(),
    cne: String(body.cne || body.apogee || '').trim(),
    telephone: String(body.telephone || '').trim(),
    email: String(body.email || '').trim().toLowerCase(),
    master: String(body.master || '').trim(),
    professeur: String(body.professeur || '').trim(),
    theme: String(body.theme || '').trim()
  };
}

function validateFormData(data) {
  const errors = [];
  const emailPattern = /^[a-zA-Z0-9._%++-]@etu\.uae\.ac\.ma$/;

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

async function mockCheckApogeeEligibility(apogee) {
  const lastDigit = Number(apogee.replace(/\D/g, '').slice(-1));
  const validatedSemesters = Number.isNaN(lastDigit) ? 4 : Math.min(4, lastDigit);
  return { apogee, validatedSemesters, source: 'mock' };
}

async function renderTemplate(data) {
  const template = await fs.readFile(templatePath, 'utf8');
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
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    });

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
EOF
