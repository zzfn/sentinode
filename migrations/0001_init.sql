CREATE TABLE IF NOT EXISTS nodes (
    hostname  TEXT PRIMARY KEY,
    ip        TEXT NOT NULL,
    os        TEXT NOT NULL,
    arch      TEXT NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metrics (
    id            BIGSERIAL PRIMARY KEY,
    node_hostname TEXT    NOT NULL REFERENCES nodes(hostname),
    cpu_percent   REAL    NOT NULL,
    mem_total     BIGINT  NOT NULL,
    mem_used      BIGINT  NOT NULL,
    swap_total    BIGINT  NOT NULL,
    swap_used     BIGINT  NOT NULL,
    load1         REAL    NOT NULL,
    load5         REAL    NOT NULL,
    load15        REAL    NOT NULL,
    uptime_secs   BIGINT  NOT NULL,
    reported_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_node ON metrics(node_hostname, reported_at DESC);
