use anyhow::Result;
use clap::Parser;
use common::monitor_client::MonitorClient;
use common::{DiskStat, Metrics, NetStat, NodeInfo, ReportRequest};
use local_ip_address::local_ip;
use std::time::Duration;
use sysinfo::{Disks, Networks, System};
use tonic::metadata::MetadataValue;
use tonic::transport::{Channel, ClientTlsConfig};
use tonic::Request;
use tracing::{error, info, warn};

#[derive(Parser)]
#[command(name = "sentinode-agent")]
struct Cli {
    /// gRPC 服务端地址（https:// 自动启用 TLS）
    #[arg(long, env = "SENTINODE_SERVER", default_value = "http://localhost:50051")]
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
        endpoint = endpoint.tls_config(ClientTlsConfig::new())?;
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
    let ip = local_ip().map(|a| a.to_string()).unwrap_or_else(|_| "unknown".into());
    let os = System::long_os_version()
        .or_else(|| System::name())
        .unwrap_or_else(|| "unknown".into());
    let arch = std::env::consts::ARCH.to_string();

    info!("agent started: {} ({}) → {}", hostname, ip, cli.server);

    let mut sys = System::new();

    loop {
        // CPU 需要两次采样才能得到准确使用率
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

        let networks: Vec<NetStat> = Networks::new_with_refreshed_list()
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
            }),
            timestamp: ts,
        };

        // 指数退避重试，最多 3 次（2s → 4s → 放弃）
        'retry: for attempt in 0..3u32 {
            match client.report(req.clone()).await {
                Ok(r) => {
                    info!("reported ok={}", r.into_inner().ok);
                    break 'retry;
                }
                Err(e) => {
                    let delay = Duration::from_secs(2u64.pow(attempt + 1));
                    if attempt < 2 {
                        warn!("report failed (attempt {}): {e}, retry in {delay:?}", attempt + 1);
                        tokio::time::sleep(delay).await;
                    } else {
                        error!("report failed after 3 attempts: {e}");
                    }
                }
            }
        }

        tokio::time::sleep(Duration::from_secs(cli.interval)).await;
    }
}
