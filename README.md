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
  <a href="https://github.com/shihebamrii/vessel/raw/main/public/Demo.mp4">
    🎥 Watch Demo
  </a>
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
