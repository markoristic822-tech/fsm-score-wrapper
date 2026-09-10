const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const XLSX = require("xlsx");
const { generateMatrix, parseWeight } = require("../scripts/generate-allocation-matrix");
const checkedIn = require("../allocation-matrix.json");
const { resolveAllocationRouting } = require("../allocation-routing");

test("generates the deployed matrix from the postal sheet, ignoring first-sheet order", () => {
  const book = XLSX.readFile(path.join(__dirname, "..", "matrix.xlsx"));
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["unrelated"]]), "OTE SITE FLOW");
  book.SheetNames.reverse();
  const generated = generateMatrix(book, "test.xlsx");
  assert.deepEqual(generated.matrix, checkedIn.matrix);
  assert.deepEqual(generated.matrix["19442|INITIATOR (REMEDY)"], { DIMOU_L_DIS: 100 });
  assert.deepEqual(generated.matrix["19442|INITIATOR (PASPORT)"], { DIMOU_L_DIS: 100 });
  assert.equal(generated.subcontractors.DIMOU_L_DIS.name, "DIMOU_L_DIS");
  assert.ok(!Object.keys(generated.matrix).some((key) => key.endsWith("|SUB_CONTRACTOR")));
  for (const weights of Object.values(generated.matrix)) {
    assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 100) < 0.0001);
  }
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
