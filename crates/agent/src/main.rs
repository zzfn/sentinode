use anyhow::Result;
use clap::Parser;
use common::monitor_client::MonitorClient;
use common::{DiskStat, LatencyResult, Metrics, NetStat, NodeInfo, ReportRequest};
use local_ip_address::local_ip;
use std::time::Duration;
use sysinfo::{Disks, Networks, System};
use tonic::metadata::MetadataValue;
use tonic::transport::{Channel, ClientTlsConfig};
use tonic::Request;
use tracing::{error, info, warn};

const LATENCY_TARGETS: &[(&str, &str)] = &[
    ("cu", "sh-cu-v4.ip.zstaticcdn.com:80"),
    ("cm", "sh-cm-v4.ip.zstaticcdn.com:80"),
    ("ct", "sh-ct-v4.ip.zstaticcdn.com:80"),
];

async fn tcp_ping(addr: &str) -> f32 {
    let start = tokio::time::Instant::now();
    match tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(_)) => start.elapsed().as_secs_f32() * 1000.0,
        _ => -1.0,
    }
}

async fn measure_latencies() -> Vec<LatencyResult> {
    let (cu, cm, ct) = tokio::join!(
        tcp_ping(LATENCY_TARGETS[0].1),
        tcp_ping(LATENCY_TARGETS[1].1),
        tcp_ping(LATENCY_TARGETS[2].1),
    );
    vec![
        LatencyResult {
            isp: "cu".into(),
            latency_ms: cu,
        },
        LatencyResult {
            isp: "cm".into(),
            latency_ms: cm,
        },
        LatencyResult {
            isp: "ct".into(),
            latency_ms: ct,
        },
    ]
}

#[derive(Parser)]
#[command(name = "sentinode-agent")]
struct Cli {
    /// gRPC 服务端地址（https:// 自动启用 TLS）
    #[arg(
        long,
        env = "SENTINODE_SERVER",
        default_value = "http://localhost:50051"
    )]
    server: String,

    /// 认证 token
    #[arg(long, env = "SENTINODE_TOKEN")]
    token: String,

    /// 上报间隔（秒）
    #[arg(long, env = "SENTINODE_INTERVAL", default_value_t = 30)]
    interval: u64,
}

