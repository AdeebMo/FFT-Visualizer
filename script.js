const DEFAULT_INPUT_HELP = "Enter exactly 8 or 16 comma-separated samples. Real and complex forms are both supported.";
const READY_INPUT_HELP = "Valid signal detected. Build steps to generate the full FFT teaching trace.";
const TOLERANCE = 1e-9;

const SPEED_DELAYS = {
  1: 1600,
  2: 1050,
  3: 720,
  4: 430,
  5: 240
};

const PRESET_BUILDERS = {
  impulse(size) {
    return Array.from({ length: size }, (_, index) => complex(index === 0 ? 1 : 0, 0));
  },
  "single-tone"(size) {
    return Array.from({ length: size }, (_, index) => complex(normalizeFloat(Math.cos((2 * Math.PI * index) / size)), 0));
  },
  "mixed-frequency"(size) {
    return Array.from({ length: size }, (_, index) => {
      const value =
        Math.cos((2 * Math.PI * index) / size) +
        0.5 * Math.cos((4 * Math.PI * index) / size);
      return complex(normalizeFloat(value), 0);
    });
  },
  "simple-real"(size) {
    const base = [3, 1, 0, -1, 2, 0, 1, -2];
    const values = [];
    while (values.length < size) {
      for (let index = 0; index < base.length && values.length < size; index += 1) {
        values.push(complex(base[index], 0));
      }
    }
    return values;
  },
  random(size) {
    return Array.from({ length: size }, () => complex(Math.floor(Math.random() * 7) - 3, 0));
  }
};

const PRESET_DESCRIPTIONS = {
  impulse: "Impulse Signal loads a single 1 followed by zeros so every output bin should be identical.",
  "single-tone": "Single-Tone Signal samples one cosine wave, which should concentrate energy in a small number of frequency bins.",
  "mixed-frequency": "Mixed-Frequency Signal blends two cosine components so you can see multiple frequencies emerge together.",
  "simple-real": "Simple Real Example keeps the arithmetic readable while still showing cancellation, reinforcement, and sign changes.",
  random: "Random Example uses small integers to stress-test the circuit while keeping the values interpretable."
};

const POLYNOMIAL_PRESETS = {
  "intro-example": {
    label: "Intro Example",
    a: [1, 2, 3],
    b: [2, 1],
    note: "This is the classic small worked example: A(x) = 1 + 2x + 3x^2 and B(x) = 2 + x."
  },
  "larger-example": {
    label: "Larger Example",
    a: [3, 0, 2, 5, 1],
    b: [1, 4, 0, 2],
    note: "This slightly larger example needs more accumulation terms, so the benefit of structured FFT evaluation becomes more visible."
  },
  "scaling-example": {
    label: "Scaling Example",
    a: [1, 2, 3, 4, 5, 6, 7, 8],
    b: [8, 7, 6, 5, 4, 3, 2, 1],
    note: "This example grows to a 16-point FFT, which makes the O(n log n) vs O(n^2) discussion much easier to see."
  }
};

const POLYNOMIAL_DEFAULT_NOTE = "Choose a preset to fill both coefficient lists and compare naive vs FFT automatically.";

const PSEUDOCODE_BLOCKS = [
  {
    key: "bit-reversal",
    title: "Bit-Reversal Permutation",
    lines: [
      "for i from 0 to n - 1",
      "r <- reverse_bits(i, log2(n))",
      "A[r] <- x[i]"
    ]
  },
  {
    key: "iterative",
    title: "Iterative FFT",
    lines: [
      "A <- bit_reverse_copy(x)",
      "for stage from 1 to log2(n)",
      "m <- 2^stage",
      "for k from 0 to n - 1 step m",
      "for j from 0 to m / 2 - 1",
      "apply butterfly(k + j, k + j + m / 2, omega_m^j)"
    ]
  },
  {
    key: "butterfly",
    title: "Butterfly Update",
    lines: [
      "u <- A[top]",
      "t <- w * A[bottom]",
      "A[top] <- u + t",
      "A[bottom] <- u - t"
    ]
  }
];

const appState = {
  rawInput: "",
  selectedSize: 8,
  selectedPreset: null,
  playbackSpeed: 3,
  parsedValues: [],
  inputValid: false,
  previewData: null,
  steps: [],
  currentStepIndex: -1,
  isBuilt: false,
  isPlaying: false,
  playTimer: null,
  comparison: null,
  statusText: "Idle",
  statusTone: "idle",
  polynomial: {
    rawA: "",
    rawB: "",
    selectedPreset: "intro-example",
    result: null,
    statusText: "Waiting",
    statusTone: "idle",
    statusCopy: "Compare the same polynomial product with a nested-loop convolution and an FFT-based method."
  }
};

const dom = {};

function complex(re, im) {
  return {
    re: normalizeFloat(re),
    im: normalizeFloat(im)
  };
}

function cloneComplex(value) {
  return complex(value.re, value.im);
}

function cloneComplexArray(values) {
  return values.map((value) => (value ? cloneComplex(value) : null));
}

function normalizeFloat(value) {
  if (Math.abs(value) < 1e-12) {
    return 0;
  }
  return value;
}

function addComplex(a, b) {
  return complex(a.re + b.re, a.im + b.im);
}

function subtractComplex(a, b) {
  return complex(a.re - b.re, a.im - b.im);
}

function multiplyComplex(a, b) {
  return complex(
    a.re * b.re - a.im * b.im,
    a.re * b.im + a.im * b.re
  );
}

function magnitudeComplex(value) {
  return Math.hypot(value.re, value.im);
}

function twiddleFactor(power, span) {
  const angle = (-2 * Math.PI * power) / span;
  return complex(Math.cos(angle), Math.sin(angle));
}

function complexDifferenceMagnitude(a, b) {
  return magnitudeComplex(subtractComplex(a, b));
}

function formatNumber(value, digits = 3) {
  const normalized = normalizeFloat(value);
  if (Number.isInteger(normalized)) {
    return String(normalized);
  }
  const fixed = normalized.toFixed(digits);
  return fixed.replace(/\.?0+$/, "");
}

function formatTinyNumber(value) {
  const normalized = normalizeFloat(value);
  if (Math.abs(normalized) >= 0.001 || normalized === 0) {
    return formatNumber(normalized, 4);
  }
  return normalized.toExponential(2);
}

function formatImaginary(imaginary, digits = 3) {
  const magnitude = Math.abs(imaginary);
  if (Math.abs(magnitude - 1) < 1e-12) {
    return "i";
  }
  return `${formatNumber(magnitude, digits)}i`;
}

function formatComplex(value, digits = 3) {
  const re = normalizeFloat(value.re);
  const im = normalizeFloat(value.im);

  if (im === 0) {
    return formatNumber(re, digits);
  }

  if (re === 0) {
    return `${im < 0 ? "-" : ""}${formatImaginary(im, digits)}`;
  }

  const sign = im < 0 ? "-" : "+";
  return `${formatNumber(re, digits)} ${sign} ${formatImaginary(im, digits)}`;
}

function formatComplexCompact(value) {
  return formatComplex(value, 2);
}

function formatValuesPreview(values, limit = 4) {
  if (!values || !values.length) {
    return "[]";
  }
  const formatted = values.map((value) => (value ? formatComplexCompact(value) : "--"));
  if (formatted.length <= limit) {
    return `[${formatted.join(", ")}]`;
  }
  const head = formatted.slice(0, limit).join(", ");
  return `[${head}, ...]`;
}

function serializeValues(values) {
  return values.map((value) => formatComplex(value, 3)).join(", ");
}

// Format a real-number list for display in coefficient form.
function formatRealList(values) {
  return `[${values.map((value) => formatNumber(value, 3)).join(", ")}]`;
}

// Remove tiny floating-point noise from a real coefficient.
function cleanRealCoefficient(value) {
  const withoutNoise = normalizeFloat(value);
  const nearestInteger = Math.round(withoutNoise);
  if (Math.abs(withoutNoise - nearestInteger) < 1e-9) {
    return nearestInteger;
  }
  return Number(withoutNoise.toFixed(6));
}

// Build a readable polynomial expression from coefficient form.
function formatPolynomialExpression(coefficients) {
  if (!coefficients.length) {
    return "0";
  }

  const terms = [];
  coefficients.forEach((coefficient, index) => {
    if (coefficient === 0) {
      return;
    }

    const magnitude = Math.abs(coefficient);
    const coefficientText = magnitude === 1 && index > 0 ? "" : formatNumber(magnitude, 3);
    let term = "";

    if (index === 0) {
      term = formatNumber(magnitude, 3);
    } else if (index === 1) {
      term = `${coefficientText}x`;
    } else {
      term = `${coefficientText}x^${index}`;
    }

    if (!terms.length) {
      terms.push(coefficient < 0 ? `-${term}` : term);
    } else {
      terms.push(`${coefficient < 0 ? "-" : "+"} ${term}`);
    }
  });

  return terms.length ? terms.join(" ") : "0";
}

// Parse a comma-separated list of real polynomial coefficients.
function parseRealCoefficientList(rawInput, label) {
  const tokens = rawInput
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");

  if (!tokens.length) {
    return {
      valid: false,
      message: `${label} needs at least one real coefficient.`,
      values: []
    };
  }

  const values = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const parsed = Number(tokens[index]);
    if (!Number.isFinite(parsed)) {
      return {
        valid: false,
        message: `${label} contains "${tokens[index]}", which is not a valid real number.`,
        values: []
      };
    }
    values.push(cleanRealCoefficient(parsed));
  }

  return {
    valid: true,
    message: "",
    values
  };
}

// Convert a real coefficient list into complex samples with zero imaginary parts.
function realCoefficientsToComplex(values) {
  return values.map((value) => complex(value, 0));
}

