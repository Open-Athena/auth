-- A link's key kept for staff to copy again (`gate.mint({ keepToken })`), AES-GCM-sealed under a key derived from
-- the gate's secret, bound to the grant id. NULL: not kept (shown once, as before). Apply once.
ALTER TABLE grants ADD COLUMN token_enc TEXT;