fn build_channel(server: &str) -> Result<Channel> {
    let mut endpoint = Channel::from_shared(server.to_owned())?;
    if server.starts_with("https://") {
        endpoint = endpoint.tls_config(ClientTlsConfig::new().with_enabled_roots())?;
    }
    Ok(endpoint.connect_lazy())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let cli = Cli::parse();

    let channel = build_channel(&cli.server)?;
    let bearer: MetadataValue<_> = format!("Bearer {}", cli.token).parse()?;
    let mut client = MonitorClient::with_interceptor(channel, move |mut req: Request<()>| {
        req.metadata_mut().insert("authorization", bearer.clone());
        Ok(req)
    });

    let hostname = System::host_name().unwrap_or_else(|| "unknown".into());
    let ip = local_ip()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "unknown".into());
    let os = System::long_os_version()
        .or_else(System::name)
        .unwrap_or_else(|| "unknown".into());
    let arch = std::env::consts::ARCH.to_string();
    let cpu_model = {
        let mut s = System::new();
        s.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
        s.cpus()
            .first()
            .map(|c| c.brand().to_owned())
            .unwrap_or_default()
    };

    info!("agent started: {} ({}) → {}", hostname, ip, cli.server);

    let mut prev_net: (u64, u64) = (0, 0); // (rx_total, tx_total) 所有非回环接口累计
    let mut prev_net_time = std::time::Instant::now();

    let mut sys = System::new();
    let mut latency_enabled = false;
    let mut pending_latencies: Vec<LatencyResult> = vec![];

    loop {
        sys.refresh_cpu_usage();
        tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL).await;
        sys.refresh_cpu_usage();
        sys.refresh_memory();

        let load = System::load_average();

        let disks: Vec<DiskStat> = Disks::new_with_refreshed_list()
            .iter()
            .map(|d| DiskStat {
                name: d.name().to_string_lossy().into_owned(),
                total_bytes: d.total_space(),
                used_bytes: d.total_space().saturating_sub(d.available_space()),
            })
            .collect();

        let nets = Networks::new_with_refreshed_list();
        let elapsed = prev_net_time.elapsed().as_secs_f64().max(0.5);
        let (rx_total, tx_total) = nets
            .iter()
            .filter(|(iface, _)| !iface.starts_with("lo"))
            .fold((0u64, 0u64), |(rx, tx), (_, d)| {
                (rx + d.total_received(), tx + d.total_transmitted())
            });
        let net_rx_rate: u64 = if prev_net != (0, 0) {
            (rx_total.saturating_sub(prev_net.0) as f64 / elapsed) as u64
        } else {
            0
        };
        let net_tx_rate: u64 = if prev_net != (0, 0) {
            (tx_total.saturating_sub(prev_net.1) as f64 / elapsed) as u64
        } else {
            0
        };
        prev_net = (rx_total, tx_total);
        prev_net_time = std::time::Instant::now();

        let tcp_connections: u32 = {
            #[cfg(target_os = "linux")]
            {
                fn count_state(path: &str) -> usize {
                    std::fs::read_to_string(path)
                        .unwrap_or_default()
                        .lines()
                        .skip(1)
                        .filter(|l| l.split_whitespace().nth(3) == Some("01"))
                        .count()
                }
                (count_state("/proc/net/tcp") + count_state("/proc/net/tcp6")) as u32
            }
            #[cfg(not(target_os = "linux"))]
            {
                0u32
            }
        };

        let networks: Vec<NetStat> = nets
            .iter()
            .map(|(iface, data)| NetStat {
                interface: iface.clone(),
                rx_bytes: data.total_received(),
                tx_bytes: data.total_transmitted(),
            })
            .collect();

        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let req = ReportRequest {
            node: Some(NodeInfo {
                hostname: hostname.clone(),
                ip: ip.clone(),
                os: os.clone(),
                arch: arch.clone(),
                uptime_secs: System::uptime(),
                cpu_model: cpu_model.clone(),
                agent_version: env!("CARGO_PKG_VERSION").to_owned(),
            }),
            metrics: Some(Metrics {
                cpu_percent: sys.global_cpu_usage(),
                mem_total: sys.total_memory(),
                mem_used: sys.used_memory(),
                swap_total: sys.total_swap(),
                swap_used: sys.used_swap(),
                load1: load.one as f32,
                load5: load.five as f32,
                load15: load.fifteen as f32,
                disks,
                networks,
                net_rx_rate,
                net_tx_rate,
                tcp_connections,
            }),
            timestamp: ts,
            latencies: std::mem::take(&mut pending_latencies),
        };

        // 指数退避重试，最多 3 次（2s → 4s → 放弃）
        'retry: for attempt in 0..3u32 {
            match client.report(req.clone()).await {
                Ok(r) => {
                    let resp = r.into_inner();
                    info!(
                        "reported ok={} latency_test_enabled={} should_upgrade={}",
                        resp.ok, resp.latency_test_enabled, resp.should_upgrade
                    );
                    latency_enabled = resp.latency_test_enabled;
                    if resp.should_upgrade {
                        let server = cli.server.clone();
                        let token = cli.token.clone();
                        tokio::spawn(async move {
                            info!("upgrade requested, running install script...");
                            let cmd = format!(
                                "curl -fsSL https://raw.githubusercontent.com/zzfn/sentinode/main/scripts/install.sh | sh -s -- --server '{}' --token '{}'",
                                server, token
                            );
                            let _ = tokio::process::Command::new("sh")
                                .arg("-c")
                                .arg(cmd)
                                .spawn();
                        });
                    }
                    break 'retry;
                }
                Err(e) => {
                    let delay = Duration::from_secs(2u64.pow(attempt + 1));
                    if attempt < 2 {
                        warn!(
                            "report failed (attempt {}): {e}, retry in {delay:?}",
                            attempt + 1
                        );
                        tokio::time::sleep(delay).await;
                    } else {
                        error!("report failed after 3 attempts: {e}");
                    }
                }
            }
        }

        // 若已启用延迟测试，并发 TCP ping 三网，结果随下次 report 上报
        if latency_enabled {
            pending_latencies = measure_latencies().await;
            info!(
                "latency: cu={:.1}ms cm={:.1}ms ct={:.1}ms",
                pending_latencies[0].latency_ms,
                pending_latencies[1].latency_ms,
                pending_latencies[2].latency_ms,
            );
        }

        tokio::time::sleep(Duration::from_secs(cli.interval)).await;
    }
}