// Find the next power of two greater than or equal to the requested length.
function nextPowerOfTwo(value) {
  let power = 1;
  while (power < value) {
    power *= 2;
  }
  return power;
}

// Pad a real coefficient list with zeros up to the chosen FFT size.
function padRealCoefficients(values, targetSize) {
  const padded = values.slice();
  while (padded.length < targetSize) {
    padded.push(0);
  }
  return padded;
}

function parseImaginaryCoefficient(text) {
  if (text === "" || text === "+") {
    return 1;
  }
  if (text === "-") {
    return -1;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parseComplexToken(token) {
  const compact = token.replace(/\s+/g, "").toLowerCase();

  if (!compact) {
    return { valid: false, message: "Empty values are not allowed." };
  }

  if (!compact.includes("i")) {
    const real = Number(compact);
    if (!Number.isFinite(real)) {
      return { valid: false, message: `Could not parse "${token}" as a real number.` };
    }
    return { valid: true, value: complex(real, 0) };
  }

  if (!/^[-+0-9.i]+$/.test(compact) || compact.split("i").length - 1 !== 1 || !compact.endsWith("i")) {
    return { valid: false, message: `Could not parse "${token}" as a complex number.` };
  }

  const body = compact.slice(0, -1);
  let splitIndex = -1;

  for (let index = 1; index < body.length; index += 1) {
    if (body[index] === "+" || body[index] === "-") {
      splitIndex = index;
    }
  }

  if (splitIndex === -1) {
    const imaginary = parseImaginaryCoefficient(body);
    if (!Number.isFinite(imaginary)) {
      return { valid: false, message: `Could not parse "${token}" as a pure imaginary value.` };
    }
    return { valid: true, value: complex(0, imaginary) };
  }

  const realPart = Number(body.slice(0, splitIndex));
  const imaginaryPart = parseImaginaryCoefficient(body.slice(splitIndex));

  if (!Number.isFinite(realPart) || !Number.isFinite(imaginaryPart)) {
    return { valid: false, message: `Could not parse "${token}" as a value of the form a+bi.` };
  }

  return { valid: true, value: complex(realPart, imaginaryPart) };
}

function parseComplexList(rawInput, expectedSize) {
  const tokens = rawInput
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");

  if (!tokens.length) {
    return {
      valid: false,
      message: `Enter exactly ${expectedSize} samples before building the FFT trace.`,
      values: []
    };
  }

  if (tokens.length !== expectedSize) {
    return {
      valid: false,
      message: `The current size is n = ${expectedSize}, so you must enter exactly ${expectedSize} samples.`,
      values: []
    };
  }

  const values = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const parsed = parseComplexToken(tokens[index]);
    if (!parsed.valid) {
      return {
        valid: false,
        message: `${parsed.message} Supported forms include a, a+bi, a-bi, bi, and decimals.`,
        values: []
      };
    }
    values.push(parsed.value);
  }

  return { valid: true, message: "", values };
}

function reverseBits(value, width) {
  let reversed = 0;
  for (let bit = 0; bit < width; bit += 1) {
    reversed = (reversed << 1) | ((value >> bit) & 1);
  }
  return reversed;
}

function toBinary(value, width) {
  return value.toString(2).padStart(width, "0");
}

function buildBitReversedCopy(values) {
  const size = values.length;
  const width = Math.log2(size);
  const reordered = new Array(size);
  const mappings = [];
  const sourceOrderByPosition = new Array(size);

  for (let index = 0; index < size; index += 1) {
    const reversedIndex = reverseBits(index, width);
    reordered[reversedIndex] = cloneComplex(values[index]);
    sourceOrderByPosition[reversedIndex] = index;
    mappings.push({
      sourceIndex: index,
      targetIndex: reversedIndex,
      sourceBinary: toBinary(index, width),
      targetBinary: toBinary(reversedIndex, width)
    });
  }

  return {
    values: reordered,
    mappings,
    sourceOrderByPosition
  };
}

function buildStageDefinitions(size) {
  const depth = Math.log2(size);
  const stages = [];
  let butterflyCounter = 0;

  for (let stageIndex = 0; stageIndex < depth; stageIndex += 1) {
    const span = 2 ** (stageIndex + 1);
    const half = span / 2;
    const butterflies = [];

    for (let blockStart = 0; blockStart < size; blockStart += span) {
      for (let offset = 0; offset < half; offset += 1) {
        butterflies.push({
          butterflyIndex: butterflyCounter,
          upper: blockStart + offset,
          lower: blockStart + offset + half,
          twiddlePower: offset,
          span
        });
        butterflyCounter += 1;
      }
    }

    stages.push({
      stageIndex,
      label: `Stage ${stageIndex + 1}`,
      metaLabel: `m = ${span}`,
      span,
      half,
      butterflies
    });
  }

  return stages;
}

function iterativeFft(values) {
  const size = values.length;
  const bitInfo = buildBitReversedCopy(values);
  const working = cloneComplexArray(bitInfo.values);
  const depth = Math.log2(size);

  for (let stageIndex = 0; stageIndex < depth; stageIndex += 1) {
    const span = 2 ** (stageIndex + 1);
    const half = span / 2;

    for (let blockStart = 0; blockStart < size; blockStart += span) {
      for (let offset = 0; offset < half; offset += 1) {
        const upperIndex = blockStart + offset;
        const lowerIndex = upperIndex + half;
        const w = twiddleFactor(offset, span);
        const u = cloneComplex(working[upperIndex]);
        const t = multiplyComplex(w, working[lowerIndex]);
        working[upperIndex] = addComplex(u, t);
        working[lowerIndex] = subtractComplex(u, t);
      }
    }
  }

  return working;
}

function recursiveFft(values) {
  if (values.length === 1) {
    return [cloneComplex(values[0])];
  }

  const even = [];
  const odd = [];
  for (let index = 0; index < values.length; index += 1) {
    if (index % 2 === 0) {
      even.push(values[index]);
    } else {
      odd.push(values[index]);
    }
  }

  const evenFft = recursiveFft(even);
  const oddFft = recursiveFft(odd);
  const output = new Array(values.length);

  for (let k = 0; k < values.length / 2; k += 1) {
    const w = twiddleFactor(k, values.length);
    const t = multiplyComplex(w, oddFft[k]);
    output[k] = addComplex(evenFft[k], t);
    output[k + values.length / 2] = subtractComplex(evenFft[k], t);
  }

  return output;
}

function compareIterativeAndRecursive(values) {
  const iterativeOutput = iterativeFft(values);
  const recursiveOutput = recursiveFft(values);
  let maxError = 0;

  for (let index = 0; index < values.length; index += 1) {
    maxError = Math.max(maxError, complexDifferenceMagnitude(iterativeOutput[index], recursiveOutput[index]));
  }

  return {
    iterativeOutput,
    recursiveOutput,
    maxError,
    tolerance: TOLERANCE,
    matches: maxError <= TOLERANCE
  };
}

// Conjugate a complex value so the inverse FFT can reuse the forward FFT helper.
function conjugateComplex(value) {
  return complex(value.re, -value.im);
}

// Scale a complex value by a real factor.
function scaleComplex(value, scalar) {
  return complex(value.re * scalar, value.im * scalar);
}

// Compute the inverse FFT by conjugating, using the forward FFT, and scaling back down.
function inverseFft(values) {
  const conjugated = values.map((value) => conjugateComplex(value));
  const transformed = iterativeFft(conjugated);
  return transformed.map((value) => scaleComplex(conjugateComplex(value), 1 / values.length));
}

// Multiply two polynomials directly with the classic nested-loop convolution.
function naivePolynomialMultiply(coefficientsA, coefficientsB) {
  const result = new Array(coefficientsA.length + coefficientsB.length - 1).fill(0);

  for (let indexA = 0; indexA < coefficientsA.length; indexA += 1) {
    for (let indexB = 0; indexB < coefficientsB.length; indexB += 1) {
      result[indexA + indexB] += coefficientsA[indexA] * coefficientsB[indexB];
    }
  }

  return result.map((value) => cleanRealCoefficient(value));
}

// Multiply two polynomials by padding, evaluating with FFT, multiplying pointwise, and inverting.
function fftPolynomialMultiply(coefficientsA, coefficientsB) {
  const resultLength = coefficientsA.length + coefficientsB.length - 1;
  const paddedSize = Math.max(8, nextPowerOfTwo(resultLength));
  const paddedA = padRealCoefficients(coefficientsA, paddedSize);
  const paddedB = padRealCoefficients(coefficientsB, paddedSize);
  const fftA = iterativeFft(realCoefficientsToComplex(paddedA));
  const fftB = iterativeFft(realCoefficientsToComplex(paddedB));
  const pointwiseProduct = fftA.map((value, index) => multiplyComplex(value, fftB[index]));
  const inverseValues = inverseFft(pointwiseProduct);
  const result = inverseValues
    .slice(0, resultLength)
    .map((value) => cleanRealCoefficient(value.re));

  return {
    paddedSize,
    paddedA,
    paddedB,
    fftA,
    fftB,
    pointwiseProduct,
    result
  };
}

// Compare the naive and FFT-based polynomial products and collect teaching metadata.
function comparePolynomialMultiplication(coefficientsA, coefficientsB) {
  const naiveResult = naivePolynomialMultiply(coefficientsA, coefficientsB);
  const fftResultData = fftPolynomialMultiply(coefficientsA, coefficientsB);
  const matches =
    naiveResult.length === fftResultData.result.length &&
    naiveResult.every((value, index) => Math.abs(value - fftResultData.result[index]) < 1e-9);

  return {
    coefficientsA,
    coefficientsB,
    naiveResult,
    fftResult: fftResultData.result,
    paddedA: fftResultData.paddedA,
    paddedB: fftResultData.paddedB,
    paddedSize: fftResultData.paddedSize,
    fftA: fftResultData.fftA,
    fftB: fftResultData.fftB,
    pointwiseProduct: fftResultData.pointwiseProduct,
    matches,
    naiveCost: coefficientsA.length * coefficientsB.length,
    fftWorkEstimate:
      3 * fftResultData.paddedSize * Math.log2(fftResultData.paddedSize) + fftResultData.paddedSize,
    visualizerCompatible:
      fftResultData.paddedSize === 8 || fftResultData.paddedSize === 16
  };
}

function cloneStageColumns(columns) {
  return columns.map((column) => (column ? cloneComplexArray(column) : null));
}

function buildCounters(size, stageIndex, butterfliesProcessed, twiddleMultiplications, addSubOperations) {
  const totalStages = size ? Math.log2(size) : 0;
  const totalButterflies = size ? (size / 2) * totalStages : 0;
  return {
    size,
    depth: totalStages,
    totalStages,
    totalButterflies,
    butterfliesProcessed,
    twiddleMultiplications,
    addSubOperations,
    currentStage: stageIndex >= 0 ? stageIndex + 1 : 0,
    estimatedOperationCount: size ? size * totalStages : 0
  };
}

function createStep(base) {
  return {
    index: base.index,
    phase: base.phase,
    kind: base.kind,
    stageIndex: base.stageIndex,
    stageLabel: base.stageLabel,
    butterflyIndex: base.butterflyIndex ?? null,
    pairIndices: base.pairIndices ?? null,
    sourceIndex: base.sourceIndex ?? null,
    targetIndex: base.targetIndex ?? null,
    currentValues: base.currentValues ? cloneComplexArray(base.currentValues) : [],
    workingValues: base.workingValues ? cloneComplexArray(base.workingValues) : [],
    twiddlePower: base.twiddlePower ?? null,
    twiddle: base.twiddle ? cloneComplex(base.twiddle) : null,
    u: base.u ? cloneComplex(base.u) : null,
    lowerValue: base.lowerValue ? cloneComplex(base.lowerValue) : null,
    t: base.t ? cloneComplex(base.t) : null,
    outputUpper: base.outputUpper ? cloneComplex(base.outputUpper) : null,
    outputLower: base.outputLower ? cloneComplex(base.outputLower) : null,
    explanationText: base.explanationText,
    actionText: base.actionText,
    formulaText: base.formulaText,
    pseudocodeBlock: base.pseudocodeBlock,
    pseudocodeLine: base.pseudocodeLine,
    counters: base.counters,
    renderData: {
      size: base.renderData.size,
      depth: base.renderData.depth,
      originalValues: cloneComplexArray(base.renderData.originalValues),
      bitReversedValues: cloneComplexArray(base.renderData.bitReversedValues),
      bitReversalProgress: cloneComplexArray(base.renderData.bitReversalProgress),
      sourceOrderByPosition: base.renderData.sourceOrderByPosition.slice(),
      stageColumns: cloneStageColumns(base.renderData.stageColumns)
    }
  };
}

function buildPreviewData(values) {
  const size = values.length;
  const bitInfo = buildBitReversedCopy(values);
  return {
    size,
    depth: Math.log2(size),
    originalValues: cloneComplexArray(values),
    bitReversedValues: cloneComplexArray(bitInfo.values),
    bitReversalProgress: cloneComplexArray(bitInfo.values),
    sourceOrderByPosition: bitInfo.sourceOrderByPosition.slice(),
    stageColumns: new Array(Math.log2(size)).fill(null)
  };
}

function buildFftSteps(values) {
  const size = values.length;
  const depth = Math.log2(size);
  const originalValues = cloneComplexArray(values);
  const bitInfo = buildBitReversedCopy(values);
  const bitReversedValues = cloneComplexArray(bitInfo.values);
  const stageDefinitions = buildStageDefinitions(size);

  const steps = [];
  const bitProgress = new Array(size).fill(null);
  const stageColumns = new Array(depth).fill(null);
  let stepIndex = 0;
  let butterfliesProcessed = 0;
  let twiddleMultiplications = 0;
  let addSubOperations = 0;

  steps.push(
    createStep({
      index: stepIndex,
      phase: "input",
      kind: "input-summary",
      stageIndex: -1,
      stageLabel: "Input",
      currentValues: originalValues,
      workingValues: originalValues,
      explanationText:
        `Loaded ${size} samples. The iterative FFT will first place them into bit-reversed order so the later butterfly stages can update values in place.`,
      actionText: "Input accepted and ready for bit-reversal.",
      formulaText: "A <- bit_reverse_copy(x)",
      pseudocodeBlock: "iterative",
      pseudocodeLine: 1,
      counters: buildCounters(size, -1, butterfliesProcessed, twiddleMultiplications, addSubOperations),
      renderData: {
        size,
        depth,
        originalValues,
        bitReversedValues,
        bitReversalProgress: bitProgress,
        sourceOrderByPosition: bitInfo.sourceOrderByPosition,
        stageColumns
      }
    })
  );
  stepIndex += 1;

  bitInfo.mappings.forEach((mapping) => {
    bitProgress[mapping.targetIndex] = cloneComplex(originalValues[mapping.sourceIndex]);

    steps.push(
      createStep({
        index: stepIndex,
        phase: "bit-reversal",
        kind: "bit-reversal",
        stageIndex: -1,
        stageLabel: "Bit-Reversal",
        sourceIndex: mapping.sourceIndex,
        targetIndex: mapping.targetIndex,
        currentValues: [originalValues[mapping.sourceIndex]],
        workingValues: bitProgress.filter(Boolean),
        explanationText:
          `Bit-reversing index ${mapping.sourceIndex} (${mapping.sourceBinary}) to ${mapping.targetIndex} (${mapping.targetBinary}), so x[${mapping.sourceIndex}] moves to circuit position ${mapping.targetIndex} before the butterfly layers begin.`,
        actionText: `Place x[${mapping.sourceIndex}] into bit-reversed position ${mapping.targetIndex}.`,
        formulaText: `A[${mapping.targetIndex}] <- x[${mapping.sourceIndex}]`,
        pseudocodeBlock: "bit-reversal",
        pseudocodeLine: 3,
        counters: buildCounters(size, -1, butterfliesProcessed, twiddleMultiplications, addSubOperations),
        renderData: {
          size,
          depth,
          originalValues,
          bitReversedValues,
          bitReversalProgress: bitProgress,
          sourceOrderByPosition: bitInfo.sourceOrderByPosition,
          stageColumns
        }
      })
    );
    stepIndex += 1;
  });

  const working = cloneComplexArray(bitReversedValues);

  stageDefinitions.forEach((stage) => {
    stageColumns[stage.stageIndex] = cloneComplexArray(working);

    steps.push(
      createStep({
        index: stepIndex,
        phase: "stage",
        kind: "stage-start",
        stageIndex: stage.stageIndex,
        stageLabel: stage.label,
        currentValues: working,
        workingValues: working,
        explanationText:
          `${stage.label} begins with block size ${stage.span}. Every butterfly in this layer combines values ${stage.half} positions apart, and all butterflies in the stage can run in parallel.`,
        actionText: `${stage.label} is now highlighted.`,
        formulaText: `m <- ${stage.span}`,
        pseudocodeBlock: "iterative",
        pseudocodeLine: 3,
        counters: buildCounters(size, stage.stageIndex, butterfliesProcessed, twiddleMultiplications, addSubOperations),
        renderData: {
          size,
          depth,
          originalValues,
          bitReversedValues,
          bitReversalProgress: bitReversedValues,
          sourceOrderByPosition: bitInfo.sourceOrderByPosition,
          stageColumns
        }
      })
    );
    stepIndex += 1;

    stage.butterflies.forEach((butterfly) => {
      const upperIndex = butterfly.upper;
      const lowerIndex = butterfly.lower;
      const w = twiddleFactor(butterfly.twiddlePower, butterfly.span);
      const u = cloneComplex(working[upperIndex]);
      const lowerValue = cloneComplex(working[lowerIndex]);
      const t = multiplyComplex(w, lowerValue);
      const outputUpper = addComplex(u, t);
      const outputLower = subtractComplex(u, t);

      const previewWorking = cloneComplexArray(working);
      previewWorking[upperIndex] = outputUpper;
      previewWorking[lowerIndex] = outputLower;
      const previewColumns = cloneStageColumns(stageColumns);
      previewColumns[stage.stageIndex] = previewWorking;

      steps.push(
        createStep({
          index: stepIndex,
          phase: "butterfly",
          kind: "butterfly-compute",
          stageIndex: stage.stageIndex,
          stageLabel: stage.label,
          butterflyIndex: butterfly.butterflyIndex,
          pairIndices: [upperIndex, lowerIndex],
          currentValues: [u, lowerValue],
          workingValues: working,
          twiddlePower: butterfly.twiddlePower,
          twiddle: w,
          u,
          lowerValue,
          t,
          outputUpper,
          outputLower,
          explanationText:
            `Butterfly combines positions ${upperIndex} and ${lowerIndex} with twiddle factor omega_${butterfly.span}^${butterfly.twiddlePower}. Compute t = w * A[${lowerIndex}] = ${formatComplex(t, 3)} while u = A[${upperIndex}] = ${formatComplex(u, 3)}.`,
          actionText: `Compute the butterfly preview for positions ${upperIndex} and ${lowerIndex}.`,
          formulaText: `t = ${formatComplex(w, 3)} * ${formatComplex(lowerValue, 3)} = ${formatComplex(t, 3)}`,
          pseudocodeBlock: "butterfly",
          pseudocodeLine: 2,
          counters: buildCounters(size, stage.stageIndex, butterfliesProcessed, twiddleMultiplications, addSubOperations),
          renderData: {
            size,
            depth,
            originalValues,
            bitReversedValues,
            bitReversalProgress: bitReversedValues,
            sourceOrderByPosition: bitInfo.sourceOrderByPosition,
            stageColumns: previewColumns
          }
        })
      );
      stepIndex += 1;

      working[upperIndex] = outputUpper;
      working[lowerIndex] = outputLower;
      butterfliesProcessed += 1;
      twiddleMultiplications += 1;
      addSubOperations += 2;
      stageColumns[stage.stageIndex] = cloneComplexArray(working);

      steps.push(
        createStep({
          index: stepIndex,
          phase: "butterfly",
          kind: "butterfly-commit",
          stageIndex: stage.stageIndex,
          stageLabel: stage.label,
          butterflyIndex: butterfly.butterflyIndex,
          pairIndices: [upperIndex, lowerIndex],
          currentValues: [u, lowerValue],
          workingValues: working,
          twiddlePower: butterfly.twiddlePower,
          twiddle: w,
          u,
          lowerValue,
          t,
          outputUpper,
          outputLower,
          explanationText:
            `Update the upper output to ${formatComplex(outputUpper, 3)} and the lower output to ${formatComplex(outputLower, 3)}. The circuit now stores the butterfly result back into positions ${upperIndex} and ${lowerIndex}.`,
          actionText: `Commit the butterfly result for positions ${upperIndex} and ${lowerIndex}.`,
          formulaText: `A[${upperIndex}] <- ${formatComplex(outputUpper, 3)}, A[${lowerIndex}] <- ${formatComplex(outputLower, 3)}`,
          pseudocodeBlock: "butterfly",
          pseudocodeLine: 3,
          counters: buildCounters(size, stage.stageIndex, butterfliesProcessed, twiddleMultiplications, addSubOperations),
          renderData: {
            size,
            depth,
            originalValues,
            bitReversedValues,
            bitReversalProgress: bitReversedValues,
            sourceOrderByPosition: bitInfo.sourceOrderByPosition,
            stageColumns
          }
        })
      );
      stepIndex += 1;
    });

    steps.push(
      createStep({
        index: stepIndex,
        phase: "stage",
        kind: "stage-complete",
        stageIndex: stage.stageIndex,
        stageLabel: stage.label,
        currentValues: working,
        workingValues: working,
        explanationText:
          `${stage.label} is complete. Every butterfly in this layer has finished, so the circuit can move one level deeper toward the final frequency outputs.`,
        actionText: `${stage.label} finished.`,
        formulaText: `${stage.label} complete`,
        pseudocodeBlock: "iterative",
        pseudocodeLine: 6,
        counters: buildCounters(size, stage.stageIndex, butterfliesProcessed, twiddleMultiplications, addSubOperations),
        renderData: {
          size,
          depth,
          originalValues,
          bitReversedValues,
          bitReversalProgress: bitReversedValues,
          sourceOrderByPosition: bitInfo.sourceOrderByPosition,
          stageColumns
        }
      })
    );
    stepIndex += 1;
  });

  steps.push(
    createStep({
      index: stepIndex,
      phase: "output",
      kind: "final-output",
      stageIndex: depth - 1,
      stageLabel: "Output",
      currentValues: working,
      workingValues: working,
      explanationText:
        `All ${depth} stages are done. The output bins now hold the FFT of the original signal, and the iterative circuit agrees with the recursive FFT computation.`,
      actionText: "Final FFT output is ready.",
      formulaText: "X[k] is now available for every output bin k",
      pseudocodeBlock: "iterative",
      pseudocodeLine: 6,
      counters: buildCounters(size, depth - 1, butterfliesProcessed, twiddleMultiplications, addSubOperations),
      renderData: {
        size,
        depth,
        originalValues,
        bitReversedValues,
        bitReversalProgress: bitReversedValues,
        sourceOrderByPosition: bitInfo.sourceOrderByPosition,
        stageColumns
      }
    })
  );

  return steps;
}

function cacheDom() {
  dom.customInput = document.getElementById("custom-input");
  dom.inputHelp = document.getElementById("input-help");
  dom.presetNote = document.getElementById("preset-note");
  dom.speedRange = document.getElementById("speed-range");
  dom.speedValue = document.getElementById("speed-value");
  dom.buildButton = document.getElementById("build-btn");
  dom.stepButton = document.getElementById("step-btn");
  dom.playButton = document.getElementById("play-btn");
  dom.pauseButton = document.getElementById("pause-btn");
  dom.resetButton = document.getElementById("reset-btn");
  dom.statusValue = document.getElementById("status-value");
  dom.sessionStepCounter = document.getElementById("session-step-counter");
  dom.diagramStepCounter = document.getElementById("diagram-step-counter");
  dom.inputSizeValue = document.getElementById("input-size-value");
  dom.phaseValue = document.getElementById("phase-value");
  dom.actionTitle = document.getElementById("action-title");
  dom.actionCopy = document.getElementById("action-copy");
  dom.actionPhase = document.getElementById("action-phase");
  dom.actionStage = document.getElementById("action-stage");
  dom.actionIndices = document.getElementById("action-indices");
  dom.actionTwiddle = document.getElementById("action-twiddle");
  dom.bitOriginalRow = document.getElementById("bit-original-row");
  dom.bitReversedRow = document.getElementById("bit-reversed-row");
  dom.bitReversalNote = document.getElementById("bit-reversal-note");
  dom.fftSvg = document.getElementById("fft-svg");
  dom.historyBody = document.getElementById("history-body");
  dom.pseudocodeBody = document.getElementById("pseudocode-body");
  dom.stepExplanation = document.getElementById("step-explanation");
  dom.stepFormula = document.getElementById("step-formula");
  dom.comparisonStatus = document.getElementById("comparison-status");
  dom.comparisonSummary = document.getElementById("comparison-summary");
  dom.comparisonBody = document.getElementById("comparison-body");
  dom.sizeButtons = Array.from(document.querySelectorAll("[data-size]"));
  dom.presetButtons = Array.from(document.querySelectorAll(".preset-button[data-preset]"));
  dom.polyPresetButtons = Array.from(document.querySelectorAll("[data-poly-preset]"));
  dom.counterTotalButterflies = document.getElementById("counter-total-butterflies");
  dom.counterProcessedButterflies = document.getElementById("counter-processed-butterflies");
  dom.counterTotalStages = document.getElementById("counter-total-stages");
  dom.counterCurrentStage = document.getElementById("counter-current-stage");
  dom.counterTwiddleMults = document.getElementById("counter-twiddle-mults");
  dom.counterAddSub = document.getElementById("counter-add-sub");
  dom.counterSize = document.getElementById("counter-size");
  dom.counterDepth = document.getElementById("counter-depth");
  dom.counterEstimate = document.getElementById("counter-estimate");
  dom.polyInputA = document.getElementById("poly-input-a");
  dom.polyInputB = document.getElementById("poly-input-b");
  dom.polyPresetNote = document.getElementById("poly-preset-note");
  dom.polyCompareButton = document.getElementById("poly-compare-btn");
  dom.polyLoadButton = document.getElementById("poly-load-fft-btn");
  dom.polyStatusBadge = document.getElementById("poly-status-badge");
  dom.polySizeBadge = document.getElementById("poly-size-badge");
  dom.polyMatchBadge = document.getElementById("poly-match-badge");
  dom.polyStatusCopy = document.getElementById("poly-status-copy");
  dom.polyLoadNote = document.getElementById("poly-load-note");
  dom.polyPipelineList = document.getElementById("poly-pipeline-list");
  dom.polyFinalResult = document.getElementById("poly-final-result");
  dom.polyExpressionA = document.getElementById("poly-expression-a");
  dom.polyExpressionB = document.getElementById("poly-expression-b");
  dom.polyExpressionResult = document.getElementById("poly-expression-result");
  dom.polyNaiveResult = document.getElementById("poly-naive-result");
  dom.polyNaiveCost = document.getElementById("poly-naive-cost");
  dom.polyFftResult = document.getElementById("poly-fft-result");
  dom.polyFftCost = document.getElementById("poly-fft-cost");
}

// Check whether the optional polynomial multiplication lesson card is present in the current page.
function hasPolynomialUi() {
  return Boolean(
    dom.polyInputA &&
    dom.polyInputB &&
    dom.polyCompareButton &&
    dom.polyLoadButton
  );
}

function setStatus(text, tone) {
  appState.statusText = text;
  appState.statusTone = tone;
}

function clearPlaybackTimer() {
  if (appState.playTimer) {
    clearInterval(appState.playTimer);
    appState.playTimer = null;
  }
  appState.isPlaying = false;
}

function invalidateTrace() {
  clearPlaybackTimer();
  appState.steps = [];
  appState.currentStepIndex = -1;
  appState.isBuilt = false;
}

function getCurrentStep() {
  if (!appState.isBuilt || appState.currentStepIndex < 0 || appState.currentStepIndex >= appState.steps.length) {
    return null;
  }
  return appState.steps[appState.currentStepIndex];
}

function getRenderableData() {
  const currentStep = getCurrentStep();
  if (currentStep) {
    return currentStep.renderData;
  }
  return appState.previewData;
}

function getCurrentCounters() {
  const currentStep = getCurrentStep();
  if (currentStep) {
    return currentStep.counters;
  }
  if (appState.inputValid) {
    return buildCounters(appState.selectedSize, -1, 0, 0, 0);
  }
  return buildCounters(0, -1, 0, 0, 0);
}

function getCurrentPhaseLabel() {
  const currentStep = getCurrentStep();
  if (currentStep) {
    switch (currentStep.phase) {
      case "input":
        return "Input";
      case "bit-reversal":
        return "Bit-Reversal";
      case "stage":
        return "Stage Setup";
      case "butterfly":
        return "Butterfly";
      case "output":
        return "Output";
      default:
        return "Trace";
    }
  }
  if (appState.inputValid) {
    return "Preview";
  }
  return "Waiting";
}

function getStepCountText() {
  const current = getCurrentStep() ? appState.currentStepIndex + 1 : 0;
  return `${current} / ${appState.steps.length}`;
}

function updatePresetSelection() {
  dom.presetButtons.forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.preset === appState.selectedPreset);
  });
}

