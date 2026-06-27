use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::net::ToSocketAddrs;
use russh::{client, ChannelMsg};
use russh::keys::{PublicKey, decode_secret_key, PrivateKeyWithHashAlg, HashAlg};
use tokio::sync::Mutex;
use tauri::Emitter;

pub fn shell_escape(s: &str) -> String {
    let escaped = s.replace("'", "'\\''");
    format!("'{}'", escaped)
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
        use std::fs::File;
        use std::io::{Read, Write};

        let config_dir = match self.app_handle.path().app_config_dir() {
            Ok(path) => path,
            Err(_) => return Ok(false),
        };

        // Ensure directory exists
        let _ = std::fs::create_dir_all(&config_dir);
        let known_hosts_path = config_dir.join("known_hosts.json");

        let mut known_hosts: HashMap<String, String> = if known_hosts_path.exists() {
            match File::open(&known_hosts_path) {
                Ok(mut file) => {
                    let mut content = String::new();
                    if file.read_to_string(&mut content).is_ok() {
                        serde_json::from_str(&content).unwrap_or_default()
                    } else {
                        HashMap::new()
                    }
                }
                Err(_) => HashMap::new(),
            }
        } else {
            HashMap::new()
        };

        // Generate fingerprint string using SHA256
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let host_key = format!("{}:{}", self.host, self.port);

        if let Some(saved_fingerprint) = known_hosts.get(&host_key) {
            if saved_fingerprint == &fingerprint {
                Ok(true)
            } else {
                eprintln!(
                    "WARNING: Remote host identification has changed for {}! Saved: {}, Received: {}",
                    host_key, saved_fingerprint, fingerprint
                );
                Ok(false) // MITM detection
            }
        } else {
            // Trust on first use (TOFU)
            known_hosts.insert(host_key, fingerprint);
            if let Ok(json_data) = serde_json::to_string_pretty(&known_hosts) {
                if let Ok(mut file) = File::create(&known_hosts_path) {
                    let _ = file.write_all(json_data.as_bytes());
                }
            }
            Ok(true)
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

static TERMINAL_SENDERS: OnceLock<std::sync::Mutex<HashMap<String, tokio::sync::mpsc::Sender<String>>>> = OnceLock::new();

fn get_terminal_senders() -> &'static std::sync::Mutex<HashMap<String, tokio::sync::mpsc::Sender<String>>> {
    TERMINAL_SENDERS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
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
    let socket_addr = addr.to_socket_addrs()
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
    
    let mut handle = client::connect(config, socket_addr, client_handler).await
        .map_err(|e| e.to_string())?;

    let mut authenticated = false;

    if let Some(ref key_str) = private_key {
        if !key_str.trim().is_empty() {
            let key = decode_secret_key(key_str, None)
                .map_err(|e| format!("Failed to parse private key: {}", e))?;
            
            let wrapped_key = PrivateKeyWithHashAlg::new(Arc::new(key), None);

            let auth_res = handle.authenticate_publickey(&username, wrapped_key).await
                .map_err(|e| e.to_string())?;
            authenticated = matches!(auth_res, russh::client::AuthResult::Success);
        }
    }

    if !authenticated {
        if let Some(ref pass) = password {
            let auth_res = handle.authenticate_password(&username, pass).await
                .map_err(|e| e.to_string())?;
            authenticated = matches!(auth_res, russh::client::AuthResult::Success);
        }
    }

    if authenticated {
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
    if sessions.remove(&server_id).is_some() {
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

#[tauri::command]
pub async fn execute_command(server_id: String, command: String) -> Result<CommandResult, String> {
    let handle_arc = {
        let sessions = get_sessions().lock().unwrap();
        sessions.get(&server_id).cloned()
    };

    let handle_arc = handle_arc.ok_or_else(|| "Session not found. Please connect first.".to_string())?;
    let handle = handle_arc.lock().await;
    
    let mut channel = handle.channel_open_session().await
        .map_err(|e| e.to_string())?;

    channel.exec(true, command.as_str()).await
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

static TERMINAL_RESIZE_SENDERS: OnceLock<std::sync::Mutex<HashMap<String, tokio::sync::mpsc::Sender<(u32, u32)>>>> = OnceLock::new();

fn get_terminal_resize_senders() -> &'static std::sync::Mutex<HashMap<String, tokio::sync::mpsc::Sender<(u32, u32)>>> {
    TERMINAL_RESIZE_SENDERS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn write_remote_file(
    server_id: String,
    path: String,
    base64_content: String,
) -> Result<(), String> {
    let path_buf = std::path::Path::new(&path);
    let parent = path_buf.parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string());

    let escaped_parent = shell_escape(&parent);
    let escaped_path = shell_escape(&path);

    if !base64_content.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=') {
        return Err("Invalid base64 content format".to_string());
    }

    let handle_arc = {
        let sessions = get_sessions().lock().unwrap();
        sessions.get(&server_id).cloned()
    };
    let handle_arc = handle_arc.ok_or_else(|| "Session not found. Please connect first.".to_string())?;
    let handle = handle_arc.lock().await;

    let mut channel = handle.channel_open_session().await
        .map_err(|e| e.to_string())?;

    let cmd = format!(
        "mkdir -p {} && base64 -d > {}",
        escaped_parent, escaped_path
    );
    channel.exec(true, cmd.as_str()).await
        .map_err(|e| e.to_string())?;

    channel.data(base64_content.as_bytes()).await
        .map_err(|e| e.to_string())?;

    channel.eof().await
        .map_err(|e| e.to_string())?;

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
    let escaped_path = shell_escape(&path);
    let cmd = format!("base64 -w 0 {}", escaped_path);

    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(format!(
            "Failed to read file. Exit code: {}. Stderr: {}",
            res.exit_code, res.stderr
        ));
    }
    Ok(res.stdout.trim().to_string())
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

    let mut channel = handle.channel_open_session().await
        .map_err(|e| e.to_string())?;

    channel.request_pty(true, "xterm-256color", 80, 24, 0, 0, &[]).await
        .map_err(|e| e.to_string())?;

    channel.request_shell(true).await
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
pub async fn write_terminal_data(
    terminal_id: String,
    data: String,
) -> Result<(), String> {
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
    let escaped_path = shell_escape(&path);
    
    let python_cmd = format!(
        "python3 -c \"import os, sys, json, stat; \
        path = sys.argv[1]; \
        items = []; \
        for f in os.listdir(path): \
            try: \
                p = os.path.join(path, f); \
                s = os.stat(p); \
                items.append({{\
                    'name': f, \
                    'is_dir': stat.S_ISDIR(s.st_mode), \
                    'size': s.st_size if not stat.S_ISDIR(s.st_mode) else 0, \
                    'permissions': stat.filemode(s.st_mode), \
                    'modified': int(s.st_mtime) \
                }}); \
            except: \
                pass; \
        print(json.dumps(items))\" {}",
        escaped_path
    );

    let res = execute_command(server_id.clone(), python_cmd).await?;
    if res.exit_code == 0 {
        if let Ok(files) = serde_json::from_str::<Vec<FileInfo>>(&res.stdout) {
            return Ok(files);
        }
    }

    let ls_cmd = format!("ls -lA --time-style=+%s {}", escaped_path);
    let res_ls = execute_command(server_id, ls_cmd).await?;
    if res_ls.exit_code != 0 {
        return Err(format!("Failed to list directory: {}", res_ls.stderr));
    }

    let mut files = Vec::new();
    for line in res_ls.stdout.lines() {
        if line.starts_with("total ") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 7 {
            let permissions = parts[0].to_string();
            let is_dir = permissions.starts_with('d');
            let size = parts[4].parse::<u64>().unwrap_or(0);
            let modified = parts[5].parse::<u64>().unwrap_or(0);
            let name = parts[6..].join(" ");
            files.push(FileInfo {
                name,
                is_dir,
                size,
                permissions,
                modified,
            });
        }
    }

    Ok(files)
}

#[tauri::command]
pub async fn chmod_file(server_id: String, path: String, mode: String) -> Result<(), String> {
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
    let cmd = format!("mkdir -p {}", shell_escape(&path));
    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(res.stderr);
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_file_or_directory(server_id: String, path: String, is_dir: bool) -> Result<(), String> {
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
pub async fn control_service(server_id: String, service_name: String, action: String) -> Result<(), String> {
    if action != "start" && action != "stop" && action != "restart" {
        return Err("Invalid service action".to_string());
    }
    let cmd = format!(
        "sudo systemctl {} {} || systemctl {} {}",
        action, shell_escape(&service_name), action, shell_escape(&service_name)
    );
    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(res.stderr);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_service_logs(server_id: String, service_name: String) -> Result<String, String> {
    let cmd = format!("journalctl -u {} -n 50 --no-pager", shell_escape(&service_name));
    let res = execute_command(server_id, cmd).await?;
    if res.exit_code != 0 {
        return Err(res.stderr);
    }
    Ok(res.stdout)
}

#[tauri::command]
pub async fn control_container(server_id: String, name: String, action: String) -> Result<(), String> {
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

    if domain.is_empty() || domain.len() > 253 || !domain.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err("Invalid domain name format".to_string());
    }

    if server_type == "nginx" {
        let nginx_config = format!(
            "server {{\n    listen 80;\n    server_name {};\n\n    location / {{\n        proxy_pass http://127.0.0.1:{};\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection 'upgrade';\n        proxy_set_header Host $host;\n        proxy_cache_bypass $http_upgrade;\n    }}\n}}",
            domain, port
        );

        let tmp_path = format!("/tmp/vessel_nginx_{}", domain);
        
        let b64 = base64::Engine::encode(&base64::prelude::BASE64_STANDARD, nginx_config.as_bytes());
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
        let caddy_block = format!(
            "\n# Vessel Proxy Block\n{} {{\n    reverse_proxy localhost:{}\n}}\n",
            domain, port
        );
        let cmd = format!(
            "echo {} | sudo tee -a /etc/caddy/Caddyfile && sudo systemctl reload caddy",
            shell_escape(&caddy_block)
        );
        let res = execute_command(server_id, cmd).await?;
        if res.exit_code != 0 {
            return Err(format!("Caddy config deployment failed: {}", res.stderr));
        }
    }

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
