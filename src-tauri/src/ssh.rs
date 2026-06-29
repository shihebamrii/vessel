use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{client, ChannelMsg};
use std::collections::HashMap;
use std::net::ToSocketAddrs;
use std::sync::{Arc, OnceLock};
use tauri::Emitter;
use tokio::sync::Mutex;

pub fn shell_escape(s: &str) -> String {
    let escaped = s.replace("'", "'\\''");
    format!("'{}'", escaped)
}

pub fn validate_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("Invalid path: contains null byte".to_string());
    }
    if path.contains('\n') || path.contains('\r') {
        return Err("Invalid path: contains newline characters".to_string());
    }
    Ok(())
}

pub fn wrap_sudo(command: &str, password: Option<&str>) -> String {
    if let Some(pass) = password {
        let escaped_pass = shell_escape(pass);
        command.replace("sudo ", &format!("echo {} | sudo -S -p '' ", escaped_pass))
    } else {
        command.to_string()
    }
}

static KNOWN_HOSTS_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
fn get_known_hosts_lock() -> &'static tokio::sync::Mutex<()> {
    KNOWN_HOSTS_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn read_known_hosts(path: &std::path::Path) -> HashMap<String, String> {
    use std::fs::File;
    use std::io::Read;
    if path.exists() {
        if let Ok(mut file) = File::open(path) {
            let mut content = String::new();
            if file.read_to_string(&mut content).is_ok() {
                return serde_json::from_str(&content).unwrap_or_default();
            }
        }
    }
    HashMap::new()
}

fn write_known_hosts(
    path: &std::path::Path,
    known_hosts: &HashMap<String, String>,
) -> Result<(), std::io::Error> {
    use std::fs::File;
    use std::io::Write;
    let json_data = serde_json::to_string_pretty(known_hosts)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let mut file = File::create(path)?;
    file.write_all(json_data.as_bytes())?;
    Ok(())
}

#[derive(serde::Serialize, Clone)]
pub struct HostKeyConfirmPayload {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub is_mismatch: bool,
}

static PENDING_CONFIRMATIONS: OnceLock<
    tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
> = OnceLock::new();

fn get_pending_confirmations(
) -> &'static tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>> {
    PENDING_CONFIRMATIONS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn confirm_host_key(host: String, port: u16, accept: bool) -> Result<(), String> {
    let host_key = format!("{}:{}", host, port);
    let mut confirmations = get_pending_confirmations().lock().await;
    if let Some(tx) = confirmations.remove(&host_key) {
        let _ = tx.send(accept);
        Ok(())
    } else {
        Err("No pending host key confirmation found".to_string())
    }
}

#[derive(Clone)]
pub struct ClientHandler {
    server_id: String,
    host: String,
    port: u16,
    app_handle: tauri::AppHandle,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        use tauri::Manager;

        let config_dir = match self.app_handle.path().app_config_dir() {
            Ok(path) => path,
            Err(_) => return Ok(false),
        };

        let known_hosts_path = config_dir.join("known_hosts.json");
        let host_key = format!("{}:{}", self.host, self.port);
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();

        let _lock = get_known_hosts_lock().lock().await;
        let _ = std::fs::create_dir_all(&config_dir);

        let known_hosts = read_known_hosts(&known_hosts_path);

        if let Some(saved_fingerprint) = known_hosts.get(&host_key) {
            if saved_fingerprint == &fingerprint {
                return Ok(true);
            }
        }

        let is_mismatch = known_hosts.contains_key(&host_key);
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut confirmations = get_pending_confirmations().lock().await;
            confirmations.insert(host_key.clone(), tx);
        }

        let _ = self.app_handle.emit(
            "ssh-host-key-confirm",
            HostKeyConfirmPayload {
                host: self.host.clone(),
                port: self.port,
                fingerprint: fingerprint.clone(),
                is_mismatch,
            },
        );

        let accepted = match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
            Ok(Ok(val)) => val,
            _ => false,
        };

        if accepted {
            let mut current_hosts = read_known_hosts(&known_hosts_path);
            current_hosts.insert(host_key, fingerprint);
            let _ = write_known_hosts(&known_hosts_path, &current_hosts);
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

#[derive(serde::Serialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: u32,
}

