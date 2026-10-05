const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const XLSX = require("xlsx");
const { generateMatrix, parseWeight } = require("../scripts/generate-allocation-matrix");
const checkedIn = require("../allocation-matrix.json");
const { resolveAllocationRouting } = require("../allocation-routing");

test("generates both flows by sheet name, independent of sheet order", () => {
  const book = XLSX.readFile(path.join(__dirname, "..", "matrix.xlsx"));
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["unrelated"]]), "UNRELATED");
  book.SheetNames.reverse();
  const generated = generateMatrix(book, "test.xlsx");
  assert.deepEqual(generated.matrix, checkedIn.matrix);
  assert.deepEqual(generated.matrix["19442|INITIATOR (REMEDY)"], { DIMOU_L_DIS: 100 });
  assert.deepEqual(generated.matrix["19442|INITIATOR (PASPORT)"], { DIMOU_L_DIS: 100 });
  assert.equal(generated.subcontractors.DIMOU_L_DIS.name, "DIMOU_L_DIS");
  assert.equal(generated.oteSheetName, "OTE SITE FLOW");
  assert.deepEqual(generated.matrix["OTE_SITE|19|FTTH"], { SAT_PRAXIS_DIS: 100 });
  assert.deepEqual(generated.matrix["OTE_SITE|19|INITIATOR (PASPORT)"], { PSP_ATH_DIS: 100 });
  assert.deepEqual(generated.matrix["OTE_SITE|126|INITIATOR (REMEDY)"], { DIMOU_L_DIS: 100 });
  assert.ok(!Object.keys(generated.matrix).some((key) => key.endsWith("|SUB_CONTRACTOR")));
  for (const weights of Object.values(generated.matrix)) {
    assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 100) < 0.0001);
  }
});

function oteFixture(rows) {
  const book = XLSX.readFile(path.join(__dirname, "..", "matrix.xlsx"));
  const headers = XLSX.utils.sheet_to_json(book.Sheets["OTE SITE FLOW"], { header: 1 })[0];
  book.Sheets["OTE SITE FLOW"] = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  return book;
}

test("OTE uses PasPortCode and CONTRACTOR, preserving text and formatted leading zeros", () => {
  const book = oteFixture([
    ["15125", "  ote-001  ", "Same name", "Region", "OTE_BP", 1, 1, 1, 1, 1, 1, 1, "Parent"],
    ["15125", "0001", "Same name", "Region", "ZERO_BP", 1, 1, 1, 1, 1, 1, 1, "Parent"],
    ["15125", 2, "Other name", "Region", "FORMATTED_BP", 1, 1, 1, 1, 1, 1, 1, "Parent"]
  ]);
  book.Sheets["OTE SITE FLOW"].B4.z = "0000";
  const result = generateMatrix(book, "fixture.xlsx");
  assert.deepEqual(result.matrix["OTE_SITE|OTE-001|FTTH"], { OTE_BP: 100 });
  assert.deepEqual(result.matrix["OTE_SITE|0001|FTTH"], { ZERO_BP: 100 });
  assert.deepEqual(result.matrix["OTE_SITE|0002|FTTH"], { FORMATTED_BP: 100 });
  assert.equal(result.matrix["OTE_SITE|1|FTTH"], undefined);
  assert.equal(result.matrix["OTE_SITE|SAME NAME|FTTH"], undefined);
  assert.equal(result.matrix["OTE_SITE|15125|FTTH"], undefined);
});

test("OTE shares existing percentage validation and normalization without changing postal rows", () => {
  const book = oteFixture([
    ["15125", "OTE-001", "Name", "Region", "A", 0.3, "bad", 0, 0.25, 0, 0, 0, "Parent"],
    ["15125", "OTE-001", "Name", "Region", "B", 0.7, 1, 0, 0.25, 0, 0, 0, "Parent"]
  ]);
  const result = generateMatrix(book, "fixture.xlsx");
  assert.deepEqual(result.matrix["OTE_SITE|OTE-001|INITIATOR (PASPORT)"], { A: 30, B: 70 });
  assert.deepEqual(result.matrix["OTE_SITE|OTE-001|FTTH"], { A: 50, B: 50 });
  assert.equal(result.matrix["OTE_SITE|OTE-001|INITIATOR (REMEDY)"], undefined);
  assert.ok(result.invalidMatrixKeys["OTE_SITE|OTE-001|INITIATOR (REMEDY)"]);
  assert.deepEqual(result.matrix["19442|INITIATOR (REMEDY)"], checkedIn.matrix["19442|INITIATOR (REMEDY)"]);
});

test("missing OTE sheet or code column fails generation instead of using a different sheet or name", () => {
  const book = oteFixture([]);
  book.Sheets["OTE SITE FLOW"].B1.v = "OTE_NAME";
  assert.throws(() => generateMatrix(book, "fixture.xlsx"), /Required column was not found: PasPortCode/);
  book.SheetNames = book.SheetNames.filter((name) => name !== "OTE SITE FLOW");
  assert.throws(() => generateMatrix(book, "fixture.xlsx"), /Required OTE SITE FLOW sheet was not found/);
});

test("text in percentage columns blocks affected keys instead of assuming 100 percent", () => {
  for (const key of ["10223|INITIATOR (PASPORT)", "16450|INITIATOR (PASPORT)"]) {
    assert.equal(checkedIn.matrix[key], undefined);
    assert.ok(checkedIn.invalidMatrixKeys[key].length);
  }
  assert.equal(parseWeight("ICOM_EUVOIA_DIS"), null);
  assert.equal(parseWeight(0.5), 50);
  assert.equal(parseWeight("50%"), 50);
  assert.equal(parseWeight(null), 0);
});

test("DTH and CLOUD inbound skills select their actual Excel columns", () => {
  for (const skill of ["DTH", "CLOUD&SYZEFIXIS"]) {
    const routing = resolveAllocationRouting(["19442", skill], {}, checkedIn.skillColumnMap);
    assert.deepEqual(checkedIn.matrix[routing.matrixKey], { DIMOU_L_DIS: 100 });
  }
});
