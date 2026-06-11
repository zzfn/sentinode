CREATE TABLE IF NOT EXISTS nodes (
    id        BIGINT PRIMARY KEY,
    hostname  TEXT NOT NULL UNIQUE,
    ip        TEXT NOT NULL,
    os        TEXT NOT NULL,
    arch      TEXT NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metrics (
    id          BIGINT PRIMARY KEY,
    node_id     BIGINT NOT NULL REFERENCES nodes(id),
    cpu_percent REAL   NOT NULL,
    mem_total   BIGINT NOT NULL,
    mem_used    BIGINT NOT NULL,
    swap_total  BIGINT NOT NULL,
    swap_used   BIGINT NOT NULL,
    load1       REAL   NOT NULL,
    load5       REAL   NOT NULL,
    load15      REAL   NOT NULL,
    uptime_secs BIGINT NOT NULL,
    reported_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_node ON metrics(node_id, reported_at DESC);
