use anyhow::Result;
use clap::Parser;
use common::monitor_client::MonitorClient;
use common::{DiskStat, Metrics, NetStat, NodeInfo, ReportRequest};
use local_ip_address::local_ip;
use std::time::Duration;
use sysinfo::{Disks, Networks, System};
use tonic::metadata::MetadataValue;
use tonic::transport::Channel;
use tonic::Request;
use tracing::{error, info};

#[derive(Parser)]
#[command(name = "sentinode-agent")]
struct Cli {
    /// gRPC 服务端地址
    #[arg(long, env = "SENTINODE_SERVER", default_value = "http://localhost:50051")]
    server: String,

    /// 认证 token
    #[arg(long, env = "SENTINODE_TOKEN")]
    token: String,

    /// 上报间隔（秒）
    #[arg(long, env = "SENTINODE_INTERVAL", default_value_t = 30)]
    interval: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let cli = Cli::parse();

    // 使用 connect_lazy，连接失败时自动重试
    let channel = Channel::from_shared(cli.server.clone())?.connect_lazy();
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

        match client.report(req).await {
            Ok(r) => info!("reported ok={}", r.into_inner().ok),
            Err(e) => error!("report failed: {e}"),
        }

        tokio::time::sleep(Duration::from_secs(cli.interval)).await;
    }
}