function updateSizeSelection() {
  dom.sizeButtons.forEach((button) => {
    button.classList.toggle("is-selected", Number(button.dataset.size) === appState.selectedSize);
  });
}

function updateButtons() {
  const hasValidInput = appState.inputValid;
  const hasTrace = appState.isBuilt && appState.steps.length > 0;
  const atEnd = hasTrace && appState.currentStepIndex >= appState.steps.length - 1;

  dom.buildButton.disabled = !hasValidInput || appState.isPlaying;
  dom.stepButton.disabled = !hasTrace || appState.isPlaying || atEnd;
  dom.playButton.disabled = !hasTrace || appState.isPlaying || atEnd;
  dom.pauseButton.disabled = !appState.isPlaying;
  dom.resetButton.disabled = !hasTrace || appState.isPlaying;
}

function renderValidationMessage() {
  dom.inputHelp.textContent = appState.inputValid ? READY_INPUT_HELP : DEFAULT_INPUT_HELP;
  dom.inputHelp.dataset.tone = appState.inputValid ? "success" : "";

  if (!appState.inputValid && appState.rawInput.trim()) {
    const parsed = parseComplexList(appState.rawInput, appState.selectedSize);
    dom.inputHelp.textContent = parsed.message;
    dom.inputHelp.dataset.tone = "error";
  }
}

