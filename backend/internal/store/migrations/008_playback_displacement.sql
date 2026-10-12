-- A takeover permanently closes the old media capability. Its correctly bound,
-- currently authorized caller may still learn that deliberate recovery is needed.
ALTER TABLE playback_sessions ADD COLUMN displaced_at timestamptz;
ALTER TABLE playback_sessions ADD CONSTRAINT playback_displacement_is_closed
    CHECK (displaced_at IS NULL OR closed_at IS NOT NULL);
