-- Scene graph produced from a spatial candidate. Held rows stay stored and are
-- omitted from the student read model. The blob is the small generated GLB.
ALTER TABLE knowledge_spatial_candidates
    ADD COLUMN artifact jsonb
    CHECK (
        artifact IS NULL
        OR (
            jsonb_typeof(artifact) = 'object'
            AND octet_length(artifact::text) <= 65536
        )
    );