function renderStatus() {
  dom.statusValue.textContent = appState.statusText;
  dom.statusValue.dataset.state = appState.statusTone;
  dom.sessionStepCounter.textContent = getStepCountText();
  dom.diagramStepCounter.textContent = `${getStepCountText()} steps`;
  dom.inputSizeValue.textContent = String(appState.selectedSize);
  dom.phaseValue.textContent = getCurrentPhaseLabel();
}

function renderActionStrip() {
  const currentStep = getCurrentStep();

  if (currentStep) {
    dom.actionTitle.textContent = currentStep.actionText;
    dom.actionCopy.textContent = currentStep.explanationText;
    dom.actionPhase.textContent = `Phase: ${getCurrentPhaseLabel()}`;
    dom.actionStage.textContent = `Stage: ${currentStep.stageLabel || "--"}`;

    if (currentStep.phase === "bit-reversal") {
      dom.actionIndices.textContent = `Indices: ${currentStep.sourceIndex} -> ${currentStep.targetIndex}`;
      dom.actionTwiddle.textContent = "Twiddle: not used";
      return;
    }

    if (currentStep.pairIndices) {
      dom.actionIndices.textContent = `Indices: ${currentStep.pairIndices[0]}, ${currentStep.pairIndices[1]}`;
    } else {
      dom.actionIndices.textContent = "Indices: --";
    }

    if (currentStep.twiddle) {
      dom.actionTwiddle.textContent = `Twiddle: omega_${2 ** (currentStep.stageIndex + 1)}^${currentStep.twiddlePower} = ${formatComplex(currentStep.twiddle, 2)}`;
    } else {
      dom.actionTwiddle.textContent = "Twiddle: --";
    }
    return;
  }

  if (appState.inputValid) {
    dom.actionTitle.textContent = "Circuit preview ready.";
    dom.actionCopy.textContent = `Build steps to animate the bit-reversal permutation and the ${Math.log2(appState.selectedSize)} butterfly stages.`;
    dom.actionPhase.textContent = "Phase: Preview";
    dom.actionStage.textContent = `Stage: ${Math.log2(appState.selectedSize)} layers`;
    dom.actionIndices.textContent = "Indices: --";
    dom.actionTwiddle.textContent = "Twiddle: preview only";
    return;
  }

  dom.actionTitle.textContent = "Waiting for input.";
  dom.actionCopy.textContent = "Enter a valid power-of-two signal to preview the circuit and build the trace.";
  dom.actionPhase.textContent = "Phase: Idle";
  dom.actionStage.textContent = "Stage: --";
  dom.actionIndices.textContent = "Indices: --";
  dom.actionTwiddle.textContent = "Twiddle: --";
}

