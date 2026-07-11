-- Farmer home settlement (public). Free text, e.g. "Варна". Surfaced on the
-- marketplace so shoppers see where a producer is based / filter by delivery area.
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS city text;