type ActiveHandle = Arc<Mutex<client::Handle<ClientHandler>>>;
static SESSIONS: OnceLock<std::sync::Mutex<HashMap<String, ActiveHandle>>> = OnceLock::new();

fn get_sessions() -> &'static std::sync::Mutex<HashMap<String, ActiveHandle>> {
    SESSIONS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

static TERMINAL_SENDERS: OnceLock<
    std::sync::Mutex<HashMap<String, tokio::sync::mpsc::Sender<String>>>,
> = OnceLock::new();

fn get_terminal_senders(
) -> &'static std::sync::Mutex<HashMap<String, tokio::sync::mpsc::Sender<String>>> {
    TERMINAL_SENDERS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

static LOG_STREAM_SENDERS: OnceLock<
    std::sync::Mutex<HashMap<String, tokio::sync::mpsc::Sender<()>>>,
> = OnceLock::new();

fn get_log_stream_senders(
) -> &'static std::sync::Mutex<HashMap<String, tokio::sync::mpsc::Sender<()>>> {
    LOG_STREAM_SENDERS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn connect_session(
    app_handle: tauri::AppHandle,
    server_id: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    private_key: Option<String>,
) -> Result<(), String> {
    let addr = format!("{}:{}", host, port);
    let socket_addr = addr
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or_else(|| "Failed to resolve address".to_string())?;

    let config = client::Config::default();
    let config = Arc::new(config);

    let client_handler = ClientHandler {
        server_id: server_id.clone(),
        host: host.clone(),
        port,
        app_handle,
    };

    let mut handle = client::connect(config, socket_addr, client_handler)
        .await
        .map_err(|e| e.to_string())?;

    let mut authenticated = false;

    if let Some(ref key_str) = private_key {
        if !key_str.trim().is_empty() {
            let key = decode_secret_key(key_str, None)
                .map_err(|e| format!("Failed to parse private key: {}", e))?;

            let wrapped_key = PrivateKeyWithHashAlg::new(Arc::new(key), None);

            let auth_res = handle
                .authenticate_publickey(&username, wrapped_key)
                .await
                .map_err(|e| e.to_string())?;
            authenticated = matches!(auth_res, russh::client::AuthResult::Success);
        }
    }

    if !authenticated {
        if let Some(ref pass) = password {
            let auth_res = handle
                .authenticate_password(&username, pass)
                .await
                .map_err(|e| e.to_string())?;
            authenticated = matches!(auth_res, russh::client::AuthResult::Success);
        }
    }

    if authenticated {
        let _ = disconnect_session(server_id.clone());
        let mut sessions = get_sessions().lock().unwrap();
        sessions.insert(server_id, Arc::new(Mutex::new(handle)));
        Ok(())
    } else {
        Err("Authentication failed".to_string())
    }
}