function renderCounters() {
  const counters = getCurrentCounters();
  dom.counterTotalButterflies.textContent = String(counters.totalButterflies);
  dom.counterProcessedButterflies.textContent = String(counters.butterfliesProcessed);
  dom.counterTotalStages.textContent = String(counters.totalStages);
  dom.counterCurrentStage.textContent = String(counters.currentStage);
  dom.counterTwiddleMults.textContent = String(counters.twiddleMultiplications);
  dom.counterAddSub.textContent = String(counters.addSubOperations);
  dom.counterSize.textContent = String(counters.size);
  dom.counterDepth.textContent = String(counters.depth);
  dom.counterEstimate.textContent = counters.size ? `~ ${counters.estimatedOperationCount}` : "0";
}

function renderPseudocode() {
  const currentStep = getCurrentStep();
  dom.pseudocodeBody.innerHTML = "";

  PSEUDOCODE_BLOCKS.forEach((block) => {
    const section = document.createElement("section");
    section.className = "code-section";

    const title = document.createElement("h4");
    title.className = "code-section-title";
    title.textContent = block.title;
    section.appendChild(title);

    block.lines.forEach((line, index) => {
      const row = document.createElement("div");
      row.className = "code-line";

      if (currentStep && currentStep.pseudocodeBlock === block.key && currentStep.pseudocodeLine === index + 1) {
        row.classList.add("is-active");
      }

      const lineNo = document.createElement("span");
      lineNo.className = "code-line-number";
      lineNo.textContent = String(index + 1);

      const code = document.createElement("code");
      code.textContent = line;

      row.appendChild(lineNo);
      row.appendChild(code);
      section.appendChild(row);
    });

    dom.pseudocodeBody.appendChild(section);
  });
}

function renderExplanation() {
  const currentStep = getCurrentStep();

  if (currentStep) {
    dom.stepExplanation.textContent = currentStep.explanationText;
    dom.stepFormula.textContent = currentStep.formulaText;
    return;
  }

  if (appState.inputValid) {
    dom.stepExplanation.textContent =
      "Preview mode shows the circuit layout. Build steps to get line-by-line explanations for bit reversal, stage setup, butterfly computation, and result updates.";
    dom.stepFormula.textContent = "Build steps to activate live formulas.";
    return;
  }

  dom.stepExplanation.textContent = "Build steps to begin the guided explanation.";
  dom.stepFormula.textContent = "No butterfly selected yet.";
}

function renderComparison() {
  if (!dom.comparisonStatus || !dom.comparisonSummary || !dom.comparisonBody) {
    return;
  }

  dom.comparisonBody.innerHTML = "";

  if (!appState.comparison) {
    dom.comparisonStatus.textContent = "Waiting for valid input";
    dom.comparisonStatus.className = "comparison-badge comparison-badge-idle";
    dom.comparisonSummary.textContent = "Load a valid signal to compare iterative and recursive FFT outputs.";

    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="4" class="cell-muted">No comparison yet.</td>';
    dom.comparisonBody.appendChild(row);
    return;
  }

  dom.comparisonStatus.textContent = appState.comparison.matches ? "Outputs Match" : "Mismatch Detected";
  dom.comparisonStatus.className = `comparison-badge ${appState.comparison.matches ? "comparison-badge-pass" : "comparison-badge-fail"}`;
  dom.comparisonSummary.textContent =
    `Max difference = ${formatTinyNumber(appState.comparison.maxError)} with tolerance ${formatTinyNumber(appState.comparison.tolerance)}. The iterative circuit is the hardware-friendly staged form of the same recursive FFT.`;

  appState.comparison.iterativeOutput.forEach((iterativeValue, index) => {
    const recursiveValue = appState.comparison.recursiveOutput[index];
    const difference = complexDifferenceMagnitude(iterativeValue, recursiveValue);
    const row = document.createElement("tr");
    if (difference > appState.comparison.tolerance) {
      row.classList.add("is-mismatch");
    }
    row.innerHTML = `
      <td>${index}</td>
      <td>${formatComplex(iterativeValue, 3)}</td>
      <td>${formatComplex(recursiveValue, 3)}</td>
      <td>${formatTinyNumber(difference)}</td>
    `;
    dom.comparisonBody.appendChild(row);
  });
}

function createBitChip(index, meta, stateClass) {
  const wrapper = document.createElement("div");
  wrapper.className = "bit-chip";
  if (stateClass) {
    wrapper.classList.add(stateClass);
  }

  const indexNode = document.createElement("span");
  indexNode.className = "bit-chip-index";
  indexNode.textContent = index;

  const metaNode = document.createElement("span");
  metaNode.className = "bit-chip-meta";
  metaNode.textContent = meta;

  wrapper.appendChild(indexNode);
  wrapper.appendChild(metaNode);
  return wrapper;
}

