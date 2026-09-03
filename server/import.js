const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const Papa = require('papaparse');
const { bad } = require('./validate');
const L = require('./limits');

const router = express.Router();

// Memory storage only: Render's filesystem is ephemeral and we never need the file
// after parsing it. The size cap also protects the 512 MB instance.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: L.MAX_UPLOAD_BYTES, files: 1 },
});

const PREVIEW_ROWS = 10;

// Turns an ExcelJS cell into a plain string. Cells can hold rich text, formula
// results, dates, hyperlinks or numbers, none of which stringify usefully by default.
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();           // hyperlink
    if (Array.isArray(value.richText)) {
      return value.richText.map(part => part.text || '').join('').trim();   // rich text
    }
    if ('result' in value) return cellText(value.result);                   // formula
    if ('hyperlink' in value) return String(value.hyperlink).trim();
  }
  return String(value).trim();
}

// Normalizes a sheet or CSV into a rectangular array of strings, so the client can
// render a preview table without worrying about ragged rows.
function normalizeRows(rows) {
  const trimmed = [];
  for (const row of rows) {
    const cells = row.map(cellText);
    // Drop rows that are entirely empty; spreadsheets are full of these.
    if (cells.some(c => c !== '')) trimmed.push(cells);
    if (trimmed.length >= L.MAX_UPLOAD_ROWS) break;
  }
  const width = trimmed.reduce((max, r) => Math.max(max, r.length), 0);
  return trimmed.map(r => {
    const padded = r.slice(0, width);
    while (padded.length < width) padded.push('');
    return padded;
  });
}

async function parseXlsx(buffer, requestedSheet) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw bad('That file could not be read as an .xlsx spreadsheet. If it is an older .xls file, open it and re-save as .xlsx.');
  }

  const sheetNames = workbook.worksheets.map(ws => ws.name);
  if (sheetNames.length === 0) throw bad('That spreadsheet has no sheets in it.');

  const sheet = (requestedSheet && workbook.getWorksheet(requestedSheet)) || workbook.worksheets[0];

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, row => {
    if (rows.length >= L.MAX_UPLOAD_ROWS) return;
    // row.values is 1-based with a leading hole, so drop index 0.
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows.push(values);
  });

  return { sheetNames, activeSheet: sheet.name, rows: normalizeRows(rows) };
}

function parseCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');   // strip BOM from Excel exports
  const result = Papa.parse(text, { skipEmptyLines: 'greedy' });
  if (result.data.length === 0) throw bad('That file appears to be empty.');
  return { sheetNames: [], activeSheet: null, rows: normalizeRows(result.data) };
}

// A first row is treated as a header when every cell has text and none of them look
// like a sentence-length definition. Only a default; the user can always override it.
function looksLikeHeader(rows) {
  if (rows.length < 2) return false;
  const first = rows[0];
  if (first.some(c => c === '')) return false;
  if (first.some(c => c.length > 60)) return false;

  const headerWords = /^(term|terms|word|words|question|questions|front|key|concept|concepts|definition|definitions|answer|answers|back|meaning|description|notes?)$/i;
  if (first.some(c => headerWords.test(c))) return true;

  // Otherwise guess header if row 1 is markedly shorter than the rows beneath it.
  const avg = arr => arr.reduce((sum, c) => sum + c.length, 0) / (arr.length || 1);
  const bodyAvg = avg(rows.slice(1, 6).flat());
  return bodyAvg > 0 && avg(first) < bodyAvg * 0.6;
}

// Parse only. Nothing is written to the database here; the client previews the rows,
// picks the term and definition columns, then posts the chosen pairs to /api/sets.
router.post('/parse', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw bad('Please choose a file to upload.');

    const name = (req.file.originalname || '').toLowerCase();
    let parsed;

    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      parsed = parseCsv(req.file.buffer);
    } else if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
      parsed = await parseXlsx(req.file.buffer, req.body.sheet);
    } else if (name.endsWith('.xls')) {
      throw bad('Old .xls files are not supported. Open the file and re-save it as .xlsx or .csv.');
    } else {
      throw bad('Please upload a .xlsx or .csv file.');
    }

    if (parsed.rows.length === 0) throw bad('No rows with any content were found in that file.');

    const columnCount = parsed.rows[0].length;
    if (columnCount < 2) {
      throw bad('That file only has one column. A flashcard needs a term and a definition, so two columns are required.');
    }

    res.json({
      sheetNames: parsed.sheetNames,
      activeSheet: parsed.activeSheet,
      columnCount,
      rowCount: parsed.rows.length,
      headerGuess: looksLikeHeader(parsed.rows),
      preview: parsed.rows.slice(0, PREVIEW_ROWS),
      rows: parsed.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, upload };