#[tauri::command]
pub fn disconnect_session(server_id: String) -> Result<(), String> {
    let mut sessions = get_sessions().lock().unwrap();
    let removed = sessions.remove(&server_id).is_some();

    let prefix = format!("term-{}-", server_id);
    {
        let mut senders = get_terminal_senders().lock().unwrap();
        senders.retain(|k, _| !k.starts_with(&prefix));
    }
    {
        let mut resize_senders = get_terminal_resize_senders().lock().unwrap();
        resize_senders.retain(|k, _| !k.starts_with(&prefix));
    }

    let log_prefix = format!("logs-{}-", server_id);
    {
        let mut senders = get_log_stream_senders().lock().unwrap();
        let mut to_remove = Vec::new();
        for (k, tx) in senders.iter() {
            if k.starts_with(&log_prefix) {
                let _ = tx.try_send(());
                to_remove.push(k.clone());
            }
        }
        for k in to_remove {
            senders.remove(&k);
        }
    }

    if removed {
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

#[tauri::command]
pub async fn execute_command(server_id: String, command: String) -> Result<CommandResult, String> {
    if command.contains('\0') {
        return Err("Command contains null byte".to_string());
    }
    let handle_arc = {
        let sessions = get_sessions().lock().unwrap();
        sessions.get(&server_id).cloned()
    };

    let handle_arc =
        handle_arc.ok_or_else(|| "Session not found. Please connect first.".to_string())?;

    let password = crate::keychain::get_server_credential(&server_id, "password").ok();
    let wrapped_command = if command.contains("sudo ") {
        wrap_sudo(&command, password.as_deref())
    } else {
        command
    };

    let handle = handle_arc.lock().await;

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;

    channel
        .exec(true, wrapped_command.as_str())
        .await
        .map_err(|e| e.to_string())?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = 0;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => {
                stdout.extend_from_slice(&data);
            }
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                stderr.extend_from_slice(&data);
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = exit_status;
            }
            _ => {}
        }
    }

    let stdout_str = String::from_utf8_lossy(&stdout).into_owned();
    let stderr_str = String::from_utf8_lossy(&stderr).into_owned();

    Ok(CommandResult {
        stdout: stdout_str,
        stderr: stderr_str,
        exit_code,
    })
}

static TERMINAL_RESIZE_SENDERS: OnceLock<
    std::sync::Mutex<HashMap<String, tokio::sync::mpsc::Sender<(u32, u32)>>>,
> = OnceLock::new();

