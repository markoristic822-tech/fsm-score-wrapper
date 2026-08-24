const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    matrixKey: null,
    count: 1000,
    startCounter: 0,
    availableContractors: null
  };

  for (let index = 2; index < argv.length; index++) {
    const value = argv[index];

    if (value === "--key") {
      args.matrixKey = argv[++index];
    } else if (value === "--count") {
      args.count = Number(argv[++index]);
    } else if (value === "--start") {
      args.startCounter = Number(argv[++index]);
    } else if (value === "--available") {
      args.availableContractors = argv[++index]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return args;
}

function createSmoothWeightedSequence(weights) {
  const entries = Object.entries(weights)
    .map(([contractor, weight]) => ({
      contractor,
      weight: Number(weight) || 0,
      current: 0
    }))
    .filter((entry) => entry.weight > 0);

  if (entries.length === 0) {
    return [];
  }

  if (entries.length === 1) {
    return [entries[0].contractor];
  }

  const totalWeight = entries.reduce(
    (sum, entry) => sum + entry.weight,
    0
  );

  const sequence = [];

  for (let index = 0; index < 100; index++) {
    for (const entry of entries) {
      entry.current += entry.weight;
    }

    entries.sort(
      (first, second) =>
        second.current - first.current
    );

    const selected = entries[0];
    sequence.push(selected.contractor);
    selected.current -= totalWeight;
  }

  return sequence;
}

function selectContractor({
  matrixKey,
  sequence,
  availableContractors,
  counter
}) {
  const sequencePosition =
    counter % sequence.length;
  const preferredContractor =
    sequence[sequencePosition];

  if (
    availableContractors.includes(
      preferredContractor
    )
  ) {
    return {
      selectedContractor:
        preferredContractor,
      preferredContractor,
      fallbackUsed: false,
      reason: "QUOTA_SEQUENCE",
      matrixKey,
      sequencePosition
    };
  }

  return {
    selectedContractor:
      availableContractors[0] || null,
    preferredContractor,
    fallbackUsed:
      availableContractors.length > 0,
    reason:
      availableContractors.length > 0
        ? "QUOTA_FALLBACK_PREFERRED_CONTRACTOR_UNAVAILABLE"
        : "NO_AVAILABLE_CONTRACTOR",
    matrixKey,
    sequencePosition
  };
}

function incrementCount(summary, key) {
  summary[key] = (summary[key] || 0) + 1;
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.matrixKey) {
    console.error(
      "Usage: node scripts/simulate-allocation.js --key 27131|FTTH --count 1000"
    );
    process.exit(1);
  }

  if (
    !Number.isFinite(args.count) ||
    args.count <= 0
  ) {
    console.error("--count must be a positive number");
    process.exit(1);
  }

  if (
    !Number.isFinite(args.startCounter) ||
    args.startCounter < 0
  ) {
    console.error("--start must be zero or a positive number");
    process.exit(1);
  }

  const matrixPath = path.join(
    __dirname,
    "..",
    "allocation-matrix.json"
  );

  const rawConfig = JSON.parse(
    fs.readFileSync(matrixPath, "utf8")
  );
  const matrix =
    rawConfig.matrix || rawConfig;
  const weights = matrix[args.matrixKey];

  if (!weights) {
    console.error(
      `Matrix key not found: ${args.matrixKey}`
    );
    process.exit(1);
  }

  const sequence =
    createSmoothWeightedSequence(weights);
  const availableContractors =
    args.availableContractors ||
    Object.keys(weights);

  const selectedCounts = {};
  const preferredCounts = {};
  let fallbackCount = 0;
  let noAvailableCount = 0;

  for (let index = 0; index < args.count; index++) {
    const result = selectContractor({
      matrixKey: args.matrixKey,
      sequence,
      availableContractors,
      counter:
        args.startCounter + index
    });

    incrementCount(
      preferredCounts,
      result.preferredContractor
    );

    if (result.selectedContractor) {
      incrementCount(
        selectedCounts,
        result.selectedContractor
      );
    }

    if (result.fallbackUsed) {
      fallbackCount += 1;
    }

    if (!result.selectedContractor) {
      noAvailableCount += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        matrixKey: args.matrixKey,
        count: args.count,
        startCounter:
          args.startCounter,
        weights,
        availableContractors,
        selectedCounts,
        preferredCounts,
        fallbackCount,
        noAvailableCount,
        sequenceLength:
          sequence.length
      },
      null,
      2
    )
  );
}

main();
