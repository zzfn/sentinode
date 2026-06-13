CREATE TABLE IF NOT EXISTS backups (
    id         BIGINT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    size_bytes BIGINT,
    r2_key     TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',
    error      TEXT
);
