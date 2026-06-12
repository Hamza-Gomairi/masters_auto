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
let adminDbWriteChain = Promise.resolve();

const masters = [
  'Master Droit des Affaires',
  'Master Droit Public et Gouvernance',
  'Master Sciences Économiques et Gestion',
  'Master Management et Stratégie des Organisations',
  'Master Finance, Audit et Contrôle de Gestion',
  'Master Marketing et Commerce International'
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
    const apogee = String(req.query.apogee || '').trim();

    if (!apogee) {
      return res.status(400).json({ message: 'Le Code Apogée est obligatoire.' });
    }

    const record = await getAdminRecord(apogee);

    if (!record) {
      return res.json({
        apogee,
        status: 'not_found',
        created: false,
        createdAt: null,
        lastAttemptAt: null,
        validatedSemesters: null,
        reason: 'Aucune génération détectée depuis l’application.'
      });
    }

    return res.json({ apogee, ...record });
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
      if (formData.apogee) {
        await upsertAdminRecord(formData.apogee, {
          status: 'invalid',
          created: false,
          validatedSemesters: null,
          reason: validationErrors.join(' ')
        });
      }
      return res.status(422).json({ errors: validationErrors });
    }

    const eligibility = await mockCheckApogeeEligibility(formData.apogee);

    if (eligibility.validatedSemesters < 3) {
      await upsertAdminRecord(formData.apogee, {
        status: 'ineligible',
        created: false,
        validatedSemesters: eligibility.validatedSemesters,
        reason: "Tu n'as pas validé les 3 semestres"
      });
      return res.status(400).json({ message: "Tu n'as pas validé les 3 semestres" });
    }

    const html = await renderTemplate(formData);
    const pdf = await generatePdf(html);
    const fileName = `proposition-jury-${safeFileName(formData.apogee)}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await upsertAdminRecord(formData.apogee, {
      status: 'created',
      created: true,
      validatedSemesters: eligibility.validatedSemesters,
      reason: 'PDF généré.'
    });

    return res.send(Buffer.from(pdf));
  } catch (error) {
    console.error('Erreur /api/validate-and-generate:', error);

    const maybeApogee = String(req?.body?.apogee || '').trim();
    if (maybeApogee) {
      await upsertAdminRecord(maybeApogee, {
        status: 'error',
        created: false,
        validatedSemesters: null,
        reason: error?.message || String(error)
      });
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const message = isProduction
      ? 'Erreur interne lors de la génération du PDF.'
      : `Erreur interne lors de la génération du PDF: ${error?.message || String(error)}`;
    return res.status(500).json({ message });
  }
});

async function getAdminRecord(apogee) {
  const db = await readAdminDb();
  return db.records?.[String(apogee)] || null;
}

async function upsertAdminRecord(apogee, patch) {
  const key = String(apogee);
  const now = new Date().toISOString();

  adminDbWriteChain = adminDbWriteChain.then(async () => {
    const db = await readAdminDb();
    db.records = db.records || {};
    const existing = db.records[key] || {};

    const nextId = Number.isFinite(db.nextId) ? Number(db.nextId) : 1;
    const attestationCode = existing.attestationCode ? String(existing.attestationCode) : String(nextId);
    if (!existing.attestationCode) {
      db.nextId = nextId + 1;
    }
    const next = {
      status: patch.status || existing.status || 'unknown',
      created: Boolean(patch.created ?? existing.created ?? false),
      createdAt: existing.createdAt || (patch.created ? now : null),
      lastAttemptAt: now,
      validatedSemesters: patch.validatedSemesters ?? existing.validatedSemesters ?? null,
      reason: patch.reason || existing.reason || null,
      attestationCode
    };

    db.records[key] = next;
    await writeAdminDb(db);
  });

  return adminDbWriteChain;
}

async function readAdminDb() {
  try {
    const raw = await fs.readFile(adminDbPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { records: {}, nextId: 1 };
    if (!parsed.records || typeof parsed.records !== 'object') return { records: {}, nextId: 1 };
    return {
      ...parsed,
      nextId: Number.isFinite(parsed.nextId) ? parsed.nextId : 1
    };
  } catch {
    return { records: {}, nextId: 1 };
  }
}

async function writeAdminDb(db) {
  await fs.mkdir(path.dirname(adminDbPath), { recursive: true });
  const payload = JSON.stringify(db, null, 2);
  await fs.writeFile(adminDbPath, payload, 'utf8');
}

function normalizeFormData(body) {
  return {
    nom: String(body.nom || '').trim(),
    prenom: String(body.prenom || '').trim(),
    apogee: String(body.apogee || '').trim(),
    telephone: String(body.telephone || '').trim(),
    email: String(body.email || '').trim().toLowerCase(),
    master: String(body.master || '').trim(),
    professeur: String(body.professeur || '').trim(),
    theme: String(body.theme || '').trim()
  };
}

function validateFormData(data) {
  const errors = [];
  const emailPattern = /^[a-zA-Z0-9._%+-]+@etu\.uae\.ac\.ma$/;

  if (!data.nom) errors.push('Le nom est obligatoire.');
  if (!data.prenom) errors.push('Le prénom est obligatoire.');
  if (!data.apogee) errors.push('Le Code Apogée est obligatoire.');
  if (!data.telephone) errors.push('Le numéro de téléphone est obligatoire.');
  if (!data.email) errors.push("L'email institutionnel est obligatoire.");
  if (data.email && !emailPattern.test(data.email)) errors.push("L'email doit respecter le format xxx@etu.uae.ac.ma.");
  if (!data.master) errors.push('Le nom du Master est obligatoire.');
  if (data.master && !masters.includes(data.master)) errors.push('Le Master sélectionné est invalide.');
  if (!data.professeur) errors.push('Le nom du Professeur responsable est obligatoire.');
  if (!data.theme) errors.push('Le thème du mémoire est obligatoire.');

  return errors;
}

async function mockCheckApogeeEligibility(apogee) {
  const lastDigit = Number(apogee.replace(/\D/g, '').slice(-1));
  const validatedSemesters = Number.isNaN(lastDigit) ? 0 : Math.min(4, lastDigit);

  return {
    apogee,
    validatedSemesters,
    source: 'mock'
  };
}

async function renderTemplate(data) {
  const template = await fs.readFile(templatePath, 'utf8');
  const fullName = `${data.nom} ${data.prenom}`.trim();
  const today = new Intl.DateTimeFormat('fr-FR').format(new Date());
  const logoDataUrl = await loadLogoDataUrl();
  const attestationCode = data.apogee ? await getOrAssignAttestationCode(data.apogee) : '';

  return template
    .replaceAll('[DYNAMIC_LOGO_SRC]', logoDataUrl)
    .replaceAll('[DYNAMIC_ATTESTATION_CODE]', escapeHtml(attestationCode))
    .replaceAll('[DYNAMIC_DATE]', escapeHtml(today))
    .replaceAll('[DYNAMIC_MASTER_NAME]', escapeHtml(data.master))
    .replaceAll('[DYNAMIC_NOM_PRENOM]', escapeHtml(fullName))
    .replaceAll('[DYNAMIC_APOGEE]', escapeHtml(data.apogee))
    .replaceAll('[DYNAMIC_TELEPHONE]', escapeHtml(data.telephone))
    .replaceAll('[DYNAMIC_EMAIL]', escapeHtml(data.email))
    .replaceAll('[DYNAMIC_PROF_RESPONSABLE]', escapeHtml(data.professeur))
    .replaceAll('[DYNAMIC_THEME]', escapeHtml(data.theme));
}

async function getOrAssignAttestationCode(apogee) {
  const key = String(apogee);
  let code = '';

  adminDbWriteChain = adminDbWriteChain.then(async () => {
    const db = await readAdminDb();
    db.records = db.records || {};

    const existing = db.records[key] || {};
    if (existing.attestationCode) {
      code = String(existing.attestationCode);
      return;
    }

    const nextId = Number.isFinite(db.nextId) ? Number(db.nextId) : 1;
    code = String(nextId);
    db.nextId = nextId + 1;

    db.records[key] = {
      ...existing,
      attestationCode: code
    };

    await writeAdminDb(db);
  });

  await adminDbWriteChain;
  return code;
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

async function resolveChromeExecutablePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // ignore
    }
  }

  return undefined;
}

async function generatePdf(html) {
  const executablePath = await resolveChromeExecutablePath();
  const browser = await puppeteer.launch({
    headless: 'new',
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        right: '15mm',
        bottom: '20mm',
        left: '15mm'
      }
    });
  } finally {
    await browser.close();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9-_]/g, '-');
}

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});
