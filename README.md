# Vessel ⚓



<p align="center">
  <strong>A modern, local-first control plane for VPS management.</strong>
</p>

<p align="center">
  Manage servers, Docker containers, services, files, and reverse proxies through a premium desktop experience — powered entirely by SSH.
</p>

<p align="center">
  <a href="https://github.com/shihebamrii/vessel/actions">
    <img src="https://img.shields.io/github/actions/workflow/status/shihebamrii/vessel/ci.yml?branch=main&style=for-the-badge" />
  </a>

  <a href="https://github.com/shihebamrii/vessel/releases">
    <img src="https://img.shields.io/github/v/release/shihebamrii/vessel?style=for-the-badge" />
  </a>

  <a href="LICENSE">
    <img src="https://img.shields.io/github/license/shihebamrii/vessel?style=for-the-badge" />
  </a>

  <img src="https://img.shields.io/badge/Tauri-v2-24C8DB?style=for-the-badge" />
  <img src="https://img.shields.io/badge/SolidJS-2C4F7C?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge" />
</p>

---

## 🎥 Demo

<p align="center">
  <a href="https://github.com/shihebamrii/vessel/raw/main/public/Demo.mp4">
    <img src="./public/DemoFinal.gif" alt="Vessel Demo">
  </a>
</p>

<p align="center">
  <b>Click the preview above to watch the full video.</b>
</p>

---

## ✨ What is Vessel?

Vessel is a **desktop-native control plane** for managing Linux servers through standard SSH.

Unlike traditional panels such as cPanel, Plesk, or aaPanel, Vessel installs **nothing** on your VPS.

No agents.

No daemons.

No web dashboards.

No additional attack surface.

Your machine remains exactly as it was—Vessel simply connects securely through SSH and gives you a modern interface for operating it.

---

## 🚀 Why Vessel?

### 🔒 Local First

Your credentials never leave your computer.

SSH keys and secrets are stored using native operating-system secure storage:

* Windows Credential Manager
* macOS Keychain
* Linux Secret Service

### ⚡ Zero Server Overhead

Traditional hosting panels consume RAM, CPU, storage, and expose additional services.

Vessel uses:

* SSH
* SFTP
* Existing Linux tooling

Nothing else.

### 🎨 Premium Native Experience

Built with:

* Rust
* Tauri v2
* SolidJS
* xterm.js
* WebGL acceleration

The result is a fast, lightweight desktop experience with modern glassmorphic design principles.

### 🛠 One Unified Dashboard

Manage:

* Files
* Terminals
* systemd services
* Docker containers
* Nginx
* Caddy
* SSL certificates
* Resource monitoring

From one application.

---

## 🏗 Architecture

```text
┌───────────────────────────────────────┐
│        Local Desktop (Tauri)          │
│                                       │
│  ┌───────────┐       ┌─────────────┐  │
│  │ SolidJS   │◄────►│ Rust Backend│  │
│  └───────────┘  IPC  └──────┬──────┘  │
└─────────────────────────────┼─────────┘
                              │
                     SSH / SFTP Tunnel
                              │
                              ▼
┌───────────────────────────────────────┐
│           Remote VPS Host             │
│                                       │
│  • systemd                            │
│  • Docker                             │
│  • Nginx / Caddy                      │
│  • Existing Linux environment         │
└───────────────────────────────────────┘
```

---

## 🔥 Features

### 📊 Resource Monitoring

* CPU usage
* Memory statistics
* Disk utilization
* Uptime tracking
* Real-time updates

### 📁 File Manager

* Remote file browsing
* Rename, move, delete
* Permission editing
* Inline code editor
* Binary file protection

### 🖥 Integrated Terminal

* xterm.js + WebGL acceleration
* Persistent SSH sessions
* Low-latency PTY streaming

### ⚙️ Service Management

* Start and stop services
* Restart operations
* Live journal logs
* Status monitoring

### 🐳 Docker Dashboard

* Container lifecycle management
* Live logs
* Running/stopped states
* Quick actions

### 🌍 Reverse Proxy Manager

* Nginx configuration generation
* Caddy support
* SSL provisioning
* Let's Encrypt integration

### 🌿 Git Control Plane

* VS Code-style working-tree status (staged, unstaged, incoming changes)
* Commit log with ASCII branch graph
* Branch viewer with one-click remote checkout
* Deploy pipeline: chain `git pull` with a post-pull action (systemd restart, Docker restart, or custom script)
* Auto-scan VPS to discover all Git repositories
* Live-streamed console output for every Git operation

---

## 🛡 Security

Security is a first-class concern.

Recent improvements include:

* Input validation on all filesystem operations
* Path traversal protection
* Null-byte filtering
* Shell injection prevention
* Safe command argument handling
* Binary file corruption safeguards
* Native credential vault integration

---

## 🛠 Installation

### Download Releases

Get the latest binaries from:

https://github.com/shihebamrii/vessel/releases

Supported platforms:

* Windows (.exe, .msi)
* Linux (.deb)
* macOS (.dmg)

---

### Build From Source

```bash
git clone https://github.com/shihebamrii/vessel.git

cd vessel

npm install

npm run tauri dev
```

Build production binaries:

```bash
npm run tauri build
```

---

## 🤝 Contributing

Contributions are welcome.

Whether it's:

* Bug reports
* UI improvements
* Documentation
* Security reviews
* Feature proposals

please open an issue or submit a pull request.

See:

```text
CONTRIBUTING.md
```

for development guidelines.

---

## 📄 License

Licensed under the MIT License.

See:

```text
LICENSE
```

for more information.