function renderBitReversalPanel() {
  dom.bitOriginalRow.innerHTML = "";
  dom.bitReversedRow.innerHTML = "";

  if (!appState.inputValid) {
    dom.bitReversalNote.textContent = "Build the trace to step through each reversed-binary mapping.";
    return;
  }

  const renderData = getRenderableData();
  const currentStep = getCurrentStep();
  const width = Math.log2(appState.selectedSize);

  for (let index = 0; index < appState.selectedSize; index += 1) {
    let originalClass = "";
    let reversedClass = "";

    if (currentStep && currentStep.phase === "bit-reversal") {
      if (currentStep.sourceIndex === index) {
        originalClass = "is-active";
      }

      if (currentStep.targetIndex === index) {
        reversedClass = "is-active";
      } else if (renderData.bitReversalProgress[index]) {
        reversedClass = "is-resolved";
      }
    } else if (renderData.bitReversalProgress[index]) {
      reversedClass = "is-resolved";
    }

    dom.bitOriginalRow.appendChild(createBitChip(index, toBinary(index, width), originalClass));
    dom.bitReversedRow.appendChild(
      createBitChip(
        renderData.sourceOrderByPosition[index],
        `p${index} (${toBinary(index, width)})`,
        reversedClass
      )
    );
  }

  if (currentStep && currentStep.phase === "bit-reversal") {
    dom.bitReversalNote.textContent =
      `Current mapping: reverse_bits(${currentStep.sourceIndex}) = ${currentStep.targetIndex}. This places x[${currentStep.sourceIndex}] where the iterative stages expect it.`;
  } else {
    dom.bitReversalNote.textContent =
      "Iterative FFT uses bit-reversal so the fixed stage schedule matches the same even/odd decomposition that the recursive FFT would build naturally.";
  }
}

function createSvgNode(tagName, attributes) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tagName);
  Object.keys(attributes).forEach((key) => {
    if (key === "textContent") {
      node.textContent = attributes[key];
    } else {
      node.setAttribute(key, attributes[key]);
    }
  });
  return node;
}

function renderSvgPlaceholder(message) {
  dom.fftSvg.innerHTML = "";
  dom.fftSvg.setAttribute("viewBox", "0 0 1280 680");

  const background = createSvgNode("rect", {
    x: 0,
    y: 0,
    width: 1280,
    height: 680,
    rx: 22,
    ry: 22,
    fill: "rgba(255,255,255,0.02)"
  });

  const text = createSvgNode("text", {
    x: 640,
    y: 340,
    class: "fft-circuit-note",
    textContent: message
  });

  dom.fftSvg.appendChild(background);
  dom.fftSvg.appendChild(text);
}

function getBitLineState(step, sourceIndex, targetIndex, renderData) {
  if (!step) {
    return renderData.bitReversalProgress[targetIndex] ? "is-resolved" : "";
  }

  if (step.phase === "bit-reversal") {
    if (step.sourceIndex === sourceIndex && step.targetIndex === targetIndex) {
      return "is-active";
    }
    return renderData.bitReversalProgress[targetIndex] ? "is-resolved" : "";
  }

  if (step.phase !== "input") {
    return "is-resolved";
  }

  return "";
}

function isStageResolved(step, stageIndex) {
  if (!step) {
    return false;
  }

  if (step.phase === "output") {
    return true;
  }

  if (step.stageIndex > stageIndex) {
    return true;
  }

  return step.stageIndex === stageIndex && step.kind === "stage-complete";
}

function isCurrentStage(step, stageIndex) {
  return Boolean(step && step.stageIndex === stageIndex && step.phase !== "output");
}

function isActiveButterfly(step, butterfly) {
  return Boolean(
    step &&
    step.pairIndices &&
    step.pairIndices[0] === butterfly.upper &&
    step.pairIndices[1] === butterfly.lower
  );
}

function shouldShowTwiddleLabel(step, stageIndex, butterfly, size) {
  if (!step) {
    return size === 8 && stageIndex === 0;
  }

  if (isActiveButterfly(step, butterfly)) {
    return true;
  }

  return step.stageIndex === stageIndex;
}

function getNodeState(step, columnType, columnStageIndex, rowIndex, renderData) {
  if (!step) {
    return renderData.bitReversalProgress[rowIndex] && columnType === "bit-reversal" ? "is-resolved" : "";
  }

  if (columnType === "bit-reversal" && step.phase === "bit-reversal") {
    if (step.targetIndex === rowIndex) {
      return "is-bit-active";
    }
    if (renderData.bitReversalProgress[rowIndex]) {
      return "is-resolved";
    }
  }

  if (step.phase === "bit-reversal" && columnType === "input" && step.sourceIndex === rowIndex) {
    return "is-bit-active";
  }

  if (step.pairIndices && (step.pairIndices[0] === rowIndex || step.pairIndices[1] === rowIndex)) {
    if (columnType === "stage" && columnStageIndex === step.stageIndex) {
      return "is-active";
    }
    if ((columnType === "bit-reversal" || columnType === "input") && step.phase === "butterfly") {
      return "is-active";
    }
  }

  if (columnType === "stage" && isStageResolved(step, columnStageIndex)) {
    return "is-resolved";
  }

  return "";
}

function renderVisualization() {
  const renderData = getRenderableData();
  const currentStep = getCurrentStep();

  if (!renderData) {
    renderSvgPlaceholder("Network visualization will appear here once a valid input is loaded.");
    return;
  }

  const size = renderData.size;
  const depth = renderData.depth;
  const stageDefinitions = buildStageDefinitions(size);
  const rowSpacing = size === 16 ? 38 : 58;
  const topMargin = 94;
  const leftMargin = 82;
  const columnSpacing = size === 16 ? 188 : 214;
  const pillWidth = size === 16 ? 116 : 126;
  const pillHeight = 28;
  const totalWidth = leftMargin + (depth + 1) * columnSpacing + 240;
  const totalHeight = topMargin + size * rowSpacing + 70;

  dom.fftSvg.innerHTML = "";
  dom.fftSvg.setAttribute("viewBox", `0 0 ${totalWidth} ${totalHeight}`);

  const columns = [
    {
      key: "input",
      label: "Input",
      meta: "x[i]",
      values: renderData.originalValues,
      x: leftMargin + 80
    },
    {
      key: "bit-reversal",
      label: "Bit-Reversed",
      meta: "A[r]",
      values: renderData.bitReversalProgress,
      x: leftMargin + 80 + columnSpacing
    }
  ];

  stageDefinitions.forEach((stage, index) => {
    columns.push({
      key: "stage",
      stageIndex: index,
      label: index === depth - 1 ? `${stage.label} / Output` : stage.label,
      meta: stage.metaLabel,
      values: renderData.stageColumns[index],
      x: leftMargin + 80 + columnSpacing * (index + 2)
    });
  });

  for (let row = 0; row < size; row += 1) {
    const y = topMargin + row * rowSpacing;
    dom.fftSvg.appendChild(
      createSvgNode("rect", {
        class: `fft-row-band${row % 2 === 1 ? " is-odd" : ""}`,
        x: 32,
        y: y - 18,
        width: totalWidth - 64,
        height: rowSpacing - 6,
        rx: 18,
        ry: 18
      })
    );

    dom.fftSvg.appendChild(
      createSvgNode("rect", {
        class: "fft-index-pill-bg",
        x: 16,
        y: y - 14,
        width: 46,
        height: 28,
        rx: 14,
        ry: 14
      })
    );

    dom.fftSvg.appendChild(
      createSvgNode("text", {
        class: "fft-index-pill-text",
        x: 39,
        y: y + 4,
        textContent: `i${row}`
      })
    );
  }

  dom.fftSvg.appendChild(
    createSvgNode("rect", {
      class: "fft-bit-band",
      x: columns[0].x + pillWidth / 2 + 8,
      y: 24,
      width: columnSpacing - pillWidth - 16,
      height: totalHeight - 48,
      rx: 22,
      ry: 22
    })
  );

  stageDefinitions.forEach((stage, stageIndex) => {
    const leftColumn = columns[stageIndex + 1];
    const rightColumn = columns[stageIndex + 2];
    const bandClass = ["fft-stage-band"];
    if (isCurrentStage(currentStep, stageIndex) && currentStep.phase !== "bit-reversal") {
      bandClass.push("is-active");
    } else if (isStageResolved(currentStep, stageIndex)) {
      bandClass.push("is-resolved");
    }

    dom.fftSvg.appendChild(
      createSvgNode("rect", {
        class: bandClass.join(" "),
        x: leftColumn.x + pillWidth / 2 + 8,
        y: 24,
        width: rightColumn.x - leftColumn.x - pillWidth - 16,
        height: totalHeight - 48,
        rx: 22,
        ry: 22
      })
    );
  });

  columns.forEach((column) => {
    dom.fftSvg.appendChild(
      createSvgNode("text", {
        class: "fft-column-label",
        x: column.x,
        y: 34,
        textContent: column.label
      })
    );
    dom.fftSvg.appendChild(
      createSvgNode("text", {
        class: "fft-column-meta",
        x: column.x,
        y: 50,
        textContent: column.meta
      })
    );
  });

  const widthBits = Math.log2(size);
  for (let index = 0; index < size; index += 1) {
    const targetIndex = reverseBits(index, widthBits);
    const y1 = topMargin + index * rowSpacing;
    const y2 = topMargin + targetIndex * rowSpacing;
    dom.fftSvg.appendChild(
      createSvgNode("line", {
        class: `fft-bit-line ${getBitLineState(currentStep, index, targetIndex, renderData)}`.trim(),
        x1: columns[0].x + pillWidth / 2,
        y1,
        x2: columns[1].x - pillWidth / 2,
        y2
      })
    );
  }

  stageDefinitions.forEach((stage, stageIndex) => {
    const leftColumn = columns[stageIndex + 1];
    const rightColumn = columns[stageIndex + 2];
    const xLeft = leftColumn.x + pillWidth / 2;
    const xRight = rightColumn.x - pillWidth / 2;

    stage.butterflies.forEach((butterfly) => {
      const yUpper = topMargin + butterfly.upper * rowSpacing;
      const yLower = topMargin + butterfly.lower * rowSpacing;
      const butterflyGroup = createSvgNode("g", { class: "fft-butterfly" });

      if (isCurrentStage(currentStep, stageIndex)) {
        butterflyGroup.classList.add("is-current-stage");
      }
      if (isStageResolved(currentStep, stageIndex)) {
        butterflyGroup.classList.add("is-resolved");
      }
      if (isActiveButterfly(currentStep, butterfly)) {
        butterflyGroup.classList.add("is-active");
      }

      butterflyGroup.appendChild(
        createSvgNode("line", {
          class: "fft-butterfly-main",
          x1: xLeft,
          y1: yUpper,
          x2: xRight,
          y2: yUpper
        })
      );
      butterflyGroup.appendChild(
        createSvgNode("line", {
          class: "fft-butterfly-main",
          x1: xLeft,
          y1: yLower,
          x2: xRight,
          y2: yLower
        })
      );
      butterflyGroup.appendChild(
        createSvgNode("line", {
          class: "fft-butterfly-cross",
          x1: xLeft,
          y1: yUpper,
          x2: xRight,
          y2: yLower
        })
      );
      butterflyGroup.appendChild(
        createSvgNode("line", {
          class: "fft-butterfly-cross",
          x1: xLeft,
          y1: yLower,
          x2: xRight,
          y2: yUpper
        })
      );

      if (shouldShowTwiddleLabel(currentStep, stageIndex, butterfly, size)) {
        const labelX = (xLeft + xRight) / 2;
        const labelY = (yUpper + yLower) / 2 + 6;
        butterflyGroup.appendChild(
          createSvgNode("rect", {
            class: "fft-twiddle-chip",
            x: labelX - 34,
            y: labelY - 12,
            width: 68,
            height: 20,
            rx: 10,
            ry: 10
          })
        );
        butterflyGroup.appendChild(
          createSvgNode("text", {
            class: "fft-twiddle-text",
            x: labelX,
            y: labelY + 2,
            textContent: `w^${butterfly.twiddlePower}`
          })
        );
      }

      dom.fftSvg.appendChild(butterflyGroup);
    });
  });

  columns.forEach((column) => {
    for (let row = 0; row < size; row += 1) {
      const y = topMargin + row * rowSpacing;
      const value = column.values ? column.values[row] : null;
      const stateClass = getNodeState(currentStep, column.key, column.stageIndex ?? -1, row, renderData);
      const bgClasses = ["fft-value-pill-bg"];
      const textClasses = ["fft-value-pill-text"];

      if (!value) {
        bgClasses.push("is-future");
        textClasses.push("is-placeholder");
      }

      if (stateClass) {
        bgClasses.push(stateClass);
      }

      dom.fftSvg.appendChild(
        createSvgNode("rect", {
          class: bgClasses.join(" "),
          x: column.x - pillWidth / 2,
          y: y - pillHeight / 2,
          width: pillWidth,
          height: pillHeight,
          rx: 14,
          ry: 14
        })
      );

      dom.fftSvg.appendChild(
        createSvgNode("text", {
          class: textClasses.join(" "),
          x: column.x,
          y: y + 4,
          textContent: value ? formatComplexCompact(value) : "--"
        })
      );
    }
  });
}

