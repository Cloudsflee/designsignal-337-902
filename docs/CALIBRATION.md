# 337/902 Evidence Calibration

The baseline is `config/exam-evidence.json`, version `zju-idi-2027-v1`. At runtime a canonical SHA-256 covers the complete record; each authoritative URL also has its own URL hash. The three verified sources are the ZJU IDI 2027 notice and the supplied 337/902 PDFs.

337 is modeled as 75 points of research foundations and 75 points of engineering. 902 is modeled as three 50-point parts: critique/reframing, technology/system chain for diverse users, and A3 expression or a technical plan with fallback, weakest link, metrics/data, and ethics.

Calibration is evidence versioning, not prompt tuning by intuition:

1. Save only official notices, official outlines, examiner statements, and authentic past questions with URL, retrieval date, content hash, and access/license status.
2. Add a new evidence version; never mutate the meaning of a published version. Record whether a source supplements or supersedes an earlier source.
3. Extract explicit topic/point changes and record ambiguity. Do not infer future question wording from the outline.
4. Score each daily mapping against the new topic IDs and run the fixture/schema suite.
5. Compare hypotheses with subsequent official/past questions using precision, coverage, calibration error, and documented counterexamples. Retain misses.

Forecast confidence expresses support from today’s selected evidence and historical calibration. Every hypothesis requires linked evidence and counterevidence and must state that it is not certainty.