fn get_terminal_resize_senders(
) -> &'static std::sync::Mutex<HashMap<String, tokio::sync::mpsc::Sender<(u32, u32)>>> {
    TERMINAL_RESIZE_SENDERS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn write_remote_file(
    server_id: String,
    path: String,
    base64_content: String,
) -> Result<(), String> {
    validate_path(&path)?;
    let path_buf = std::path::Path::new(&path);
    let parent = path_buf
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string());

    let escaped_parent = shell_escape(&parent);
    let escaped_path = shell_escape(&path);

    if !base64_content
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')
    {
        return Err("Invalid base64 content format".to_string());
    }

    let handle_arc = {
        let sessions = get_sessions().lock().unwrap();
        sessions.get(&server_id).cloned()
    };
    let handle_arc =
        handle_arc.ok_or_else(|| "Session not found. Please connect first.".to_string())?;
    let handle = handle_arc.lock().await;

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;

    let cmd = format!(
        "mkdir -p {} && (if base64 -d </dev/null >/dev/null 2>&1; then base64 -d; else base64 -D; fi) > {}",
        escaped_parent, escaped_path
    );
    channel
        .exec(true, cmd.as_str())
        .await
        .map_err(|e| e.to_string())?;

    channel
        .data(base64_content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    channel.eof().await.map_err(|e| e.to_string())?;

    let mut exit_code = 0;
    let mut stderr = Vec::new();

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                stderr.extend_from_slice(&data);
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = exit_status;
            }
            _ => {}
        }
    }

    if exit_code != 0 {
        let err_str = String::from_utf8_lossy(&stderr).into_owned();
        return Err(format!(
            "Failed to write file. Exit code: {}. Stderr: {}",
            exit_code, err_str
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn read_remote_file(server_id: String, path: String) -> Result<String, String> {
    validate_path(&path)?;
    let escaped_path = shell_escape(&path);
    let cmd = format!("base64 {}", escaped_path);

    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(format!(
            "Failed to read file. Exit code: {}. Stderr: {}",
            res.exit_code, res.stderr
        ));
    }
    let b64_clean = res
        .stdout
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    Ok(b64_clean)
}

#[tauri::command]
pub async fn close_terminal_session(terminal_id: String) -> Result<(), String> {
    {
        let mut senders = get_terminal_senders().lock().unwrap();
        senders.remove(&terminal_id);
    }
    {
        let mut resize_senders = get_terminal_resize_senders().lock().unwrap();
        resize_senders.remove(&terminal_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn start_terminal_session(
    app_handle: tauri::AppHandle,
    server_id: String,
    terminal_id: String,
) -> Result<(), String> {
    let handle_arc = {
        let sessions = get_sessions().lock().unwrap();
        sessions.get(&server_id).cloned()
    };
    let handle_arc = handle_arc.ok_or_else(|| "Session not found".to_string())?;
    let handle = handle_arc.lock().await;

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;

    channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| e.to_string())?;

    channel
        .request_shell(true)
        .await
        .map_err(|e| e.to_string())?;

    let event_name = format!("terminal-data:{}", terminal_id);
    let app_handle_clone = app_handle.clone();
    let terminal_id_clone = terminal_id.clone();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);
    {
        let mut senders = get_terminal_senders().lock().unwrap();
        senders.insert(terminal_id.clone(), tx);
    }

    let (resize_tx, mut resize_rx) = tokio::sync::mpsc::channel::<(u32, u32)>(10);
    {
        let mut resize_senders = get_terminal_resize_senders().lock().unwrap();
        resize_senders.insert(terminal_id.clone(), resize_tx);
    }

    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg_opt = channel.wait() => {
                    match msg_opt {
                        Some(msg) => {
                            match msg {
                                ChannelMsg::Data { data } => {
                                    let data_str = String::from_utf8_lossy(&data).into_owned();
                                    let _ = app_handle_clone.emit(&event_name, data_str);
                                }
                                ChannelMsg::ExtendedData { data, ext: 1 } => {
                                    let data_str = String::from_utf8_lossy(&data).into_owned();
                                    let _ = app_handle_clone.emit(&event_name, data_str);
                                }
                                ChannelMsg::ExitStatus { .. } => {
                                    let _ = app_handle_clone.emit(&event_name, "\r\n[Session Terminated]\r\n".to_string());
                                    break;
                                }
                                _ => {}
                            }
                        }
                        None => {
                            break;
                        }
                    }
                }
                input_opt = rx.recv() => {
                    if let Some(input) = input_opt {
                        if let Err(_) = channel.data(input.as_bytes()).await {
                            break;
                        }
                    } else {
                        break;
                    }
                }
                resize_opt = resize_rx.recv() => {
                    if let Some((cols, rows)) = resize_opt {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                }
            }
        }

        // Clean up terminal senders to prevent leaks
        {
            let mut senders = get_terminal_senders().lock().unwrap();
            senders.remove(&terminal_id_clone);
        }
        {
            let mut resize_senders = get_terminal_resize_senders().lock().unwrap();
            resize_senders.remove(&terminal_id_clone);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn write_terminal_data(terminal_id: String, data: String) -> Result<(), String> {
    let sender = {
        let senders = get_terminal_senders().lock().unwrap();
        senders.get(&terminal_id).cloned()
    };
    if let Some(tx) = sender {
        tx.send(data).await.map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Terminal session not found".to_string())
    }
}

#[tauri::command]
pub async fn resize_terminal_session(
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let sender = {
        let senders = get_terminal_resize_senders().lock().unwrap();
        senders.get(&terminal_id).cloned()
    };
    if let Some(tx) = sender {
        tx.send((cols, rows)).await.map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Terminal session not found".to_string())
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct FileInfo {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: String,
    pub modified: u64,
}

#[tauri::command]
pub async fn list_directory(server_id: String, path: String) -> Result<Vec<FileInfo>, String> {
    validate_path(&path)?;
    let escaped_path = shell_escape(&path);

    let stat_script = format!(
        "cd {} && for f in * .*; do \
           if [ \"$f\" != \".\" ] && [ \"$f\" != \"..\" ] && [ -e \"$f\" ]; then \
             if stat -c \"%n\" . >/dev/null 2>&1; then \
               stat -c \"%F|%s|%Y|%A|%n\" \"$f\" 2>/dev/null; \
             else \
               stat -f \"%HT|%z|%m|%Sp|%N\" \"$f\" 2>/dev/null; \
             fi; \
           fi; \
         done",
        escaped_path
    );

    let res = execute_command(server_id, stat_script).await?;
    if res.exit_code != 0 {
        return Err(format!("Failed to list directory: {}", res.stderr));
    }

    let mut files = Vec::new();
    for line in res.stdout.lines() {
        let parts: Vec<&str> = line.splitn(5, '|').collect();
        if parts.len() == 5 {
            let file_type = parts[0].to_lowercase();
            let is_dir = file_type.contains("directory");
            let size = parts[1].parse::<u64>().unwrap_or(0);
            let modified = parts[2].parse::<u64>().unwrap_or(0);
            let permissions = parts[3].to_string();
            let name = parts[4].to_string();

            files.push(FileInfo {
                name,
                is_dir,
                size: if is_dir { 0 } else { size },
                permissions,
                modified,
            });
        }
    }

    Ok(files)
}

#[tauri::command]
pub async fn chmod_file(server_id: String, path: String, mode: String) -> Result<(), String> {
    validate_path(&path)?;
    if !mode.chars().all(|c| c.is_digit(8)) || mode.is_empty() || mode.len() > 4 {
        return Err("Invalid permissions mode format".to_string());
    }
    let cmd = format!("chmod {} {}", mode, shell_escape(&path));
    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(res.stderr);
    }
    Ok(())
}

#[tauri::command]
pub async fn create_directory(server_id: String, path: String) -> Result<(), String> {
    validate_path(&path)?;
    let cmd = format!("mkdir -p {}", shell_escape(&path));
    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(res.stderr);
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_file_or_directory(
    server_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    validate_path(&path)?;
    let cmd = if is_dir {
        format!("rm -rf {}", shell_escape(&path))
    } else {
        format!("rm -f {}", shell_escape(&path))
    };
    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(res.stderr);
    }
    Ok(())
}

#[tauri::command]
pub async fn control_service(
    server_id: String,
    service_name: String,
    action: String,
) -> Result<(), String> {
    if action != "start" && action != "stop" && action != "restart" {
        return Err("Invalid service action".to_string());
    }
    let cmd = format!(
        "sudo systemctl {} {} || systemctl {} {}",
        action,
        shell_escape(&service_name),
        action,
        shell_escape(&service_name)
    );
    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(res.stderr);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_service_logs(server_id: String, service_name: String) -> Result<String, String> {
    let cmd = format!(
        "journalctl -u {} -n 50 --no-pager",
        shell_escape(&service_name)
    );
    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(res.stderr);
    }
    Ok(res.stdout)
}

#[tauri::command]
pub async fn control_container(
    server_id: String,
    name: String,
    action: String,
) -> Result<(), String> {
    if action != "start" && action != "stop" && action != "restart" {
        return Err("Invalid container action".to_string());
    }
    let cmd = format!("docker {} {}", action, shell_escape(&name));
    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(res.stderr);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_container_logs(server_id: String, name: String) -> Result<String, String> {
    let cmd = format!("docker logs {} --tail 50", shell_escape(&name));
    let res = execute_command(server_id, cmd).await?;
    // docker logs writes to stderr if no logs are on stdout or in general
    let output = if res.exit_code == 0 {
        if res.stdout.is_empty() && !res.stderr.is_empty() {
            res.stderr
        } else {
            res.stdout
        }
    } else {
        return Err(res.stderr);
    };
    Ok(output)
}

#[derive(serde::Serialize)]
pub struct ProxyConfig {
    pub domain: String,
    pub server_type: String,
    pub enabled: bool,
    pub port: u16,
}

#[tauri::command]
pub async fn list_proxies(server_id: String) -> Result<Vec<ProxyConfig>, String> {
    let script = r#"
# List Nginx proxies
if [ -d /etc/nginx/sites-available ]; then
  for f in $(ls -1 /etc/nginx/sites-available/ 2>/dev/null); do
    if [ "$f" != "default" ]; then
      port=$(grep -E 'proxy_pass http://127.0.0.1:[0-9]+' "/etc/nginx/sites-available/$f" 2>/dev/null | head -n 1 | grep -o -E '[0-9]+')
      enabled=false
      if [ -L "/etc/nginx/sites-enabled/$f" ]; then
        enabled=true
      fi
      echo "nginx|$f|$enabled|${port:-0}"
    fi
  done
fi
# List Caddy proxies
if [ -d /etc/caddy/vessel ]; then
  for f in $(ls -1 /etc/caddy/vessel/ 2>/dev/null); do
    domain=$(basename "$f" .caddy)
    port=$(grep -E 'reverse_proxy localhost:[0-9]+' "/etc/caddy/vessel/$f" 2>/dev/null | head -n 1 | grep -o -E '[0-9]+')
    echo "caddy|$domain|true|${port:-0}"
  done
fi
"#;

    let res = execute_command(server_id, script.to_string()).await?;
    let mut configs = Vec::new();
    for line in res.stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() == 4 {
            let server_type = parts[0].to_string();
            let domain = parts[1].to_string();
            let enabled = parts[2] == "true";
            let port = parts[3].parse::<u16>().unwrap_or(0);
            configs.push(ProxyConfig {
                domain,
                server_type,
                enabled,
                port,
            });
        }
    }
    Ok(configs)
}

#[tauri::command]
pub async fn delete_proxy(
    server_id: String,
    server_type: String,
    domain: String,
) -> Result<(), String> {
    if server_type != "nginx" && server_type != "caddy" {
        return Err("Invalid server type".to_string());
    }

    let cmd = if server_type == "nginx" {
        format!(
            "sudo rm -f /etc/nginx/sites-enabled/{} && \
             sudo rm -f /etc/nginx/sites-available/{} && \
             sudo nginx -t && \
             sudo systemctl reload nginx",
            shell_escape(&domain),
            shell_escape(&domain)
        )
    } else {
        format!(
            "sudo rm -f /etc/caddy/vessel/{}.caddy && \
             sudo systemctl reload caddy",
            shell_escape(&domain)
        )
    };

    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(format!("Failed to delete proxy: {}", res.stderr));
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_proxy_status(
    server_id: String,
    server_type: String,
    domain: String,
    enable: bool,
) -> Result<(), String> {
    if server_type != "nginx" {
        return Err("Only Nginx supports enabling/disabling configs without deleting".to_string());
    }

    let cmd = if enable {
        format!(
            "sudo ln -sf /etc/nginx/sites-available/{} /etc/nginx/sites-enabled/{} && \
             sudo nginx -t && \
             sudo systemctl reload nginx",
            shell_escape(&domain),
            shell_escape(&domain)
        )
    } else {
        format!(
            "sudo rm -f /etc/nginx/sites-enabled/{} && \
             sudo nginx -t && \
             sudo systemctl reload nginx",
            shell_escape(&domain)
        )
    };

    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(format!("Failed to toggle proxy status: {}", res.stderr));
    }
    Ok(())
}

#[tauri::command]
pub async fn configure_proxy(
    server_id: String,
    server_type: String,
    domain: String,
    port: u16,
    enable_ssl: bool,
) -> Result<(), String> {
    if server_type != "nginx" && server_type != "caddy" {
        return Err("Invalid server type".to_string());
    }

    if domain.is_empty()
        || domain.len() > 253
        || !domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err("Invalid domain name format".to_string());
    }

    if server_type == "nginx" {
        let nginx_config = format!(
            "server {{\n    listen 80;\n    server_name {};\n\n    location / {{\n        proxy_pass http://127.0.0.1:{};\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection 'upgrade';\n        proxy_set_header Host $host;\n        proxy_cache_bypass $http_upgrade;\n    }}\n}}",
            domain, port
        );

        let tmp_path = format!("/tmp/vessel_nginx_{}", domain);

        let b64 =
            base64::Engine::encode(&base64::prelude::BASE64_STANDARD, nginx_config.as_bytes());
        write_remote_file(server_id.clone(), tmp_path.clone(), b64).await?;

        let cmd = format!(
            "sudo mv {} /etc/nginx/sites-available/{} && \
             sudo chown root:root /etc/nginx/sites-available/{} && \
             sudo ln -sf /etc/nginx/sites-available/{} /etc/nginx/sites-enabled/{} && \
             sudo nginx -t && \
             sudo systemctl reload nginx",
            shell_escape(&tmp_path),
            shell_escape(&domain),
            shell_escape(&domain),
            shell_escape(&domain),
            shell_escape(&domain)
        );

        let res = execute_command(server_id.clone(), cmd).await?;
        if res.exit_code != 0 {
            return Err(format!("Nginx config deployment failed: {}", res.stderr));
        }

        if enable_ssl {
            let ssl_cmd = format!(
                "sudo certbot --nginx -d {} --non-interactive --agree-tos --register-unsafely-without-email",
                shell_escape(&domain)
            );
            let ssl_res = execute_command(server_id, ssl_cmd).await?;
            if ssl_res.exit_code != 0 {
                return Err(format!("Certbot SSL failed: {}", ssl_res.stderr));
            }
        }
    } else {
        // Caddy
        let caddy_config = format!("{} {{\n    reverse_proxy localhost:{}\n}}\n", domain, port);

        let tmp_path = format!("/tmp/vessel_caddy_{}", domain);
        let b64 =
            base64::Engine::encode(&base64::prelude::BASE64_STANDARD, caddy_config.as_bytes());
        write_remote_file(server_id.clone(), tmp_path.clone(), b64).await?;

        let cmd = format!(
            "sudo mkdir -p /etc/caddy/vessel && \
             sudo mv {} /etc/caddy/vessel/{}.caddy && \
             sudo chown root:root /etc/caddy/vessel/{}.caddy && \
             (grep -q 'import /etc/caddy/vessel/\\*.caddy' /etc/caddy/Caddyfile || echo 'import /etc/caddy/vessel/*.caddy' | sudo tee -a /etc/caddy/Caddyfile) && \
             sudo systemctl reload caddy",
            shell_escape(&tmp_path),
            shell_escape(&domain),
            shell_escape(&domain)
        );
        let res = execute_command(server_id, cmd).await?;
        if res.exit_code != 0 {
            return Err(format!("Caddy config deployment failed: {}", res.stderr));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn start_container_logs_stream(
    app_handle: tauri::AppHandle,
    server_id: String,
    stream_id: String,
    containers: Vec<String>,
) -> Result<(), String> {
    let handle_arc = {
        let sessions = get_sessions().lock().unwrap();
        sessions.get(&server_id).cloned()
    };
    let handle_arc =
        handle_arc.ok_or_else(|| "Session not found. Please connect first.".to_string())?;

    // Stop existing stream with this ID if any
    let _ = stop_container_logs_stream(stream_id.clone());

    // Build the multiplexed shell command
    let mut command = String::new();
    for container in &containers {
        if container.is_empty()
            || container.contains('\n')
            || container.contains('\r')
            || container.contains('\0')
        {
            continue;
        }
        let escaped = shell_escape(container);
        command.push_str(&format!(
            "(docker logs -f --tail 50 {} 2>&1 | while read -r line; do echo \"[{}] $line\"; done) &\n",
            escaped, container
        ));
    }
    if command.is_empty() {
        return Err("No valid containers specified".to_string());
    }
    command.push_str("wait");

    let password = crate::keychain::get_server_credential(&server_id, "password").ok();
    let wrapped_command = if command.contains("sudo ") {
        wrap_sudo(&command, password.as_deref())
    } else {
        command
    };

    let handle = handle_arc.lock().await;
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;

    channel
        .exec(true, wrapped_command.as_str())
        .await
        .map_err(|e| e.to_string())?;

    let event_name = format!("container-logs:{}", stream_id);
    let app_handle_clone = app_handle.clone();
    let stream_id_clone = stream_id.clone();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
    {
        let mut senders = get_log_stream_senders().lock().unwrap();
        senders.insert(stream_id.clone(), tx);
    }

    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg_opt = channel.wait() => {
                    match msg_opt {
                        Some(msg) => {
                            match msg {
                                ChannelMsg::Data { data } => {
                                    let data_str = String::from_utf8_lossy(&data).into_owned();
                                    let _ = app_handle_clone.emit(&event_name, data_str);
                                }
                                ChannelMsg::ExtendedData { data, ext: 1 } => {
                                    let data_str = String::from_utf8_lossy(&data).into_owned();
                                    let _ = app_handle_clone.emit(&event_name, data_str);
                                }
                                ChannelMsg::ExitStatus { .. } => {
                                    break;
                                }
                                _ => {}
                            }
                        }
                        None => {
                            break;
                        }
                    }
                }
                _ = rx.recv() => {
                    let _ = channel.close().await;
                    break;
                }
            }
        }

        // Cleanup sender
        let mut senders = get_log_stream_senders().lock().unwrap();
        senders.remove(&stream_id_clone);
    });

    Ok(())
}

#[tauri::command]
pub fn stop_container_logs_stream(stream_id: String) -> Result<(), String> {
    let mut senders = get_log_stream_senders().lock().unwrap();
    if let Some(tx) = senders.remove(&stream_id) {
        let _ = tx.try_send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn start_command_stream(
    app_handle: tauri::AppHandle,
    server_id: String,
    stream_id: String,
    command: String,
) -> Result<(), String> {
    let handle_arc = {
        let sessions = get_sessions().lock().unwrap();
        sessions.get(&server_id).cloned()
    };
    let handle_arc =
        handle_arc.ok_or_else(|| "Session not found. Please connect first.".to_string())?;

    let password = crate::keychain::get_server_credential(&server_id, "password").ok();
    let wrapped_command = if command.contains("sudo ") {
        wrap_sudo(&command, password.as_deref())
    } else {
        command
    };

    let handle = handle_arc.lock().await;
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;

    channel
        .exec(true, wrapped_command.as_str())
        .await
        .map_err(|e| e.to_string())?;

    let event_name = format!("command-stream:{}", stream_id);
    let app_handle_clone = app_handle.clone();
    let stream_id_clone = stream_id.clone();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
    {
        let mut senders = get_log_stream_senders().lock().unwrap();
        senders.insert(stream_id.clone(), tx);
    }

    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg_opt = channel.wait() => {
                    match msg_opt {
                        Some(msg) => {
                            match msg {
                                ChannelMsg::Data { data } => {
                                    let data_str = String::from_utf8_lossy(&data).into_owned();
                                    let _ = app_handle_clone.emit(&event_name, data_str);
                                }
                                ChannelMsg::ExtendedData { data, ext: 1 } => {
                                    let data_str = String::from_utf8_lossy(&data).into_owned();
                                    let _ = app_handle_clone.emit(&event_name, data_str);
                                }
                                ChannelMsg::ExitStatus { exit_status } => {
                                    let _ = app_handle_clone.emit(&event_name, format!("\n[Exit Code: {}]\n", exit_status));
                                    break;
                                }
                                _ => {}
                            }
                        }
                        None => {
                            break;
                        }
                    }
                }
                _ = rx.recv() => {
                    let _ = channel.close().await;
                    break;
                }
            }
        }

        let mut senders = get_log_stream_senders().lock().unwrap();
        senders.remove(&stream_id_clone);
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shell_escape_simple() {
        assert_eq!(shell_escape("foo"), "'foo'");
        assert_eq!(shell_escape("foo bar"), "'foo bar'");
    }

    #[test]
    fn test_shell_escape_quotes() {
        assert_eq!(shell_escape("foo'bar"), "'foo'\\''bar'");
    }

    #[test]
    fn test_shell_escape_injection() {
        assert_eq!(shell_escape("$(id)"), "'$(id)'");
        assert_eq!(shell_escape("`id`"), "'`id`'");
        assert_eq!(shell_escape("foo; id; bar"), "'foo; id; bar'");
    }
}
