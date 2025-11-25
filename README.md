# IRIZSCANNER

Interactive blueprint + prototype UI for detecting counterfeit Anna University ID cards. The page bundles:

- **Capture conditioning:** CLAHE-based glare reduction plus Laplacian sharpness gate (score ≥ 100) before OCR.
- **Entity parsing:** Regex + LayoutLM-style cues to map PaddleOCR text to Name, Reg No (year + 6 digits), Dept, Campus, Issue Date, and University name.
- **Fraud analytics:** 3-layer logic (joining year checks, ELA tamper score, font consistency heuristics) tailored to Anna University formatting rules.

## Solution architecture recap

| Step | Model(s) | Purpose |
| --- | --- | --- |
| A · Card Detection & Warping | YOLOv8-OBB + Homography | Isolates the ID, removes skew through a perspective warp, feeds a normalized tensor downstream. |
| B · Text Extraction | PaddleOCR (PP-OCRv4) | Scene-text recognition that survives glare/background noise and stays lightweight for mobile devices. |
| C · Entity Parsing | LayoutLMv3 + Regex/Fuzzy logic | Maps the OCR output to structured fields such as Name, Reg No, Dept, Campus, Issue Date, and Anna University branding. |

Fraud detection layers implemented in the UI:

1. **Logical sanity:**
   - Reg No must match `^(\d{4})(\d{6})$` (joining year + 6 digits).
   - Issue Date year must be ≥ joining year.
   - Department string must align with the embedded 3-digit dept code.
   - Anna University mention must be detected somewhere in the OCR text.
2. **Visual forensics:**
   - Laplacian variance < 100 ⇒ capture rejected as blurry.
   - Error Level Analysis (ELA) score > 22 ⇒ tamper warning.
3. **Font consistency:**
   - Placeholder Siamese check implemented via glyph heuristics (flags non-digit characters or suspicious repetition). In production this would point to a Siamese CNN trained on gold-standard Reg No crops.

## Running locally

No tooling is required—everything is plain HTML/CSS/JS.

```bash
# From the repo root
open index.html                        # macOS
xdg-open index.html                    # Linux
# or use any Live Server / static host
```

1. Upload an ID-card image (or any sample photo) to run the CLAHE + diagnostics pipeline.
2. Paste PaddleOCR (or manually typed) text into the textarea.
3. Click **Run Fraud Check** (or just start typing) to see entity extraction and layered verdicts.

## Repository structure

```
.
├── app.js          # Front-end logic: CLAHE, Laplacian/ELA metrics, entity parsing, fraud checks
├── index.html      # UI markup + documentation sections
├── styles.css      # Glassmorphism-inspired styling
├── .gitignore      # Standard ignores for web projects
└── README.md
```

## Sample OCR snippet

```
ANNA UNIVERSITY
Name: PRIYA SURESH
Reg No: 2023104001
Dept: COMPUTER SCIENCE AND ENGINEERING
Campus: CHENNAI MAIN CAMPUS
Issue Date: 15-08-2023
```

Use the snippet above (or your own) to see how the logical rules, ELA score, and font heuristics interact inside the demo.
