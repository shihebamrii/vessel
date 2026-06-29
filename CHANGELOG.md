# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Git Control Plane:** Full remote repository management panel with VS Code-style working-tree status (staged/unstaged/incoming changes), commit log with ASCII graph, branch viewer with one-click checkout, and a Deploy Pipeline configurator that chains `git pull` with a post-pull action (systemd service restart, Docker container restart, or arbitrary shell command). Repositories are discovered automatically via VPS scan or added manually, and all Git operations stream live output to an integrated console.
- **Dynamic Log Monitors:** Interactive split-pane consoles for systemd services (`journalctl`) and Docker containers (`docker logs`).
- **Telemetry Summary:** System telemetry grid in Dashboard displaying Hostname, OS Kernel Release, RAM space, and storage roots.
- **Searchable Proxy Routes:** Search and filter functionality in Reverse Proxy manager, along with domain hyperlinks.
- **Enhanced File Explorer:** Metadata inspector for binary assets, directory creation, recursive deletion, and direct `chmod` permission controller.
- **Multi-Container Live Logs:** Real-time log tailing console for multiple selected Docker containers in one pane, with text search filtering and colored container tags.
- **Docker Auto-Installer:** Automatic detection of Docker runtime on remote hosts, providing a one-click live-streaming installer script setup.
- **Container Creator:** Assistant dialog modal to run new Docker containers with name, image, port, env variables, and restart policy controls, including POSIX argument escaping security.


### Changed
- **Visual Polish:** Redesigned layout with custom progress/gauge indicators and CSS status dots.
- **Inline Demo Media:** Swapped static `.mp4` video redirect link in README for an auto-playing high-quality `.gif` preview.

### Security
- **Strict Input Validation:** Added backend filters for all SSH filesystem APIs (preventing null-byte characters and path traversal injection).

## [1.0.0] - 2026-06-15

### Added
- Initial release of Vessel.
- Secure local SSH key management with OS-native credential vaults.
- Basic telemetry gauges (CPU, RAM, Disk).
- File explorer with remote editor.
- Systemd and Docker supervisors.
- Reverse proxy configs (Nginx/Caddy) and Certbot integrations.
