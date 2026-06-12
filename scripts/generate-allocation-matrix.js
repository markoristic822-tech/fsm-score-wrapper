const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const CONTRACTOR_CODE_MAP = {
  "SAT PRAXIS LTD": "SAT_PRAXIS",
  "L.DIMOU-M.DASKALAKI O.E-PATRAS": "DIMOU_DASKALAKI_PATRAS",
  ICOM: "ICOM",
  PSP: "PSP",
  "GOUDELOS KONSTANTINOS": "GOUDELOS",
  "TECHRETAIL E.E ATHENS": "TECHRETAIL_ATHENS",
  "TECHRETAIL E.E THESSALONIKI": "TECHRETAIL_THESSALONIKI",
  "SALONIKA NETWORKS \u039c\u039f\u039d .\u0399.\u039a.\u0395": "SALONIKA_NETWORKS",
  "L.DIMOU-M.DASKALAKI O.E-CRETE": "DIMOU_DASKALAKI_CRETE",
  "SEVEN TECH IKE": "SEVEN_TECH",
  "AMTH TECHNICAL SUPPORT OE": "AMTH_TECHNICAL_SUPPORT",
  "TEL.PELOP MIKE NS KALAMATAS": "TEL_PELOP_KALAMATAS",
  "KARALIS D. ANASTASAKIS K OE": "KARALIS_ANASTASAKIS",
  "TELECOMMUNICATIONS TELEGLOBAL OE": "TELEGLOBAL",
  "TSOLAKIDIS CHRISTOS": "TSOLAKIDIS",
  POWERSELL: "POWERSELL",
  "ELECTRIC CITY": "ELECTRIC_CITY",
  FIBERGEN: "FIBERGEN",
  "RODIAKI TELEMATICS S.A.": "RODIAKI_TELEMATICS",
  EUROAXES: "EUROAXES",
  KMDTELECOM: "KMDTELECOM"
};

const DEFAULT_INPUT = path.join(__dirname, "..", "matrix.xlsx");
const DEFAULT_OUTPUT = path.join(
  __dirname,
  "..",
  "allocation-matrix.json"
);

const inputPath = path.resolve(process.argv[2] || DEFAULT_INPUT);
const outputPath = path.resolve(process.argv[3] || DEFAULT_OUTPUT);

function normalizeHeader(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePostalCode(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return String(value).trim();
}

function fallbackContractorCode(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_")
    .replace(/_+/g, "_");
}

function normalizeContractorCode(value) {
  const name = String(value || "").trim();

  return CONTRACTOR_CODE_MAP[name] || fallbackContractorCode(name);
}

function parseWeight(value) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === false
  ) {
    return 0;
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 100;
  }

  if (numericValue <= 0) {
    return 0;
  }

  return numericValue <= 1
    ? numericValue * 100
    : numericValue;
}

function roundWeight(value) {
  return Number(value.toFixed(6));
}

function normalizeWeights(weightsByContractor) {
  const total = Object.values(weightsByContractor)
    .reduce((sum, value) => sum + value, 0);

  if (total <= 0) {
    return weightsByContractor;
  }

  if (Math.abs(total - 100) <= 0.0001) {
    return Object.fromEntries(
      Object.entries(weightsByContractor)
        .map(([contractor, weight]) => [
          contractor,
          roundWeight(weight)
        ])
    );
  }

  return Object.fromEntries(
    Object.entries(weightsByContractor)
      .map(([contractor, weight]) => [
        contractor,
        roundWeight((weight / total) * 100)
      ])
  );
}

function main() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input Excel file not found: ${inputPath}`);
  }

  const workbook = XLSX.readFile(inputPath, {
    cellDates: false
  });

  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: null
  });

  if (rows.length < 2) {
    throw new Error("Matrix sheet does not contain data rows.");
  }

  const headers = rows[0].map(normalizeHeader);
  const postalIndex = headers.findIndex(
    (header) => header.toUpperCase() === "POSTAL"
  );
  const contractorIndex = headers.findIndex(
    (header) => header.toUpperCase() === "CONTRACTORS"
  );

  if (postalIndex === -1) {
    throw new Error("POSTAL column was not found.");
  }

  if (contractorIndex === -1) {
    throw new Error("CONTRACTORS column was not found.");
  }

  const skillIndexes = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header, index }) =>
      header &&
      index > postalIndex &&
      index < contractorIndex &&
      !["CITY", "REGION"].includes(header.toUpperCase())
    );

  const rawMatrix = {};
  const warnings = [];
  const unknownContractors = new Set();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const postalCode = normalizePostalCode(row[postalIndex]);
    const contractorName = String(row[contractorIndex] || "").trim();

    if (!postalCode || !contractorName) {
      continue;
    }

    const contractorCode =
      normalizeContractorCode(contractorName);

    if (!CONTRACTOR_CODE_MAP[contractorName]) {
      unknownContractors.add(contractorName);
    }

    for (const { header: skillName, index } of skillIndexes) {
      const rawValue = row[index];
      const weight = parseWeight(rawValue);

      if (weight <= 0) {
        continue;
      }

      if (!Number.isFinite(Number(rawValue))) {
        warnings.push({
          type: "NON_NUMERIC_WEIGHT",
          row: rowIndex + 1,
          postalCode,
          skillName,
          contractorName,
          contractorCode,
          rawValue,
          assumedWeight: 100
        });
      }

      const matrixKey = `${postalCode}|${skillName}`;

      rawMatrix[matrixKey] = rawMatrix[matrixKey] || {};
      rawMatrix[matrixKey][contractorCode] =
        (rawMatrix[matrixKey][contractorCode] || 0) +
        weight;
    }
  }

  const matrix = {};

  for (const [matrixKey, weights] of Object.entries(rawMatrix)) {
    const total = Object.values(weights)
      .reduce((sum, value) => sum + value, 0);

    if (Math.abs(total - 100) > 0.0001) {
      warnings.push({
        type: "WEIGHTS_TOTAL_NORMALIZED",
        matrixKey,
        total: roundWeight(total),
        rawWeights: Object.fromEntries(
          Object.entries(weights)
            .map(([contractor, weight]) => [
              contractor,
              roundWeight(weight)
            ])
        )
      });
    }

    matrix[matrixKey] = normalizeWeights(weights);
  }

  for (const contractorName of unknownContractors) {
    warnings.push({
      type: "UNKNOWN_CONTRACTOR_CODE_MAP",
      contractorName,
      generatedCode: normalizeContractorCode(contractorName)
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    sourceFile: path.basename(inputPath),
    sheetName,
    skillColumns: skillIndexes.map(({ header }) => header),
    contractorCodeMap: CONTRACTOR_CODE_MAP,
    matrix,
    warnings
  };

  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8"
  );

  console.log(
    `Generated ${Object.keys(matrix).length} allocation matrix entries.`
  );
  console.log(`Output: ${outputPath}`);

  if (warnings.length > 0) {
    console.log(`Warnings: ${warnings.length}`);
    for (const warning of warnings.slice(0, 20)) {
      console.log(JSON.stringify(warning));
    }
  }
}

main();
