-- Grant rotation: re-key a leaked share link without losing its identity.
-- `sessions_invalid_before` is the rotation epoch (epoch seconds), stamped by
-- `gate.rotate({ endSessions: true })`. A grant session whose `iat` predates it
-- is rejected on its next request, so re-keying can also boot whoever is already
-- inside. A plain re-key leaves it NULL and existing sessions untouched.
-- `0009`/`0010` already shipped on `dist`, so this is the next number.
ALTER TABLE grants ADD COLUMN sessions_invalid_before INTEGER;
