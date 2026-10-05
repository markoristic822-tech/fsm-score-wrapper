const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const SKILL_COLUMNS = ["INITIATOR (PASPORT)", "INITIATOR (REMEDY)",
  "FWA", "FTTH", "MESH", "CLOUD & SYZEFXIS", "Subcontractor DTH/SBB"];
const clean = (value) => String(value ?? "").trim();
const header = (value) => clean(value).replace(/\s+/g, " ").toUpperCase();

function column(headers, name) {
  const index = headers.findIndex((item) => header(item) === header(name));
  if (index < 0) throw new Error(`Required column was not found: ${name}`);
  return index;
}

function parseWeight(value) {
  if (value == null || clean(value) === "") return 0;
  const text = clean(value);
  const percent = text.endsWith("%");
  const number = Number(percent ? text.slice(0, -1).trim() : value);
  if (!Number.isFinite(number) || number < 0 || typeof value === "boolean") return null;
  return percent || number > 1 ? number : number * 100;
}

function generateMatrix(book, sourceFile) {
  const matrix = {};
  const subcontractors = {};
  const warnings = [];
  const invalidMatrixKeys = {};

  function appendFlow(expectedSheetName, keyColumn, subcontractorColumn, prefix = "") {
    const sheetName = book.SheetNames.find((name) => header(name) === expectedSheetName);
    if (!sheetName) throw new Error(`Required ${expectedSheetName} sheet was not found`);
    const sheet = book.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    const headers = rows[0] || [];
    const keyIndex = column(headers, keyColumn);
    const subIndex = column(headers, subcontractorColumn);
    const parentIndex = column(headers, "CONTRACTORS");
    const skills = SKILL_COLUMNS.map((name) => ({ name, index: column(headers, name) }));
    for (let index = 1; index < rows.length; index++) {
      const row = rows[index];
      // Read OTE codes as displayed strings, preserving Excel zero-padding.
      const cell = sheet[XLSX.utils.encode_cell({ r: index, c: keyIndex })];
      const area = prefix ? clean(cell ? XLSX.utils.format_cell(cell) : "").toUpperCase() : clean(row[keyIndex]);
      if (!area) continue;
      if (!prefix && !/^\d{5}$/.test(area)) throw new Error(`Invalid postal code at row ${index + 1}`);
      const code = clean(row[subIndex]);
      if (!code) throw new Error(`${subcontractorColumn} is missing at row ${index + 1} in ${sheetName.trim()}`);
      subcontractors[code] ||= { code, name: code, contractorName: clean(row[parentIndex]) };
      for (const { name, index: skillIndex } of skills) {
        const key = `${prefix}${area}|${name}`;
        const weight = parseWeight(row[skillIndex]);
        if (weight === null) {
          const warning = { type: "INVALID_WEIGHT", row: index + 1, matrixKey: key,
            subcontractor: code, rawValue: row[skillIndex] };
          warnings.push(warning);
          (invalidMatrixKeys[key] ||= []).push(warning);
          continue;
        }
        if (weight <= 0) continue;
        matrix[key] ||= {};
        matrix[key][code] = (matrix[key][code] || 0) + weight;
      }
    }
    return sheetName.trim();
  }

  const sheetName = appendFlow("POSTAL CODE FLOW", "POSTAL", "SUB_CONTRACTOR");
  const oteSheetName = appendFlow("OTE SITE FLOW", "PasPortCode", "CONTRACTOR", "OTE_SITE|");

  // Invalid cells block their whole key instead of changing the other shares.
  for (const key of Object.keys(invalidMatrixKeys)) delete matrix[key];
  for (const [key, weights] of Object.entries(matrix)) {
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    if (Math.abs(total - 100) > 0.0001) warnings.push({
      type: "WEIGHTS_TOTAL_NORMALIZED", matrixKey: key, total, rawWeights: { ...weights }
    });
    for (const code of Object.keys(weights)) {
      weights[code] = Number((weights[code] / total * 100).toFixed(6));
    }
  }

  return {
    generatedAt: new Date().toISOString(), sourceFile, sheetName, oteSheetName,
    skillColumns: SKILL_COLUMNS,
    skillColumnMap: { "CLOUD&SYZEFIXIS": "CLOUD & SYZEFXIS", DTH: "Subcontractor DTH/SBB" },
    contractorCodeMap: Object.fromEntries(Object.keys(subcontractors).map((code) => [code, code])),
    subcontractors, matrix, invalidMatrixKeys, warnings
  };
}

function main() {
  const input = path.resolve(process.argv[2] || path.join(__dirname, "..", "matrix.xlsx"));
  const output = path.resolve(process.argv[3] || path.join(__dirname, "..", "allocation-matrix.json"));
  const result = generateMatrix(XLSX.readFile(input), process.argv[4] || path.basename(input));
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ entries: Object.keys(result.matrix).length,
    subcontractors: Object.keys(result.subcontractors).length,
    invalidKeys: Object.keys(result.invalidMatrixKeys), warnings: result.warnings.length }));
}

if (require.main === module) main();
module.exports = { generateMatrix, parseWeight };
