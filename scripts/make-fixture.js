// Builds test/sample-cards.xlsx: a deliberately messy file, so the import wizard's
// header detection and column picker are exercised rather than a tidy two-column ideal.
const path = require('path');
const ExcelJS = require('exceljs');

async function main() {
  const wb = new ExcelJS.Workbook();

  const ws = wb.addWorksheet('Week 5');
  // Junk column A, real data in B and C, a stray notes column, blank rows in the middle.
  ws.addRow(['#', 'Term', 'Definition', 'Chapter']);
  ws.addRow([1, 'Countertransference', "The clinician's emotional reaction to the client", 4]);
  ws.addRow([2, 'Transference', "The client redirecting feelings onto the clinician", 4]);
  ws.addRow([]);
  ws.addRow([3, 'Mandated reporter', 'Someone legally required to report suspected abuse', 5]);
  ws.addRow([4, 'Strengths perspective', 'Practice framing clients by capacities, not deficits', 5]);
  ws.addRow([5, 'Person-in-environment', 'Viewing behavior in the context of social systems', 6]);
  ws.addRow([]);
  ws.addRow([]);
  ws.addRow([6, 'Motivational interviewing', 'Collaborative method for strengthening motivation to change', 7]);
  ws.addRow([7, 'Cultural humility', 'Ongoing self-reflection about power and bias in practice', 7]);
  ws.getColumn(2).width = 28;
  ws.getColumn(3).width = 60;

  // A second sheet, to exercise the sheet picker.
  const ws2 = wb.addWorksheet('Policy terms');
  ws2.addRow(['Concept', 'Meaning']);
  ws2.addRow(['Means testing', 'Eligibility determined by income and assets']);
  ws2.addRow(['Entitlement program', 'Benefits guaranteed to all who meet criteria']);

  const out = path.join(__dirname, '..', 'test', 'sample-cards.xlsx');
  await wb.xlsx.writeFile(out);
  console.log('Wrote', out);

  // A CSV twin, with no header row, to check the "first row is a header" default.
  const fs = require('fs');
  const csv = [
    'Ecomap,"A visual map of a client\'s relationships and resources"',
    'Genogram,"A family tree annotated with relationships and patterns"',
    'Self-determination,"The client\'s right to make their own choices"',
  ].join('\n');
  const csvOut = path.join(__dirname, '..', 'test', 'sample-cards.csv');
  fs.writeFileSync(csvOut, csv);
  console.log('Wrote', csvOut);
}

main().catch(err => { console.error(err); process.exit(1); });