function describeHistoryIndices(step) {
  if (step.phase === "bit-reversal") {
    return `${step.sourceIndex} -> ${step.targetIndex}`;
  }
  if (step.pairIndices) {
    return `${step.pairIndices[0]}, ${step.pairIndices[1]}`;
  }
  return "--";
}

function describeHistoryTwiddle(step) {
  if (!step.twiddle) {
    return "--";
  }
  const span = 2 ** (step.stageIndex + 1);
  return `omega_${span}^${step.twiddlePower}`;
}

function getHistorySnapshot(step) {
  if (step.phase === "bit-reversal") {
    return formatValuesPreview(step.renderData.bitReversalProgress, 5);
  }
  if (step.workingValues && step.workingValues.length) {
    return formatValuesPreview(step.workingValues, 5);
  }
  return formatValuesPreview(step.renderData.originalValues, 5);
}

function renderHistory() {
  dom.historyBody.innerHTML = "";

  if (!appState.isBuilt || !appState.steps.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="7" class="cell-muted">No trace yet. Build steps to populate the FFT history.</td>';
    dom.historyBody.appendChild(row);
    return;
  }

  appState.steps.forEach((step, index) => {
    const row = document.createElement("tr");
    row.classList.add("history-row-clickable");
    row.dataset.stepIndex = String(index);

    if (index === appState.currentStepIndex) {
      row.classList.add("history-row-current");
    } else if (index < appState.currentStepIndex) {
      row.classList.add("history-row-completed");
    }

    row.innerHTML = `
      <td>${index + 1}</td>
      <td><span class="history-phase-pill">${step.phase}</span></td>
      <td><span class="history-stage-pill">${step.stageLabel || "--"}</span></td>
      <td>${describeHistoryIndices(step)}</td>
      <td><span class="history-twiddle-pill">${describeHistoryTwiddle(step)}</span></td>
      <td>${step.actionText}</td>
      <td><span class="snapshot-code">${getHistorySnapshot(step)}</span></td>
    `;

    dom.historyBody.appendChild(row);
  });
}

// Refresh the polynomial preset button state so the selected example is obvious.
function updatePolynomialPresetSelection() {
  dom.polyPresetButtons.forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.polyPreset === appState.polynomial.selectedPreset);
  });
}

// Show the polynomial multiplication pipeline, results, and current comparison state.
function renderPolynomialSection() {
  if (!hasPolynomialUi()) {
    return;
  }

  const polynomialState = appState.polynomial;
  const result = polynomialState.result;

  dom.polyStatusBadge.textContent = polynomialState.statusText;
  dom.polyStatusBadge.dataset.state = polynomialState.statusTone;
  dom.polyStatusCopy.textContent = polynomialState.statusCopy;
  dom.polyPresetNote.textContent = polynomialState.selectedPreset
    ? POLYNOMIAL_PRESETS[polynomialState.selectedPreset].note
    : POLYNOMIAL_DEFAULT_NOTE;
  dom.polySizeBadge.textContent = result ? String(result.paddedSize) : "--";
  updatePolynomialPresetSelection();

  if (!result) {
    dom.polyMatchBadge.textContent = "Run Comparison";
    dom.polyMatchBadge.className = "comparison-badge comparison-badge-idle";
    dom.polyPipelineList.innerHTML = `
      <li>Start with two coefficient lists in ordinary polynomial form.</li>
      <li>Pad both lists with zeros to a power-of-two length that can hold the full product.</li>
      <li>Evaluate both padded polynomials at roots of unity using FFT.</li>
      <li>Multiply the evaluated values pointwise.</li>
      <li>Use the inverse FFT to return to coefficient form.</li>
    `;
    dom.polyFinalResult.textContent = "Compare an example to see the product coefficients.";
    dom.polyExpressionA.textContent = "--";
    dom.polyExpressionB.textContent = "--";
    dom.polyExpressionResult.textContent = "--";
    dom.polyNaiveResult.textContent = "--";
    dom.polyNaiveCost.textContent = "--";
    dom.polyFftResult.textContent = "--";
    dom.polyFftCost.textContent = "--";
    dom.polyLoadButton.disabled = true;
    dom.polyLoadNote.textContent =
      "The FFT visualizer displays one signal at a time, so this button loads the padded coefficients of Polynomial A into the main circuit workspace.";
    return;
  }

  dom.polyMatchBadge.textContent = result.matches ? "Same Answer" : "Mismatch";
  dom.polyMatchBadge.className = `comparison-badge ${result.matches ? "comparison-badge-pass" : "comparison-badge-fail"}`;

  dom.polyPipelineList.innerHTML = `
    <li>Start with coefficient form: A = ${formatRealList(result.coefficientsA)} and B = ${formatRealList(result.coefficientsB)}.</li>
    <li>Pad both lists with zeros to length ${result.paddedSize}: A = ${formatRealList(result.paddedA)} and B = ${formatRealList(result.paddedB)}.</li>
    <li>Evaluate with FFT at ${result.paddedSize} roots of unity. Sample values: FFT(A) ${formatValuesPreview(result.fftA, 6)} and FFT(B) ${formatValuesPreview(result.fftB, 6)}.</li>
    <li>Multiply the evaluated values pointwise: FFT(A) * FFT(B) ${formatValuesPreview(result.pointwiseProduct, 6)}.</li>
    <li>Apply the inverse FFT and trim back to the needed coefficient length: ${formatRealList(result.fftResult)}.</li>
  `;

  dom.polyFinalResult.textContent = formatRealList(result.fftResult);
  dom.polyExpressionA.textContent = formatPolynomialExpression(result.coefficientsA);
  dom.polyExpressionB.textContent = formatPolynomialExpression(result.coefficientsB);
  dom.polyExpressionResult.textContent = formatPolynomialExpression(result.fftResult);
  dom.polyNaiveResult.textContent = formatRealList(result.naiveResult);
  dom.polyNaiveCost.textContent = `${result.naiveCost} coefficient products (${result.coefficientsA.length} x ${result.coefficientsB.length})`;
  dom.polyFftResult.textContent = formatRealList(result.fftResult);
  dom.polyFftCost.textContent = `About ${Math.round(result.fftWorkEstimate)} structured operations using ${result.paddedSize}-point FFT passes`;
  dom.polyLoadButton.disabled = !result.visualizerCompatible;
  dom.polyLoadNote.textContent = result.visualizerCompatible
    ? "Polynomial A can be loaded directly into the main FFT visualizer because the padded length matches a supported circuit size."
    : "This product uses a padded size outside the current 8/16 teaching circuits, so the load-to-visualizer button is disabled.";
}

function renderAll() {
  renderValidationMessage();
  updatePresetSelection();
  updateSizeSelection();
  dom.speedValue.textContent = `${appState.playbackSpeed}x`;
  renderStatus();
  renderActionStrip();
  renderCounters();
  renderPseudocode();
  renderExplanation();
  renderComparison();
  renderBitReversalPanel();
  renderVisualization();
  renderHistory();
  renderPolynomialSection();
  updateButtons();
}

