'use strict';

(function () {
  const dom = {
    imageInput: document.getElementById('imageInput'),
    parseButton: document.getElementById('parseButton'),
    resetButton: document.getElementById('resetButton'),
    ocrInput: document.getElementById('ocrInput'),
    imageCanvas: document.getElementById('imageCanvas'),
    diagnostics: document.getElementById('imageDiagnostics'),
    entitySummary: document.getElementById('entitySummary'),
    layerSummary: document.getElementById('layerSummary'),
    statusBanner: document.getElementById('statusBanner'),
  };

  const deptCodeMap = {
    '101': 'mechanical engineering',
    '102': 'electronics and communication engineering',
    '103': 'electrical and electronics engineering',
    '104': 'computer science and engineering',
    '105': 'information technology',
    '106': 'electronics and instrumentation engineering',
    '201': 'civil engineering',
    '202': 'chemical engineering',
    '203': 'aeronautical engineering',
    '204': 'biotechnology',
    '205': 'mechatronics',
    '301': 'architecture',
    '302': 'planning',
  };

  const ctx = dom.imageCanvas?.getContext('2d');
  const rawCanvas = document.createElement('canvas');
  const rawCtx = rawCanvas.getContext('2d');
  const state = {
    metrics: null,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    const yearNode = document.getElementById('year');
    if (yearNode) {
      yearNode.textContent = new Date().getFullYear();
    }

    dom.diagnostics.textContent = 'Upload an ID photo to run CLAHE, sharpness, and ELA checks.';
    dom.entitySummary.innerHTML = renderPlaceholderEntities();
    dom.layerSummary.innerHTML = renderPlaceholderLayers();

    dom.imageInput?.addEventListener('change', handleImageUpload);
    dom.parseButton?.addEventListener('click', () => runPipeline(true));
    dom.resetButton?.addEventListener('click', resetApp);
    dom.ocrInput?.addEventListener('input', debounce(() => runPipeline(false), 500));
  }

  function resetApp() {
    if (dom.imageInput) dom.imageInput.value = '';
    if (dom.ocrInput) dom.ocrInput.value = '';
    dom.imageCanvas?.classList.add('hidden');
    dom.diagnostics.textContent = 'Upload an ID photo to run CLAHE, sharpness, and ELA checks.';
    state.metrics = null;
    dom.entitySummary.innerHTML = renderPlaceholderEntities();
    dom.layerSummary.innerHTML = renderPlaceholderLayers();
    updateStatus();
  }

  function renderPlaceholderEntities() {
    return `
      <h4>Detected Fields</h4>
      <p style="color: var(--text-muted); margin: 0;">Paste OCR output to populate Name, Reg No, Dept, Campus, and Issue Date.</p>
    `;
  }

  function renderPlaceholderLayers() {
    return `
      <div class="layer-card">
        <header><strong>Layer diagnostics pending</strong></header>
        <p style="margin: 0.35rem 0 0; color: var(--text-muted);">Provide OCR text (and ideally an image) to evaluate all three security layers.</p>
      </div>
    `;
  }

  function debounce(fn, delay = 300) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(null, args), delay);
    };
  }

  function constrainDimensions(img, maxSide = 720) {
    const { width, height } = img;
    if (width <= maxSide && height <= maxSide) return { width, height };
    if (width > height) {
      return { width: maxSide, height: Math.round((height / width) * maxSide) };
    }
    return { width: Math.round((width / height) * maxSide), height: maxSide };
  }

  async function handleImageUpload(event) {
    const file = event.target?.files?.[0];
    if (!file) {
      state.metrics = null;
      dom.diagnostics.textContent = 'No image selected.';
      dom.imageCanvas?.classList.add('hidden');
      return;
    }

    if (!file.type.startsWith('image/')) {
      dom.diagnostics.textContent = 'Please upload a valid image file.';
      dom.imageCanvas?.classList.add('hidden');
      event.target.value = '';
      return;
    }

    const img = new Image();
    img.onload = async () => {
      const { width, height } = constrainDimensions(img, 720);
      rawCanvas.width = width;
      rawCanvas.height = height;
      rawCtx.drawImage(img, 0, 0, width, height);

      dom.imageCanvas.width = width;
      dom.imageCanvas.height = height;
      const imageData = rawCtx.getImageData(0, 0, width, height);
      const normalized = applyClahe(imageData);
      ctx.putImageData(normalized, 0, 0);
      dom.imageCanvas.classList.remove('hidden');

      try {
        state.metrics = await analyzeImage(rawCanvas);
        renderDiagnostics(state.metrics);
      } catch (error) {
        console.error('Image analysis failed', error);
        dom.diagnostics.textContent = 'Unable to compute sharpness / ELA metrics.';
      }

      runPipeline(false);
    };

    img.onerror = () => {
      dom.diagnostics.textContent = 'Could not load the selected image.';
      dom.imageCanvas?.classList.add('hidden');
    };

    img.src = URL.createObjectURL(file);
  }

  function applyClahe(imageData, clipLimit = 3) {
    const data = imageData.data;
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      histogram[lum]++;
    }

    const pixels = data.length / 4;
    const limit = clipLimit * (pixels / 256);
    let excess = 0;
    for (let i = 0; i < histogram.length; i++) {
      if (histogram[i] > limit) {
        excess += histogram[i] - limit;
        histogram[i] = limit;
      }
    }

    const increment = excess / 256;
    for (let i = 0; i < histogram.length; i++) {
      histogram[i] += increment;
    }

    const cdf = new Array(256).fill(0);
    cdf[0] = histogram[0];
    for (let i = 1; i < 256; i++) {
      cdf[i] = cdf[i - 1] + histogram[i];
    }
    const scale = 255 / (cdf[255] || 1);
    const lut = cdf.map((value) => Math.max(0, Math.min(255, Math.round(value * scale))));

    for (let i = 0; i < data.length; i += 4) {
      const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      const mapped = lut[lum];
      const diff = mapped - lum;
      data[i] = clampChannel(data[i] + diff);
      data[i + 1] = clampChannel(data[i + 1] + diff);
      data[i + 2] = clampChannel(data[i + 2] + diff);
    }
    return imageData;
  }

  function clampChannel(value) {
    return Math.max(0, Math.min(255, value));
  }

  async function analyzeImage(sourceCanvas) {
    const ctxLocal = sourceCanvas.getContext('2d');
    const imageData = ctxLocal.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const sharpness = computeLaplacianVariance(imageData);
    const elaScore = await computeElaScore(sourceCanvas);
    const brightness = computeMeanLuma(imageData);
    return {
      sharpness,
      elaScore,
      brightness,
      width: sourceCanvas.width,
      height: sourceCanvas.height,
    };
  }

  function computeMeanLuma(imageData) {
    const data = imageData.data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / (data.length / 4);
  }

  function computeLaplacianVariance(imageData) {
    const { data, width, height } = imageData;
    const gray = new Float32Array(width * height);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }

    const kernel = [
      0, 1, 0,
      1, -4, 1,
      0, 1, 0,
    ];

    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let idx = y * width + x;
        let acc = 0;
        let k = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            acc += gray[(y + ky) * width + (x + kx)] * kernel[k++];
          }
        }
        sum += acc;
        sumSq += acc * acc;
        count++;
      }
    }

    if (!count) return 0;
    const mean = sum / count;
    return sumSq / count - mean * mean;
  }

  function computeElaScore(sourceCanvas) {
    return new Promise((resolve) => {
      const handleData = (dataUrl) => {
        const isObjectUrl = dataUrl.startsWith('blob:');
        const img = new Image();
        img.onload = () => {
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = sourceCanvas.width;
          tempCanvas.height = sourceCanvas.height;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.drawImage(img, 0, 0, tempCanvas.width, tempCanvas.height);
          const original = sourceCanvas.getContext('2d').getImageData(0, 0, tempCanvas.width, tempCanvas.height).data;
          const recompressed = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height).data;
          let diffSum = 0;
          const totalPixels = original.length / 4;
          for (let i = 0; i < original.length; i += 4) {
            diffSum += Math.abs(original[i] - recompressed[i]);
            diffSum += Math.abs(original[i + 1] - recompressed[i + 1]);
            diffSum += Math.abs(original[i + 2] - recompressed[i + 2]);
          }
          const meanDiff = (diffSum / totalPixels) / 3;
          if (isObjectUrl) URL.revokeObjectURL(dataUrl);
          resolve(meanDiff);
        };
        img.onerror = () => {
          if (isObjectUrl) URL.revokeObjectURL(dataUrl);
          resolve(0);
        };
        img.src = dataUrl;
      };

      if (sourceCanvas.toBlob) {
        sourceCanvas.toBlob((blob) => {
          if (!blob) {
            resolve(0);
            return;
          }
          const url = URL.createObjectURL(blob);
          handleData(url);
        }, 'image/jpeg', 0.75);
      } else {
        handleData(sourceCanvas.toDataURL('image/jpeg', 0.75));
      }
    });
  }

  function renderDiagnostics(metrics) {
    if (!metrics) {
      dom.diagnostics.textContent = 'Upload an ID photo to view diagnostics.';
      return;
    }
    const sharpClass = metrics.sharpness >= 100 ? 'ok' : 'warn';
    const elaClass = metrics.elaScore <= 22 ? 'ok' : 'warn';
    dom.diagnostics.innerHTML = `
      <div><strong>Resolution:</strong> ${metrics.width} × ${metrics.height}px</div>
      <div class="${sharpClass}"><strong>Sharpness:</strong> ${metrics.sharpness.toFixed(1)} (threshold ≥ 100)</div>
      <div class="${elaClass}"><strong>ELA Score:</strong> ${metrics.elaScore.toFixed(1)} (lower is better)</div>
    `;
  }

  function runPipeline(showErrors) {
    const rawText = dom.ocrInput?.value?.trim();
    if (!rawText) {
      if (showErrors) {
        updateStatus(null, 'Paste OCR text to evaluate the ID card.');
      }
      dom.entitySummary.innerHTML = renderPlaceholderEntities();
      dom.layerSummary.innerHTML = renderPlaceholderLayers();
      return;
    }

    const entities = parseEntities(rawText);
    renderEntities(entities);
    const evaluation = evaluateAuthenticity(entities, state.metrics);
    renderLayerSummary(evaluation);
    updateStatus(evaluation);
  }

  function parseEntities(text) {
    const cleaned = text.replace(/\r/g, '');
    const lines = cleaned.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const normalised = cleaned.replace(/\s+/g, ' ').trim();

    const regMatch = cleaned.match(/reg(?:istration)?\s*(?:no|number)?\s*[:\-]?\s*(\d{10})/i) || normalised.match(/\b\d{10}\b/);
    const regNo = regMatch ? regMatch[1] || regMatch[0] : null;

    const issueMatch = cleaned.match(/\b\d{2}[\/-]\d{2}[\/-]\d{4}\b/);
    const issueDate = issueMatch ? issueMatch[0] : null;

    let name = null;
    for (const line of lines) {
      if (/^name/i.test(line)) {
        name = line.replace(/^name\s*[:\-]?/i, '').trim();
        break;
      }
    }
    if (!name) {
      const fallback = lines.find((line) => /^[A-Za-z .']+$/.test(line) && !/(dept|department|reg|issue|campus|college|anna|university)/i.test(line));
      if (fallback) name = fallback.trim();
    }

    let dept = null;
    for (const line of lines) {
      if (/(dept|department)/i.test(line)) {
        const extracted = line.replace(/.*?(dept|department)\s*[:\-]?/i, '').trim();
        if (extracted) {
          dept = extracted;
          break;
        }
      }
    }
    if (!dept) {
      const lower = normalised.toLowerCase();
      const keywords = [
        'computer science and engineering',
        'computer science',
        'cse',
        'ece',
        'eee',
        'civil engineering',
        'mechanical engineering',
        'information technology',
        'it',
        'biotechnology',
        'aeronautical engineering',
        'architecture',
        'chemical engineering',
      ];
      dept = keywords.find((key) => lower.includes(key)) || null;
    }

    let campus = null;
    for (const line of lines) {
      if (/campus/i.test(line)) {
        campus = line.replace(/.*campus\s*[:\-]?/i, '').trim();
        break;
      }
    }
    if (!campus && /anna\s+university/i.test(cleaned)) {
      campus = 'Anna University';
    }

    const college = /anna\s+university/i.test(cleaned) ? 'Anna University' : null;

    return {
      raw: cleaned,
      regNo,
      issueDate,
      name: name || null,
      dept: dept || null,
      campus: campus || null,
      college,
    };
  }

  function evaluateAuthenticity(entities, metrics) {
    const logical = [];
    const visual = [];
    const typography = [];

    logical.push(...evaluateFieldCoverage(entities));

    const regValid = /^\d{10}$/.test(entities.regNo || '');
    logical.push(createCheck('Reg No structure', regValid, 'Must be 4-digit year + 6-digit code'));

    const joinCheck = validateJoinYear(entities.regNo, entities.issueDate);
    logical.push(joinCheck);

    logical.push(compareDeptCode(entities.regNo, entities.dept));

    const campusPresent = /anna\s+university/i.test(`${entities.campus || ''} ${entities.raw || ''}`);
    logical.push(createCheck('Anna University reference', campusPresent, campusPresent ? 'Branding detected' : 'Unable to confirm Anna University mention', campusPresent ? 'info' : 'warn'));

    if (metrics) {
      const sharpPass = metrics.sharpness >= 100;
      visual.push(createCheck('Laplacian sharpness ≥ 100', sharpPass, `Score ${metrics.sharpness.toFixed(1)}`, 'error'));
      const elaPass = metrics.elaScore <= 22;
      visual.push(createCheck('ELA tamper score ≤ 22', elaPass, `Score ${metrics.elaScore.toFixed(1)}`, 'warn'));
    } else {
      visual.push(createCheck('Image diagnostics available', false, 'Upload an ID image to unlock blur & ELA checks', 'warn'));
    }

    typography.push(evaluateFontHeuristics(entities.regNo));

    const flattened = [...logical, ...visual, ...typography];
    const hardFails = flattened.filter((check) => !check.passed && check.severity === 'error').length;
    const warns = flattened.filter((check) => !check.passed && check.severity !== 'error').length;

    let status = 'review';
    if (hardFails === 0 && warns === 0) {
      status = 'authentic';
    } else if (hardFails > 0) {
      status = 'fraud';
    }

    return { status, logical, visual, typography };
  }

  function evaluateFieldCoverage(entities) {
    return [
      validateNameField(entities.name),
      validateDepartmentField(entities.dept),
      validateCampusField(entities.campus),
      validateIssueDateField(entities.issueDate),
    ];
  }

  function validateNameField(name) {
    if (!name) {
      return createCheck('Name field extraction', false, 'Name missing or unreadable', 'warn');
    }
    const trimmed = name.trim();
    const normalized = trimmed.replace(/\s+/g, ' ');
    const looksValid = normalized.length >= 3 && /^[A-Za-z .'-]+$/.test(normalized) && /[A-Za-z]/.test(normalized);
    const message = looksValid ? `Captured "${normalized}"` : `Value "${trimmed}" looks invalid`;
    return createCheck('Name field extraction', looksValid, message, looksValid ? 'info' : 'warn');
  }

  function validateDepartmentField(dept) {
    if (!dept) {
      return createCheck('Department field extraction', false, 'Department missing or unreadable', 'warn');
    }
    const trimmed = dept.trim();
    const normalized = canonicalizeDept(dept);
    const looksValid = Boolean(normalized && normalized.length >= 3);
    const displayValue = trimmed || normalized;
    const message = looksValid ? `Department detected: ${displayValue}` : `Value "${dept}" looks invalid`;
    return createCheck('Department field extraction', looksValid, message, looksValid ? 'info' : 'warn');
  }

  function validateCampusField(campus) {
    if (!campus) {
      return createCheck('Campus field extraction', false, 'Campus missing or unreadable', 'warn');
    }
    const trimmed = campus.trim();
    const looksValid = trimmed.length >= 3 && /[A-Za-z]/.test(trimmed);
    const message = looksValid ? `Campus detected: ${trimmed}` : `Value "${campus}" looks invalid`;
    return createCheck('Campus field extraction', looksValid, message, looksValid ? 'info' : 'warn');
  }

  function validateIssueDateField(issueDate) {
    if (!issueDate) {
      return createCheck('Issue Date extraction', false, 'Issue Date missing or unreadable', 'warn');
    }
    const parsed = parseIssueDate(issueDate);
    if (!parsed) {
      return createCheck('Issue Date extraction', false, 'Issue Date format invalid', 'error');
    }
    if (parsed > new Date()) {
      return createCheck('Issue Date extraction', false, 'Issue date appears to be in the future', 'warn');
    }
    const humanReadable = parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    return createCheck('Issue Date extraction', true, `Captured ${humanReadable}`, 'info');
  }

  function createCheck(label, passed, message, severity = 'error') {
    return { label, passed: Boolean(passed), message, severity };
  }

  function validateJoinYear(regNo, issueDate) {
    if (!regNo) {
      return createCheck('Issue date vs joining year', false, 'Reg No missing', 'warn');
    }
    if (!issueDate) {
      return createCheck('Issue date vs joining year', false, 'Issue Date missing', 'warn');
    }
    const joinYear = parseInt(regNo.slice(0, 4), 10);
    const parsed = parseIssueDate(issueDate);
    if (!parsed) {
      return createCheck('Issue date vs joining year', false, 'Issue Date format invalid', 'error');
    }
    const issueYear = parsed.getFullYear();
    if (issueYear < joinYear) {
      return createCheck('Issue date vs joining year', false, `Issue year ${issueYear} < joining year ${joinYear}`, 'error');
    }
    return createCheck('Issue date vs joining year', true, `Issue ${issueYear} aligns with joining ${joinYear}`, 'info');
  }

  function parseIssueDate(value) {
    const match = value.match(/(\d{2})[\/-](\d{2})[\/-](\d{4})/);
    if (!match) return null;
    const [_, day, month, year] = match;
    const iso = `${year}-${month}-${day}`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function compareDeptCode(regNo, dept) {
    if (!regNo) return createCheck('Dept code cross-check', false, 'Reg No missing', 'warn');
    if (!dept) return createCheck('Dept code cross-check', false, 'Department text missing', 'warn');
    const deptCode = regNo.slice(4, 7);
    const expected = deptCodeMap[deptCode];
    if (!expected) {
      return createCheck('Dept code cross-check', false, `Code ${deptCode} not mapped`, 'warn');
    }
    const normalDept = canonicalizeDept(dept);
    const similarity = stringSimilarity(expected, normalDept);
    const passed = similarity >= 0.72;
    const message = passed ? `Dept matches code ${deptCode}` : `Printed dept ≠ code ${deptCode} (${expected})`;
    return createCheck('Dept code cross-check', passed, message, passed ? 'info' : 'error');
  }

  function canonicalizeDept(value) {
    if (!value) return '';
    let clean = value.toLowerCase();
    clean = clean.replace(/&/g, 'and');
    clean = clean.replace(/[^a-z\s]/g, ' ');
    clean = clean.replace(/\s+/g, ' ').trim();
    const alias = {
      cse: 'computer science and engineering',
      'computer science engineering': 'computer science and engineering',
      'computer science': 'computer science and engineering',
      cs: 'computer science and engineering',
      ece: 'electronics and communication engineering',
      'electronics communication engineering': 'electronics and communication engineering',
      'electronics and communication': 'electronics and communication engineering',
      eee: 'electrical and electronics engineering',
      civil: 'civil engineering',
      mech: 'mechanical engineering',
      mechanical: 'mechanical engineering',
      it: 'information technology',
      biotech: 'biotechnology',
      'bio technology': 'biotechnology',
    };
    return alias[clean] || clean;
  }

  function stringSimilarity(a, b) {
    if (!a || !b) return 0;
    const distance = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length) || 1;
    return 1 - distance / maxLen;
  }

  function levenshtein(a, b) {
    const rows = b.length + 1;
    const cols = a.length + 1;
    const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

    for (let i = 0; i < cols; i++) matrix[0][i] = i;
    for (let j = 0; j < rows; j++) matrix[j][0] = j;

    for (let j = 1; j < rows; j++) {
      for (let i = 1; i < cols; i++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j - 1][i] + 1,
          matrix[j][i - 1] + 1,
          matrix[j - 1][i - 1] + cost,
        );
      }
    }
    return matrix[rows - 1][cols - 1];
  }

  function evaluateFontHeuristics(regNo) {
    if (!regNo) return createCheck('Font / glyph consistency', false, 'Reg No missing', 'warn');
    const hasLetters = /[A-Za-z]/.test(regNo);
    const hasSymbols = /[^0-9]/.test(regNo);
    const repeated = /(\d)\1{3,}/.test(regNo);

    let severity = 'info';
    let message = 'Digits look consistent with standard template.';
    let score = 1;
    if (hasLetters || hasSymbols) {
      severity = 'error';
      message = 'Non-digit glyphs detected in Reg No – possible font tampering.';
      score -= 0.6;
    }
    if (repeated) {
      if (severity === 'info') severity = 'warn';
      message = 'Unusual repeated digits; verify embossing/font weight.';
      score -= 0.2;
    }

    const passed = score >= 0.75 && severity !== 'error';
    return createCheck('Font / glyph consistency', passed, message, severity);
  }

  function renderEntities(entities) {
    const regYear = entities.regNo ? entities.regNo.slice(0, 4) : null;
    const regSuffix = entities.regNo ? entities.regNo.slice(4) : null;
    const deptCode = entities.regNo ? entities.regNo.slice(4, 7) : null;
    const inferredDept = deptCodeMap[deptCode] || null;

    const rows = [
      { label: 'Name', value: entities.name },
      {
        label: 'Registration No',
        value: entities.regNo ? `${entities.regNo} ${regYear && regSuffix ? `(Year ${regYear} + ${regSuffix})` : ''}` : null,
      },
      { label: 'Department', value: entities.dept || inferredDept },
      { label: 'Campus', value: entities.campus },
      { label: 'Issue Date', value: entities.issueDate ? formatDate(entities.issueDate) : null },
      { label: 'University', value: entities.college || 'Anna University (expected)' },
    ];

    const html = [
      '<h4>Detected Fields</h4>',
      '<dl>',
      ...rows.map((row) => `
        <dt>${row.label}</dt>
        <dd>${row.value || '<span style="color: var(--text-muted);">Not found</span>'}</dd>
      `),
      '</dl>',
    ].join('');

    dom.entitySummary.innerHTML = html;
  }

  function formatDate(value) {
    const parsed = parseIssueDate(value);
    if (!parsed) return value || 'Not found';
    return parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function renderLayerSummary(evaluation) {
    if (!evaluation) {
      dom.layerSummary.innerHTML = renderPlaceholderLayers();
      return;
    }
    const layers = [
      { key: 'logical', title: 'Layer 1 · Logical Sanity', data: evaluation.logical },
      { key: 'visual', title: 'Layer 2 · Visual Forensics', data: evaluation.visual },
      { key: 'typography', title: 'Layer 3 · Font Consistency', data: evaluation.typography },
    ];

    const html = layers
      .map((layer) => {
        const failures = layer.data.filter((check) => !check.passed);
        const state = failures.length === 0 ? 'pass' : failures.some((f) => f.severity === 'error') ? 'fail' : 'review';
        return `
          <div class="layer-card ${state}">
            <header>
              <strong>${layer.title}</strong>
              <span>${layer.data.length - failures.length}/${layer.data.length} checks</span>
            </header>
            <ul>
              ${layer.data
                .map((check) => {
                  const statusClass = check.passed ? 'pass' : check.severity === 'warn' ? 'warn' : 'fail';
                  return `<li class="${statusClass}"><strong>${check.label}:</strong> ${check.message}</li>`;
                })
                .join('')}
            </ul>
          </div>
        `;
      })
      .join('');

    dom.layerSummary.innerHTML = html;
  }

  function updateStatus(evaluation, manualMessage) {
    if (!dom.statusBanner) return;
    if (!evaluation) {
      dom.statusBanner.textContent = manualMessage || 'Awaiting input';
      dom.statusBanner.className = 'status-banner status-banner--idle';
      dom.statusBanner.title = '';
      return;
    }
    const copy = {
      authentic: {
        label: 'Likely Authentic',
        detail: 'All layers passed',
      },
      review: {
        label: 'Needs Manual Review',
        detail: 'Warnings detected; please eyeball the card.',
      },
      fraud: {
        label: 'Likely Fraudulent',
        detail: 'One or more critical checks failed.',
      },
    };
    const meta = copy[evaluation.status] || copy.review;
    dom.statusBanner.textContent = meta.label;
    dom.statusBanner.className = `status-banner status-banner--${evaluation.status}`;
    dom.statusBanner.title = meta.detail;
  }
})();
