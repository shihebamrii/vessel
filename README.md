# Vessel ⚓

<p align="center">
  <strong>Vessel</strong> is a modern, local-first desktop control plane that gives you a beautiful, premium GUI to manage, monitor, and deploy configurations to your VPS servers over standard SSH—with zero server overhead and complete privacy.
</p>

<p align="center">
  <a href="https://github.com/shihebamrii/vessel/actions"><img src="https://img.shields.io/github/actions/workflow/status/shihebamrii/vessel/ci.yml?branch=main&style=flat-square" alt="Build Status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/shihebamrii/vessel?style=flat-square&color=blue" alt="License"></a>
  <a href="https://github.com/shihebamrii/vessel/releases"><img src="https://img.shields.io/github/v/release/shihebamrii/vessel?style=flat-square" alt="Latest Release"></a>
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri-v2-38bdf8?style=flat-square" alt="Tauri"></a>
</p>

<p align="center">
  <img src="public/DemoFinal.gif" alt="Vessel Demo" width="800">
</p>

---

## ⚡ Why Vessel?

*   **Zero Server Footprint:** Traditional panels (like cPanel or aaPanel) run heavy web services directly on your VPS, consuming hundreds of megabytes of RAM. Vessel is **agentless**—it runs on your desktop and operates over standard SSH.
*   **Local-First Privacy:** Your SSH private keys, passwords, and configurations never leave your machine. Credentials are encrypted and stored securely inside your operating system's native secure vault (macOS Keychain, Windows Credential Manager, or Linux Secret Service).
*   **Futuristic Glassmorphic UI:** A premium, ultra-responsive dashboard built with SolidJS and custom CSS variables, optimized for high FPS rendering.
*   **Unified Control Plane:** Seamlessly manage files, terminal commands, active systemd services, Docker containers, and reverse proxy configs in a single dashboard.

---

## 🏗️ Architecture

Vessel leverages a secure, multi-threaded asynchronous architecture separating system operations from the rendering view:

```
┌───────────────────────────────────────┐         Secure SSH/SFTP Tunnel
│        Local Desktop (Tauri)          │   ==============================>   ┌───────────────────────────┐
│  ┌───────────┐         ┌───────────┐  │   - SSH Port 22 Only                │      Remote VPS (Host)    │
│  │ SolidJS   │  ◄───►  │ Rust      │  │   - No local keys on Webview        │  - systemd services       │
│  │ Frontend  │  (IPC)  │ Backend   │  │   - Local OS Keychain               │  - Docker Engine          │
│  └───────────┘         └─────┬─────┘  │                                     │  - Nginx / Caddy Proxy    │
└──────────────────────────────┼────────┘                                     └───────────────────────────┘
                               ▼
                    [ Native Secure Vault ]
                  (Credential Manager / Keychain)
```

---

## 🚀 Features

### 🖥️ 1. Resource Dashboard
*   Real-time polling of CPU load, Memory allocation, Disk capacity, and system uptime.
*   Interactive, smooth vector progress indicators.

### 📂 2. File Explorer & Editor
*   An SFTP-like file tree browser (folder creation, renaming, and permissions management).
*   Integrated code editor workspace with direct base64-isolated remote write operations.
*   Visual permission manager supporting numerical `chmod` adjustments in 1 click.

### 🐚 3. Embedded Shell Terminal
*   Hardware-accelerated terminal emulator using `xterm.js` and WebGL.
*   Persistent PTY shell streaming over safe tokio mpsc messaging blocks.

### ⚙️ 4. Services & Docker Supervisors
*   **systemd Supervisor:** Start, stop, and restart services; tail live log logs cleanly.
*   **Docker Supervisor:** Monitor active/stopped containers, trigger actions, and dump logs.

### 🌐 5. Reverse Proxy Configurator
*   Forms to generate and deploy site blocks for **Nginx** and **Caddy** reverse proxies.
*   Automated SSL certificate request using **Certbot (Let's Encrypt)**.

---

## 🆕 What's New (Latest Release Updates)

We've shipped significant upgrades since the initial release, focusing on host-level security, interactive log diagnostics, and deep dashboard telemetry.

### 🛡️ 1. Host-Level Security Hardening
* **Input Sanitization:** Implemented strict backend validation across all filesystem endpoints (`read`, `write`, `delete`, `chmod`, `list`) to filter null-byte sequences and control characters.
* **Command Injection Guard:** Prevent shell arguments expansion and path traversal vulnerabilities over the SSH connection.

### 📊 2. Dynamic Log Monitors (Split-Pane Layout)
* **Real-time Diagnostics Console:** Both systemd Service Supervisor and Docker Container Supervisor now feature a high-fidelity split-pane dashboard with interactive log streams (`journalctl` and `docker logs`).
* **Pulse Status Indicators:** Visual micro-animations showing running, inactive, or error states at a glance.
* **Manual Log Fetching:** One-click telemetry retrieval directly inside the control plane.

### 📈 3. Extended System Telemetry Inventory
* **Dashboard Summary:** A new dedicated system inventory panel displaying real-time Hostname, OS Kernel Release, Physical RAM capacity, and detailed Storage Root utilization.
* **Custom Gauge Bars:** Replaced browser-default ranges with high-contrast, CSS-themed resource utilization visualizers.

### 🔍 4. Mapped Routes Search Engine
* **Instant Filter Routing:** Added search indexing to the Reverse Proxy panel, letting you filter active Nginx/Caddy server blocks and local target ports in real-time.
* **Inline Navigation Hub:** Clickable domain links with target external indicators to launch proxy sites directly from the dashboard.

### 📂 5. Refined Editor Workspace
* **Binary File Protection:** Safe-fail dashboard preventing binary file corruption, showing file metadata (byte sizes, timestamps, access modes).
* **Direct Permissions Tool:** An inline `chmod` permission configurator to toggle host access permissions instantly.

---

## 🛠️ Installation & Building

### 1. Download Pre-built Release
Visit our [Releases Page](https://github.com/shihebamrii/vessel/releases) to download the native installer for your operating system:
*   **Windows:** `.msi` or `.exe` installer.
*   **macOS:** `.dmg` installer (Universal binary).
*   **Linux:** `.deb` package.

### 2. Build From Source
Please review our [Contributing Guidelines](CONTRIBUTING.md) for local environment setup details.
```bash
# Clone the repository
git clone https://github.com/shihebamrii/vessel.git
cd vessel

# Install dependencies
npm install

# Run in developer mode
npm run dev
```

---

## 🤝 Contributing
Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**. Please read [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## 📄 License
Distributed under the MIT License. See [LICENSE](LICENSE) for more information.
