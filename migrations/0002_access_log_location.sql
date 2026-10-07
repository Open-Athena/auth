-- Where a client is, from Cloudflare's `request.cf`, in place of its address
-- (which stays an HMAC in `ip_hash`). Additive: no table rebuild, so a
-- consumer's prod D1 takes it in place.
ALTER TABLE access_log ADD COLUMN city TEXT;
ALTER TABLE access_log ADD COLUMN region TEXT;
ALTER TABLE access_log ADD COLUMN as_org TEXT;  -- network operator (`cf.asOrganization`)
