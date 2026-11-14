-- Optional retained-login track, AFTER root 0003 and 0004. Apply before using
-- the admission-aware D1 adapter. No change for single-cookie consumers.
-- One permanent row per trusted gate/kind: window rollover overwrites the row;
-- cleanup must not delete it (including when every browser has expired).
CREATE TABLE retained_admission (
  gate_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'pending')),
  window_start INTEGER NOT NULL CHECK (typeof(window_start) = 'integer' AND window_start BETWEEN 0 AND 9007199254740991),
  used INTEGER NOT NULL CHECK (typeof(used) = 'integer' AND used BETWEEN 1 AND 9007199254740991),
  attempt_id TEXT NOT NULL,
  -- A claimed debit cannot commit without its allocation. An unexpected
  -- zero-row dependent write sets -1 and aborts the entire D1 batch.
  stage INTEGER NOT NULL CHECK (stage IN (0, 1)),
  PRIMARY KEY (gate_id, kind)
);