function refreshInputState() {
  invalidateTrace();
  const parsed = parseComplexList(appState.rawInput, appState.selectedSize);

  if (!parsed.valid) {
    appState.parsedValues = [];
    appState.inputValid = false;
    appState.previewData = null;
    appState.comparison = null;
    setStatus(appState.rawInput.trim() ? "Invalid Input" : "Idle", appState.rawInput.trim() ? "error" : "idle");
    renderAll();
    return;
  }

  appState.parsedValues = parsed.values;
  appState.inputValid = true;
  appState.previewData = buildPreviewData(parsed.values);
  appState.comparison = compareIterativeAndRecursive(parsed.values);
  setStatus("Ready", "ready");
  renderAll();
}

function handleInputChange() {
  appState.rawInput = dom.customInput.value.trim();
  appState.selectedPreset = null;
  dom.presetNote.textContent = "Presets regenerate for the selected size so the circuit always stays power-of-two.";
  refreshInputState();
}

function applyPreset(presetName) {
  const builder = PRESET_BUILDERS[presetName];
  if (!builder) {
    return;
  }

  const values = builder(appState.selectedSize);
  appState.selectedPreset = presetName;
  appState.rawInput = serializeValues(values);
  dom.customInput.value = appState.rawInput;
  dom.presetNote.textContent = PRESET_DESCRIPTIONS[presetName];
  refreshInputState();
}

function handleSizeChange(size) {
  if (size === appState.selectedSize) {
    return;
  }

  appState.selectedSize = size;
  if (!appState.selectedPreset) {
    dom.presetNote.textContent = "Presets regenerate for the selected size so the circuit always stays power-of-two.";
  }

  if (appState.selectedPreset) {
    applyPreset(appState.selectedPreset);
    return;
  }

  setStatus("Waiting for valid input", "idle");
  refreshInputState();
}

// Clear old polynomial results when the user edits the coefficient inputs manually.
function handlePolynomialInputChange() {
  if (!hasPolynomialUi()) {
    return;
  }

  appState.polynomial.rawA = dom.polyInputA.value.trim();
  appState.polynomial.rawB = dom.polyInputB.value.trim();
  appState.polynomial.selectedPreset = null;
  appState.polynomial.result = null;
  appState.polynomial.statusText = "Edited";
  appState.polynomial.statusTone = "paused";
  appState.polynomial.statusCopy = "Coefficient lists changed. Click Compare Naive vs FFT to recompute the product.";
  renderAll();
}

// Load one of the polynomial multiplication presets into both coefficient inputs.
function applyPolynomialPreset(presetName) {
  if (!hasPolynomialUi()) {
    return;
  }

  const preset = POLYNOMIAL_PRESETS[presetName];
  if (!preset) {
    return;
  }

  appState.polynomial.selectedPreset = presetName;
  appState.polynomial.rawA = preset.a.join(", ");
  appState.polynomial.rawB = preset.b.join(", ");
  dom.polyInputA.value = appState.polynomial.rawA;
  dom.polyInputB.value = appState.polynomial.rawB;
  comparePolynomialInputs();
}

// Compare naive and FFT-based polynomial multiplication for the current inputs.
function comparePolynomialInputs() {
  if (!hasPolynomialUi()) {
    return;
  }

  appState.polynomial.rawA = dom.polyInputA.value.trim();
  appState.polynomial.rawB = dom.polyInputB.value.trim();

  const parsedA = parseRealCoefficientList(appState.polynomial.rawA, "Polynomial A");
  const parsedB = parseRealCoefficientList(appState.polynomial.rawB, "Polynomial B");

  if (!parsedA.valid) {
    appState.polynomial.result = null;
    appState.polynomial.statusText = "Invalid Input";
    appState.polynomial.statusTone = "error";
    appState.polynomial.statusCopy = parsedA.message;
    renderAll();
    return;
  }

  if (!parsedB.valid) {
    appState.polynomial.result = null;
    appState.polynomial.statusText = "Invalid Input";
    appState.polynomial.statusTone = "error";
    appState.polynomial.statusCopy = parsedB.message;
    renderAll();
    return;
  }

  appState.polynomial.result = comparePolynomialMultiplication(parsedA.values, parsedB.values);
  appState.polynomial.statusText = "Compared";
  appState.polynomial.statusTone = appState.polynomial.result.matches ? "complete" : "error";
  appState.polynomial.statusCopy = appState.polynomial.result.matches
    ? "Naive convolution and FFT-based multiplication produced the same coefficient result."
    : "The two methods disagreed, which means something needs debugging.";
  renderAll();
}

// Push the padded coefficients of Polynomial A into the main FFT visualizer input.
function loadPolynomialIntoVisualizer() {
  if (!hasPolynomialUi()) {
    return;
  }

  const result = appState.polynomial.result;
  if (!result || !result.visualizerCompatible) {
    return;
  }

  appState.selectedSize = result.paddedSize;
  appState.selectedPreset = null;
  updateSizeSelection();
  appState.rawInput = serializeValues(realCoefficientsToComplex(result.paddedA));
  dom.customInput.value = appState.rawInput;
  dom.presetNote.textContent = "Loaded padded Polynomial A into the FFT visualizer so the circuit view matches the polynomial multiplication lesson.";
  refreshInputState();
}

function buildTrace() {
  if (!appState.inputValid) {
    return;
  }

  clearPlaybackTimer();
  appState.steps = buildFftSteps(appState.parsedValues);
  appState.currentStepIndex = 0;
  appState.isBuilt = true;
  setStatus("Built", "ready");
  renderAll();
}

function moveToStep(stepIndex) {
  if (!appState.isBuilt || !appState.steps.length) {
    return;
  }

  appState.currentStepIndex = Math.max(0, Math.min(stepIndex, appState.steps.length - 1));

  if (appState.currentStepIndex >= appState.steps.length - 1) {
    setStatus("Complete", "complete");
  } else if (!appState.isPlaying) {
    setStatus("Paused", "paused");
  }

  renderAll();
}

function stepForward() {
  if (!appState.isBuilt || appState.currentStepIndex >= appState.steps.length - 1) {
    return;
  }

  appState.currentStepIndex += 1;
  if (appState.currentStepIndex >= appState.steps.length - 1) {
    setStatus("Complete", "complete");
  } else if (!appState.isPlaying) {
    setStatus("Step-by-step", "paused");
  }
  renderAll();
}

function startPlayback() {
  if (!appState.isBuilt || appState.currentStepIndex >= appState.steps.length - 1) {
    return;
  }

  clearPlaybackTimer();
  appState.isPlaying = true;
  setStatus("Playing", "playing");
  renderAll();

  appState.playTimer = setInterval(() => {
    if (appState.currentStepIndex >= appState.steps.length - 1) {
      clearPlaybackTimer();
      setStatus("Complete", "complete");
      renderAll();
      return;
    }
    appState.currentStepIndex += 1;
    if (appState.currentStepIndex >= appState.steps.length - 1) {
      clearPlaybackTimer();
      setStatus("Complete", "complete");
    }
    renderAll();
  }, SPEED_DELAYS[appState.playbackSpeed]);
}

function pausePlayback() {
  if (!appState.isPlaying) {
    return;
  }
  clearPlaybackTimer();
  setStatus("Paused", "paused");
  renderAll();
}

function resetTrace() {
  if (!appState.isBuilt || !appState.steps.length) {
    return;
  }
  clearPlaybackTimer();
  appState.currentStepIndex = 0;
  setStatus("Reset", "paused");
  renderAll();
}

function bindEvents() {
  dom.customInput.addEventListener("input", handleInputChange);
  if (dom.polyInputA) {
    dom.polyInputA.addEventListener("input", handlePolynomialInputChange);
  }
  if (dom.polyInputB) {
    dom.polyInputB.addEventListener("input", handlePolynomialInputChange);
  }

  dom.presetButtons.forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });

  dom.polyPresetButtons.forEach((button) => {
    button.addEventListener("click", () => applyPolynomialPreset(button.dataset.polyPreset));
  });

  dom.sizeButtons.forEach((button) => {
    button.addEventListener("click", () => handleSizeChange(Number(button.dataset.size)));
  });

  dom.speedRange.addEventListener("input", () => {
    appState.playbackSpeed = Number(dom.speedRange.value);
    renderAll();
    if (appState.isPlaying) {
      startPlayback();
    }
  });

  dom.buildButton.addEventListener("click", buildTrace);
  dom.stepButton.addEventListener("click", stepForward);
  dom.playButton.addEventListener("click", startPlayback);
  dom.pauseButton.addEventListener("click", pausePlayback);
  dom.resetButton.addEventListener("click", resetTrace);
  if (dom.polyCompareButton) {
    dom.polyCompareButton.addEventListener("click", comparePolynomialInputs);
  }
  if (dom.polyLoadButton) {
    dom.polyLoadButton.addEventListener("click", loadPolynomialIntoVisualizer);
  }

  dom.historyBody.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-step-index]");
    if (!row) {
      return;
    }
    pausePlayback();
    moveToStep(Number(row.dataset.stepIndex));
  });
}

function initializeApp() {
  cacheDom();
  bindEvents();
  dom.customInput.value = "";
  dom.speedRange.value = String(appState.playbackSpeed);
  setStatus("Idle", "idle");
  if (hasPolynomialUi()) {
    dom.polyInputA.value = "";
    dom.polyInputB.value = "";
    applyPolynomialPreset("intro-example");
  }
  renderAll();
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initializeApp);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    complex,
    parseComplexToken,
    parseComplexList,
    parseRealCoefficientList,
    reverseBits,
    buildBitReversedCopy,
    iterativeFft,
    inverseFft,
    recursiveFft,
    compareIterativeAndRecursive,
    buildFftSteps,
    naivePolynomialMultiply,
    fftPolynomialMultiply,
    comparePolynomialMultiplication
  };
}
